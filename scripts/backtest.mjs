/* Проверка прогноза по истории.

     node scripts/backtest.mjs

   Идём по эфирам по порядку. Для каждого трека из проверочного отрезка
   собираем модель ТОЛЬКО из того, что разнесли до его эфира, и
   прогнозируем тем же кодом, что работает в приложении (buildModel,
   predictTrack). Потом сравниваем с настоящей оценкой.

   Повторы одного и того же трека из проверки выкидываем: для них
   приложение покажет настоящую оценку, а не прогноз.

   Что печатается:
   * ошибка — насколько в среднем прогноз промахивается, в баллах
     (ступени шкалы идут через 2 балла, модификатор — 0,3);
   * порядок — ранговая корреляция Спирмена: насколько сортировка по
     прогнозу совпадает с сортировкой по настоящим оценкам. 0 — никак,
     1 — идеально. Для списка «от лучшего к худшему» это главное;
   * «всем среднее» — для сравнения: прогноз, который всем ставит одно
     и то же. Если модель его не обгоняет, она бесполезна. */
import { loadShared, loadArchiveCsv } from '../lib/shared.mjs';
import { archiveRows } from '../lib/archive.mjs';
import { buildModel } from '../lib/model.mjs';
import { indexModel, predictTrack } from '../lib/predict.mjs';
import { titleNorm } from '../lib/names.mjs';
import { archiveMbOf } from '../lib/mbgenres.mjs';
import { SITE } from '../lib/shared.mjs';
import fs from 'node:fs';

const sh = await loadShared();
const { rows, display } = archiveRows(sh, await loadArchiveCsv());
const scale = sh.SCALE_ORDER.map(label => ({ label, score: sh.parseRate(label).score }));

const chrono = rows.filter(r => r.streamNum != null);
const streams = [...new Set(chrono.map(r => r.streamNum))].sort((a, b) => a - b);
const last = streams.at(-1);
// два отрезка по 80 эфиров: если лучшая настройка на них одна и та же,
// это свойство архива, а не случайность одного отрезка
const WINDOWS = [[last - 160, last - 80], [last - 80, last + 1]];
const KS = (process.env.KS || '0.5,1,2,4').split(',').map(Number);
/* GENRE=1  — жанр из таблицы известен у каждого трека (потолок: так
              хорошо не будет никогда, у треков из Spotify жанра таблицы нет);
   GENRE=mb — жанры MusicBrainz, как в приложении: только у незнакомых
              артистов и только у тех, кого MusicBrainz знает. */
const useGenre = process.env.GENRE === '1';
const useMb = process.env.GENRE === 'mb';
const mbOf = useMb
  ? archiveMbOf(await (await fetch(new URL('data/countries.json', SITE))).json(),
                JSON.parse(fs.readFileSync('data/mb-genres.json', 'utf8')))
  : null;

const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
function ranks(a) {
  const idx = a.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]);
  const r = new Array(a.length);
  for (let j = 0; j < idx.length;) {
    let k = j;
    while (k + 1 < idx.length && idx[k + 1][0] === idx[j][0]) k++;
    for (let t = j; t <= k; t++) r[idx[t][1]] = (j + k) / 2;
    j = k + 1;
  }
  return r;
}
function spearman(pairs) {
  if (pairs.length < 3) return 0;
  const a = ranks(pairs.map(p => p[0])), b = ranks(pairs.map(p => p[1]));
  const ma = mean(a), mb = mean(b);
  let s = 0, sa = 0, sb = 0;
  for (let i = 0; i < a.length; i++) {
    s += (a[i] - ma) * (b[i] - mb); sa += (a[i] - ma) ** 2; sb += (b[i] - mb) ** 2;
  }
  return sa && sb ? s / Math.sqrt(sa * sb) : 0;
}
const trackKey = r => r.parts.join('+') + '|' + titleNorm(r.title);

for (const [from, to] of WINDOWS) {
  const results = new Map(KS.map(k => [k, []]));
  const flat = [];
  for (const s of streams.filter(x => x >= from && x < to)) {
    const past = rows.filter(r => r.streamNum != null && r.streamNum < s);
    const seen = new Set(past.map(trackKey));
    const model = buildModel({ rows: past, display, scale, mbOf });
    const ix = indexModel(model);
    for (const r of rows.filter(x => x.streamNum === s)) {
      if (!r.parts.length || seen.has(trackKey(r))) continue;
      // трек глазами Spotify: только имена артистов, без ID
      const track = { artists: r.parts.map(p => ({ id: '', name: display(p) })),
                      genres: useGenre ? r.genres : [] };
      for (const k of KS) {
        model.k = k;
        let p = predictTrack(ix, track);
        // жанр спрашиваем только для незнакомых — как приложение
        if (useMb && !p.basis.length) p = predictTrack(ix, { ...track, mbGenres: [...new Set(r.parts.flatMap(mbOf))] });
        results.get(k).push([p.score, r.score, p.basis.length > 0, p.prior.genres.length > 0]);
      }
      flat.push([model.globalMean, r.score]);
    }
  }
  const err = ps => mean(ps.map(p => Math.abs(p[0] - p[1]))).toFixed(2);
  const any = results.get(KS[0]);
  const known = any.filter(p => p[2]).length;
  console.log(`\nЭфиры ${from}–${to - 1}: треков ${any.length}, из них артист уже был в архиве у ${known} ` +
              `(${Math.round(100 * known / any.length)}%)` + (useGenre ? ', жанр известен' : useMb ? ', жанры MusicBrainz' : ''));
  console.log(`  всем среднее:  ошибка ${err(flat)}, порядок ${spearman(flat).toFixed(2)}`);
  for (const [k, ps] of results) {
    const kn = ps.filter(p => p[2]), nw = ps.filter(p => !p[2]);
    console.log(`  K=${String(k).padEnd(4)} ошибка ${err(ps)}, порядок ${spearman(ps).toFixed(2)}` +
                ` | знакомые артисты: ошибка ${err(kn)}, порядок ${spearman(kn).toFixed(2)}` +
                ` | новички: ошибка ${err(nw)}, порядок ${spearman(nw).toFixed(2)}`);
    if (useMb) {
      const g = nw.filter(p => p[3]);
      console.log(`         из новичков жанр нашёлся у ${g.length} из ${nw.length} (${Math.round(100 * g.length / nw.length)}%): ` +
                  `ошибка ${err(g)}, порядок ${spearman(g).toFixed(2)}`);
    }
  }
}
