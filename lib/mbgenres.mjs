/* ============================================================
   ЖАНРЫ ИЗ MUSICBRAINZ
   ------------------------------------------------------------
   Spotify жанры больше не отдаёт, а у незнакомого артиста прогноз без
   жанра — просто среднее новичков, одно на всех. MusicBrainz знает
   жанры примерно у трети таких артистов (проверено на плейлисте
   «Ну типа да»: 364 трека из 1080).

   Жанры там мелкие и многочисленные (2216 штук: «big beat», «utaite»,
   «electropop»). Сводить их руками к жанрам таблицы не стали: модель
   сама считает, как композитор оценивает новичков каждого жанра
   MusicBrainz, — по артистам архива, которых сайт статистики уже нашёл
   в MusicBrainz для стран (data/countries.json).
   ============================================================ */

/* Сколько жанров артиста брать. У The Killers их десяток, и хвост
   («post-punk revival», голос одного человека) скорее шум. */
export const TOP_GENRES = 3;

/* Жанры артиста по убыванию голосов → первые TOP_GENRES названий.
   На вход — то, что хранит data/mb-genres.json: [[имя, голоса], …] */
export const topGenres = list => (list || []).slice(0, TOP_GENRES).map(g => g[0]);

/* Ключ участника архива → жанры MusicBrainz.
   countries — data/countries.json сайта статистики (ключ — тот же ключ
   участника, что в lib/archive.mjs), mbCache — data/mb-genres.json. */
export function archiveMbOf(countries, mbCache) {
  return key => {
    const id = countries.artists?.[key]?.mbid;
    return id ? topGenres(mbCache[id]) : [];
  };
}

/* ---------- жанры по ID артистов Spotify (для сервера) ----------
   По одному запросу на артиста — это 700 секунд на плейлист с 700
   незнакомыми. Поэтому пачками:
   1) /ws/2/url?resource=…×100 — какие артисты MusicBrainz стоят за
      ссылками open.spotify.com/artist/… (ссылки там вписаны вручную);
   2) /ws/2/artist?query=arid:… OR … — их теги, по 50 за раз
      (genresForMbids).
   Теги — что угодно («vocalist», «2020s», «_add cat on cover»), поэтому
   оставляем только официальные жанры MusicBrainz (/ws/2/genre/all).
   У жанров голоса те же, что у одноимённых тегов, так что это ровно то,
   что даёт inc=genres у отдельного артиста — по нему считалась модель. */

const MB = 'https://musicbrainz.org/ws/2';
const UA = 'razneset/1.0 ( https://github.com/Laitsberg/razneset )';
const GAP_MS = 1100;   // MusicBrainz: не чаще раза в секунду, иначе бан

/* Одна очередь на весь процесс: два человека одновременно не должны
   превратить «раз в секунду» в «дважды в секунду». */
let last = Promise.resolve();
let lastAt = 0;
export function mbFetch(path, fetchImpl = fetch) {
  const run = last.then(async () => {
    const wait = lastAt + GAP_MS - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    for (let attempt = 0; attempt < 3; attempt++) {
      lastAt = Date.now();
      const r = await fetchImpl(MB + path, { headers: { 'user-agent': UA, accept: 'application/json' } });
      if (r.ok) return r.json();
      // одна-единственная ссылка, которой MusicBrainz не знает, — 404;
      // для поиска это не сбой, а «не нашлось»
      if (r.status === 404) return {};
      if (r.status !== 503 && r.status !== 429) throw new Error(`MusicBrainz: HTTP ${r.status}`);
      await new Promise(res => setTimeout(res, 2000 * (attempt + 1)));
    }
    throw new Error('MusicBrainz перегружен');
  });
  last = run.catch(() => {});
  return run;
}

let genreList = null;
async function allGenres(fetchImpl) {
  if (genreList) return genreList;
  const set = new Set();
  for (let off = 0; ; off += 100) {
    const j = await mbFetch(`/genre/all?limit=100&offset=${off}&fmt=json`, fetchImpl);
    j.genres.forEach(g => set.add(g.name));
    if (off + 100 >= j['genre-count']) break;
  }
  return (genreList = set);
}

/* ID артистов MusicBrainz → { id: [[жанр, голоса], …] } по убыванию
   голосов, по 50 артистов за запрос. Этим же путём собираются жанры
   артистов архива (scripts/mb-genres.mjs): модель должна учиться ровно
   на том, что потом увидит приложение. */
export async function genresForMbids(mbids, fetchImpl = fetch) {
  const genres = await allGenres(fetchImpl);
  const out = {};
  for (let i = 0; i < mbids.length; i += 50) {
    const part = mbids.slice(i, i + 50);
    const q = part.map(id => 'arid:' + id).join(' OR ');
    const j = await mbFetch(`/artist?query=${encodeURIComponent(q)}&limit=100&fmt=json`, fetchImpl);
    for (const id of part) out[id] = [];
    for (const a of j.artists || []) {
      if (!(a.id in out)) continue;   // поиск может подмешать лишнее — берём только своих
      out[a.id] = (a.tags || [])
        .filter(t => t.count > 0 && genres.has(t.name))
        .sort((x, y) => y.count - x.count)
        .map(t => [t.name, t.count]);
    }
  }
  return out;
}

/* ID артистов Spotify → { id: [жанр, жанр, жанр] }. Кого MusicBrainz не
   знает или у кого нет жанров — пустой список: это тоже ответ, его
   можно запомнить и больше не спрашивать. */
export async function genresForSpotify(ids, fetchImpl = fetch) {
  const out = Object.fromEntries(ids.map(id => [id, []]));
  const sp2mb = new Map();
  for (let i = 0; i < ids.length; i += 100) {
    const qs = ids.slice(i, i + 100)
      .map(id => 'resource=' + encodeURIComponent('https://open.spotify.com/artist/' + id)).join('&');
    const j = await mbFetch(`/url?${qs}&inc=artist-rels&fmt=json`, fetchImpl);
    // одна ссылка приходит без обёртки urls, несколько — в ней
    for (const u of j.urls || (j.resource ? [j] : [])) {
      const a = (u.relations || []).find(x => x.artist);
      if (a) sp2mb.set(u.resource.split('/').pop(), a.artist.id);
    }
  }
  const byMb = await genresForMbids([...new Set(sp2mb.values())], fetchImpl);
  for (const [sp, mb] of sp2mb) out[sp] = topGenres(byMb[mb]);
  return out;
}
