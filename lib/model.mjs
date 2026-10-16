/* ============================================================
   МОДЕЛЬ ПРОГНОЗА
   ------------------------------------------------------------
   Прогноз — средняя оценка артиста, подтянутая к «приору»:
       прогноз = (сумма оценок артиста + K × приор) / (число оценок + K)
   У артиста с одним разносом прогноз — середина между его оценкой
   и приором, с двадцатью — почти его собственное среднее.

   K = 1 подобран проверкой по истории (scripts/backtest.mjs): идём
   по эфирам по порядку и прогнозируем каждый трек только по тому,
   что разнесли раньше. На эфирах 137–216 и 217–297 лучшим вышло
   одно и то же K = 1; при K = 3–8 прогноз хуже на обоих отрезках.
   Такое слабое сжатие значит, что оценки одного артиста у
   композитора очень похожи: даже одна прошлая оценка много значит.

   Приор — НЕ общее среднее, а среднее по НОВИЧКАМ: трекам, чей
   артист появился в архиве впервые. Ровно в таком положении и
   окажется трек незнакомого артиста. Новички получают чуть меньше
   (6,60 против 6,70 на 16.10.2026).

   Если известен жанр трека, приор — среднее новичков этого жанра
   (сжатое к общему приору с весом KG). Разброс тут большой:
   у новичков-классиков 8,7, у хип-хопа и метала около 6,0.
   ============================================================ */
import { nameNorm, nameSorted, titleKeys } from './names.mjs';

export const K = 1;
export const KG = 10;
export const MODEL_VERSION = 1;

/* Связка «артист Spotify → артист архива» по трекам архива, у которых
   в «Где» стоит ссылка на Spotify. Для каждого такого трека знаем,
   какие артисты Spotify за ним стоят, и сопоставляем их участникам
   по имени.

   Если и там и там ровно один артист, а имена не сошлись, это чаще
   всего одно лицо в разной записи: «祖堅 正慶» — Masayoshi Soken,
   «Korol i Shut» — «Король и Шут». У кого нет английского написания,
   тому Spotify отдаёт имя иероглифами, и без этой связки такого
   артиста не узнать. Но бывает и издатель вместо композитора:
   «Paradox Interactive» стоял артистом у трека Johan Lindgren.
   Поэтому берём только когда имена записаны разными алфавитами или
   одно содержит другое («Rhapsody» / «Rhapsody of Fire»).
   Голосуем: один ID может встретиться в нескольких строках архива. */
const NON_LATIN = /[^\p{Script=Latin}\p{N}\p{P}\p{S}\s]/u;
function sameOneArtist(spName, arName) {
  if (NON_LATIN.test(spName) !== NON_LATIN.test(arName)) return true;
  const a = nameNorm(spName), b = nameNorm(arName);
  return a.length > 2 && b.length > 2 && (a.includes(b) || b.includes(a));
}

export function bridgeArtists(rows, display, spTracks) {
  const votes = new Map();     // spotifyArtistId → Map(partKey → голоса)
  const vote = (id, key) => {
    if (!id || !key) return;
    if (!votes.has(id)) votes.set(id, new Map());
    const m = votes.get(id);
    m.set(key, (m.get(key) || 0) + 1);
  };
  for (const r of rows) {
    const t = r.spId && spTracks[r.spId];
    if (!t || !r.parts.length) continue;
    const byNorm = new Map(r.parts.map(p => [nameNorm(display(p)), p]));
    const bySort = new Map(r.parts.map(p => [nameSorted(display(p)), p]));
    let matched = 0;
    for (const a of t.artists) {
      const p = byNorm.get(nameNorm(a.name)) || bySort.get(nameSorted(a.name));
      if (p) { vote(a.id, p); matched++; }
    }
    if (!matched && t.artists.length === 1 && r.parts.length === 1 &&
        sameOneArtist(t.artists[0].name, display(r.parts[0]))) vote(t.artists[0].id, r.parts[0]);
  }
  const out = {};
  votes.forEach((m, id) => {
    out[id] = [...m].sort((a, b) => b[1] - a[1])[0][0];
  });
  return out;
}

/* mbOf(ключ участника) → жанры MusicBrainz (lib/mbgenres.mjs). Без него
   таблицы жанров MusicBrainz в модели просто не будет. */
export function buildModel({ rows, display, scale, spTracks = {}, archiveDate = null, mbOf = null }) {
  // хронология: архив идёт от новых к старым, а «новичок» — это
  // первое появление по времени, поэтому разворачиваем
  const chrono = rows.filter(r => r.streamNum != null)
    .sort((a, b) => a.streamNum - b.streamNum || b.i - a.i);

  const seen = new Set();
  let newSum = 0, newN = 0, allSum = 0;
  const genres = new Map(), mb = new Map();
  const add = (map, g, score) => {
    const a = map.get(g) || { n: 0, sum: 0 };
    a.n++; a.sum += score; map.set(g, a);
  };
  for (const r of chrono) {
    allSum += r.score;
    if (r.parts.length && !r.parts.some(p => seen.has(p))) {
      newSum += r.score; newN++;
      for (const g of r.genres) add(genres, g, r.score);
      // жанры всех участников трека, без повторов
      if (mbOf) for (const g of new Set(r.parts.flatMap(mbOf))) add(mb, g, r.score);
    }
    r.parts.forEach(p => seen.add(p));
  }

  const artists = {};
  for (const r of rows) {
    for (const p of r.parts) {
      const a = artists[p] || (artists[p] = { name: display(p), n: 0, sum: 0 });
      a.n++; a.sum += r.score;
    }
  }
  for (const a of Object.values(artists)) a.sum = +a.sum.toFixed(2);

  const round = x => +x.toFixed(3);
  return {
    version: MODEL_VERSION,
    // Времени сборки здесь нет нарочно: модель пересобирается каждые
    // три часа, и с меткой времени файл менялся бы при каждом прогоне —
    // воркфлоу коммитил бы пустые обновления. Свежесть видна по дате
    // последнего эфира в архиве.
    archiveDate,
    k: K, kg: KG,
    rated: rows.length,
    globalMean: round(allSum / chrono.length),
    newMean: round(newSum / newN),
    newN,
    scale,
    genres: Object.fromEntries([...genres].map(([g, a]) => [g, { n: a.n, mean: round(a.sum / a.n) }])),
    // то же по жанрам MusicBrainz: как оценивают новичков каждого жанра
    mb: Object.fromEntries([...mb].map(([g, a]) => [g, { n: a.n, mean: round(a.sum / a.n) }])),
    artists,
    spArtists: bridgeArtists(rows, display, spTracks),
    // для списка «уже разнесли»: компактно, это качает телефон
    tracks: rows.map(r => {
      const [t, t2] = titleKeys(r.title);
      return {
        a: r.parts, t, t2, sp: r.spId || undefined,
        n: (r.artist ? r.artist + ' — ' : '') + r.title,
        l: r.label, d: r.date || undefined, s: r.streamNum ?? undefined
      };
    })
  };
}
