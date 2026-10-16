/* ============================================================
   АРХИВ РАЗНОСОВ → СПИСОК ОЦЕНОК
   ------------------------------------------------------------
   Повторяет build() из js/app.js сайта статистики: те же правила,
   кто считается участником трека, когда «X & Y» — двое, а когда
   название группы, какие строки — ещё не разнос. Сам app.js в
   песочницу не загрузить (он рисует страницу), поэтому здесь его
   короткий пересказ на функциях из js/parse.js. Если на сайте
   поменяется правило в build() — поменять и тут, иначе число
   разносов у артиста в прогнозе разойдётся с его карточкой на сайте.
   ============================================================ */

export function archiveRows(sh, csvText) {
  const raw = sh.Papa.parse(csvText, { header: true, skipEmptyLines: false }).data;
  const parsed = raw.map(r => ({ r, w: sh.parseWhat(r['Что']) }));

  // кто хоть раз выступал один — по этому решается, делить ли «X & Y»
  const soloKeys = new Set();
  parsed.forEach(p => { if (p.w.artist && sh.isSolo(p.w.artist)) soloKeys.add(sh.nameKey(p.w.artist)); });

  const allParts = [];
  parsed.forEach(p => { if (p.w.artist) allParts.push(...sh.participants(p.w.artist, soloKeys)); });
  const partNames = sh.canonMap(allParts, sh.nameKey);
  const partCounts = new Map();
  allParts.forEach(v => { const k = sh.nameKey(v); partCounts.set(k, (partCounts.get(k) || 0) + 1); });
  // «Sawano Hiroyuki» и «Hiroyuki Sawano» — сайт склеивает такие пары
  const alias = sh.buildNameAliases(partCounts);
  const canon = k => alias.get(k) || k;

  const rows = [];
  let stream = null;
  parsed.forEach(({ r, w }, i) => {
    const st = sh.parseStream(r['Что'], r['Где']);
    if (st) { stream = st; return; }
    const rate = sh.parseRate(r['Оценка']);
    if (!rate) return;
    // оценка есть, а названия ещё нет: в свежем эфире оценку ставят
    // раньше, чем вписывают трек. Это ещё не разнос.
    if (!String(r['Что'] || '').trim()) return;
    const link = sh.parseLink(r['Где']);
    const parts = w.artist
      ? [...new Set(sh.participants(w.artist, soloKeys).map(x => canon(sh.nameKey(x))))]
      : [];
    rows.push({
      i,
      artist: w.artist,
      title: w.title,
      score: rate.score,
      label: rate.label,
      parts,
      genres: [...sh.splitGenres(r['Жанр'])],
      spId: link ? sh.spotifyId(link.url) : '',
      streamNum: stream ? stream.num : null,
      date: stream && stream.date ? stream.date.toISOString().slice(0, 10) : null,
      vod: stream ? stream.vod : ''
    });
  });

  // как показывать участника: самое частое написание в архиве
  const display = k => partNames.get(k) || k;
  return { rows, display };
}
