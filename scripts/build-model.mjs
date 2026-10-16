/* Собирает data/model.json из архива разносов.

     node scripts/build-model.mjs

   Архив и код разбора берутся с farymastats.info (или из локальной
   копии, если задан FARYMA_STATS_DIR). Для треков архива со ссылкой на
   Spotify спрашиваем у Spotify их артистов — так узнаём, какой ID
   артиста Spotify стоит за именем в таблице. Ответы копятся в
   data/spotify-tracks.json, и назавтра спрашиваем только новые. */
import fs from 'node:fs';
import { loadShared, loadArchiveCsv } from '../lib/shared.mjs';
import { archiveRows } from '../lib/archive.mjs';
import { buildModel } from '../lib/model.mjs';
import { fetchTrack } from '../lib/spotify.mjs';
import { archiveMbOf } from '../lib/mbgenres.mjs';
import { SITE } from '../lib/shared.mjs';

const CACHE = 'data/spotify-tracks.json';
const OUT = 'data/model.json';

const sh = await loadShared();
const csv = await loadArchiveCsv();
const { rows, display } = archiveRows(sh, csv);

// Защита от пустой или чужой выгрузки: если таблица переехала или
// Google отдал страницу ошибки, лучше упасть, чем выложить модель,
// по которой у всех артистов по нулю разносов.
if (rows.length < 5000) {
  console.error(`В архиве всего ${rows.length} оценок — похоже, выгрузка сломана. Модель не пишу.`);
  process.exit(1);
}

// цвет ступени — тот же, что на сайте статистики (TIERS в js/config.js)
const scale = sh.SCALE_ORDER.map(label => {
  const r = sh.parseRate(label);
  return { label, score: r.score, c: r.color };
});

fs.mkdirSync('data', { recursive: true });
const cache = fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, 'utf8')) : {};
const want = [...new Set(rows.map(r => r.spId).filter(Boolean))].filter(id => !(id in cache));
if (want.length) {
  console.log(`Spotify: спрашиваю ${want.length} новых треков архива…`);
  let done = 0, failed = 0;
  const PAR = 6;
  for (let i = 0; i < want.length; i += PAR) {
    await Promise.all(want.slice(i, i + PAR).map(async id => {
      try {
        const t = await fetchTrack(id);
        // null — трек удалён из Spotify; запоминаем, чтобы не спрашивать снова
        cache[id] = t ? { artists: t.artists, ms: t.ms } : null;
      } catch (e) {
        failed++;
        if (failed === 1) console.warn('  ', e.message);
      }
      done++;
    }));
    if (done % 120 < PAR) console.log(`  ${done}/${want.length}`);
  }
  // Spotify может не ответить — тогда собираем модель на том, что есть
  // в кеше: связка по ID лишь уточняет сопоставление имён, без неё
  // прогноз всё равно считается
  if (failed) console.warn(`  не ответил на ${failed} запросов — повторю в следующий раз`);
  fs.writeFileSync(CACHE, JSON.stringify(cache));
}

const spTracks = Object.fromEntries(Object.entries(cache).filter(([, v]) => v));
const lastDate = rows.map(r => r.date).filter(Boolean).sort().at(-1) || null;
// Жанры MusicBrainz артистов архива: ID артистов — из data/countries.json
// сайта статистики, сами жанры — data/mb-genres.json (scripts/mb-genres.mjs).
// Нет файла — модель соберётся без таблицы жанров, прогноз останется прежним.
let mbOf = null;
if (fs.existsSync('data/mb-genres.json')) {
  const countries = await (await fetch(new URL('data/countries.json', SITE))).json();
  mbOf = archiveMbOf(countries, JSON.parse(fs.readFileSync('data/mb-genres.json', 'utf8')));
}
const model = buildModel({ rows, display, scale, spTracks, archiveDate: lastDate, mbOf });
fs.writeFileSync(OUT, JSON.stringify(model));

const kb = (fs.statSync(OUT).size / 1024).toFixed(0);
console.log(`Готово: ${OUT}, ${kb} КБ`);
console.log(`  оценок ${model.rated}, артистов ${Object.keys(model.artists).length}, ` +
            `связано с Spotify по ID ${Object.keys(model.spArtists).length}`);
console.log(`  среднее ${model.globalMean}, у новичков ${model.newMean} (их ${model.newN})`);
console.log(`  жанров MusicBrainz с новичками: ${Object.keys(model.mb).length}`);
