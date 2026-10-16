/* ============================================================
   ДВА СПИСКА: «УЖЕ РАЗНЕСЛИ» И «ЕЩЁ НЕ РАЗНЕСЛИ»
   ------------------------------------------------------------
   Работает и в Node, и в браузере: на вход — модель (data/model.json)
   и треки из Spotify, ничего не качает сама.
   ============================================================ */
import { nameNorm, nameSorted, titleNorm, titleKeys } from './names.mjs';

export const MIN_MS = 2 * 60_000;     // короче — не берём
export const LONG_MS = 6 * 60_000;    // длиннее — за разнос доплата

/* Не та версия песни, которую понесут на разнос: минусовки, караоке,
   фортепианные переложения. Слово «piano» само по себе не годится —
   «Piano Man» обычная песня, — поэтому ловим только «piano ver.»,
   «piano arrangement», «(Piano)» и подобное. */
const VERSION_RE = new RegExp([
  String.raw`\b(instrumental|off[\s-]?vocal|karaoke|backing\s+track|minus\s+one)\b`,
  // «(Inst.)», «-inst-», «~Inst~»; но не «Instinct»: после inst
  // обязательно закрывающий знак или конец строки
  String.raw`[(\[\-–~]\s*inst\.?\s*(?:[)\]\-–~]|$)`,
  String.raw`\bpiano\s*(ver(sion|\.)?|arr(angement|\.|anged)?|cover|solo|edition)\b`,
  String.raw`[(\[]\s*piano\s*[)\]]`,
  String.raw`\s[-–]\s*piano\s*$`,
  'インスト', 'カラオケ', 'オフボーカル', String.raw`ピアノ\s*(ver|バージョン|アレンジ)`
].join('|'), 'i');

export function isAltVersion(title) {
  return VERSION_RE.test(String(title || ''));
}

/* Индексы по модели — строятся один раз на загрузку */
export function indexModel(model) {
  const byNorm = new Map(), bySort = new Map();
  // при совпадении ключей побеждает артист с большим числом разносов
  const put = (map, k, key) => {
    const cur = map.get(k);
    if (!cur || model.artists[cur].n < model.artists[key].n) map.set(k, key);
  };
  for (const [key, a] of Object.entries(model.artists)) {
    put(byNorm, nameNorm(a.name), key);
    put(bySort, nameSorted(a.name), key);
  }
  const bySp = new Map(), byTitle = new Map();
  model.tracks.forEach((t, i) => {
    if (t.sp) (bySp.get(t.sp) || bySp.set(t.sp, []).get(t.sp)).push(i);
    for (const k of [t.t, t.t2]) if (k) (byTitle.get(k) || byTitle.set(k, []).get(k)).push(i);
  });
  const scale = model.scale.map(s => ({ ...s }));
  return { model, byNorm, bySort, bySp, byTitle, scale };
}

/* Артист Spotify → ключ артиста в архиве (или null) */
export function resolveArtist(ix, a) {
  return ix.model.spArtists[a.id]
      || ix.byNorm.get(nameNorm(a.name))
      || ix.bySort.get(nameSorted(a.name))
      || null;
}

/* Ближайшая ступень шкалы к числу */
export function scoreLabel(ix, score) {
  let best = ix.scale[0];
  for (const s of ix.scale) if (Math.abs(s.score - score) < Math.abs(best.score - score)) best = s;
  return best.label;
}

/* Приор: среднее новичков, а если известен жанр — новичков этого жанра.
   genres — жанры таблицы (известны только у треков архива, нужны для
   проверки по истории); mbGenres — жанры MusicBrainz, их приложение
   получает для незнакомых артистов. Жанр, у которого в архиве нет ни
   одного новичка, ничего не говорит и пропускается. */
function prior(ix, genres = [], mbGenres = []) {
  const m = ix.model;
  const pick = (table, list) => {
    let n = 0, sum = 0;
    const used = [];
    for (const g of list) {
      const s = table?.[g];
      if (s) { n += s.n; sum += s.n * s.mean; used.push(g); }
    }
    return { n, sum, used };
  };
  let p = pick(m.genres, genres);
  if (!p.n) p = pick(m.mb, mbGenres);
  if (!p.n) return { score: m.newMean, genres: [] };
  return { score: (p.sum + m.kg * m.newMean) / (p.n + m.kg), genres: p.used };
}

export function predictTrack(ix, track) {
  const m = ix.model;
  const keys = [...new Set(track.artists.map(a => resolveArtist(ix, a)).filter(Boolean))];
  const basis = keys.map(k => {
    const a = m.artists[k];
    return { key: k, name: a.name, n: a.n, mean: a.sum / a.n, label: scoreLabel(ix, a.sum / a.n) };
  });
  const pr = prior(ix, track.genres, track.mbGenres);
  const n = basis.reduce((s, b) => s + b.n, 0);
  const sum = basis.reduce((s, b) => s + b.mean * b.n, 0);
  const score = (sum + m.k * pr.score) / (n + m.k);
  return {
    score: +score.toFixed(2),
    label: scoreLabel(ix, score),
    basis,
    prior: { score: +pr.score.toFixed(2), label: scoreLabel(ix, pr.score), genres: pr.genres },
    why: explain(basis, pr, ix)
  };
}

const plural = (n, one, few, many) => {
  const a = n % 10, b = n % 100;
  if (a === 1 && b !== 11) return one;
  if (a >= 2 && a <= 4 && (b < 12 || b > 14)) return few;
  return many;
};

function explain(basis, pr, ix) {
  if (basis.length) {
    return basis.map(b =>
      `${b.name}: ${b.n} ${plural(b.n, 'разнос', 'разноса', 'разносов')}, в среднем ${b.label}`
    ).join('; ');
  }
  const g = pr.genres.length ? ` в жанре «${pr.genres.join(', ')}»` : '';
  return `артиста в архиве нет — так в среднем оценивают новичков${g}: ${scoreLabel(ix, pr.score)}`;
}

/* Разносы этого трека в архиве: сначала по ссылке Spotify, потом по
   названию — но только если совпал и кто-то из артистов. Одного
   названия мало: «Lemon», «Gurenge», «Unravel» есть у многих. */
export function findRated(ix, track, artistKeys) {
  const hit = new Set(ix.bySp.get(track.id) || []);
  const keys = new Set(artistKeys);
  for (const tk of titleKeys(track.title)) {
    for (const i of ix.byTitle.get(tk) || []) {
      if (ix.model.tracks[i].a.some(p => keys.has(p))) hit.add(i);
    }
  }
  return [...hit].map(i => ix.model.tracks[i])
    .sort((a, b) => (b.s ?? -1) - (a.s ?? -1));
}

/* Главное: треки пользователя → два списка.
   Порядок важен: сначала «уже разнесли» (там фильтры не нужны — раз
   разнесли, значит, принесли и такую версию), потом фильтры, потом
   дубли, и только оставшееся получает прогноз. */
export function splitLibrary(ix, tracks) {
  const rated = [], todo = [];
  const dropped = { short: 0, version: 0, dup: 0, noArtist: 0 };
  const seen = new Set();
  const seenRated = new Set();

  for (const t of tracks) {
    if (!t || !t.title) continue;
    const keys = t.artists.map(a => resolveArtist(ix, a)).filter(Boolean);
    // ключ дубля: первый артист и название. Ремастер, сингл и альбомная
    // версия одной песни — один трек для разноса.
    const who = keys[0] || nameNorm(t.artists[0]?.name || '');
    const dupKey = who + '|' + titleNorm(t.title);

    const hits = findRated(ix, t, keys);
    if (hits.length) {
      if (!seenRated.has(dupKey)) { seenRated.add(dupKey); rated.push({ track: t, ratings: hits }); }
      continue;
    }
    if (!t.artists.length) { dropped.noArtist++; continue; }
    if (t.ms != null && t.ms < MIN_MS) { dropped.short++; continue; }
    if (isAltVersion(t.title)) { dropped.version++; continue; }
    if (seen.has(dupKey)) { dropped.dup++; continue; }
    seen.add(dupKey);

    todo.push({ track: t, long: t.ms != null && t.ms > LONG_MS, ...predictTrack(ix, t) });
  }

  // при равном прогнозе выше тот, по чьему артисту больше разносов:
  // ему больше веры
  todo.sort((a, b) => b.score - a.score ||
    b.basis.reduce((s, x) => s + x.n, 0) - a.basis.reduce((s, x) => s + x.n, 0));
  rated.sort((a, b) => (b.ratings[0].s ?? -1) - (a.ratings[0].s ?? -1));
  return { rated, todo, dropped };
}
