/* ============================================================
   ОБЩИЙ КОД С САЙТОМ СТАТИСТИКИ
   ------------------------------------------------------------
   Шкала оценок, разбор «Артист — Трек», склейка имён и жанров уже
   написаны и выверены в faryma.stats (js/config.js, js/aliases.js,
   js/parse.js). Копировать их сюда нельзя: разойдутся, и прогноз
   начнёт считать оценки не так, как сайт. Поэтому грузим те же файлы
   в песочницу — так же, как это делают скрипты и бот самого сайта.

   Откуда брать:
   * FARYMA_STATS_DIR — локальная копия репозитория (быстро, без сети,
     так удобнее проверять правки сразу в обоих репозиториях);
   * иначе — опубликованный сайт farymastats.info: там ровно то, что
     сейчас в main, и архив, который воркфлоу обновил сегодня.
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

export const SITE = process.env.FARYMA_STATS_URL || 'https://farymastats.info/';

const FILES = ['vendor/papaparse.min.js', 'js/config.js', 'js/aliases.js', 'js/parse.js'];

async function readSource(rel) {
  const dir = process.env.FARYMA_STATS_DIR;
  if (dir) return fs.readFileSync(path.join(dir, rel), 'utf8');
  const r = await fetch(new URL(rel, SITE));
  if (!r.ok) throw new Error(`${rel}: HTTP ${r.status}`);
  return r.text();
}

/* Песочница с кодом сайта. URL передаём явно: без него spotifyId()
   и parseLink() молча отдают пустоту — new URL падает внутри try,
   и все ссылки на Spotify в архиве будто бы исчезают. */
export async function loadShared() {
  const ctx = vm.createContext({ console, URL });
  for (const f of FILES) vm.runInContext(await readSource(f), ctx, { filename: f });
  // const и let из песочницы не попадают на объект контекста —
  // достаём каждое имя по отдельности
  const get = name => vm.runInContext(name, ctx);
  const names = [
    'Papa', 'SCALE_ORDER', 'TIERS', 'parseRate', 'parseWhat', 'parseStream',
    'parseLink', 'spotifyId', 'nameKey', 'isSolo', 'participants',
    'buildNameAliases', 'canonMap', 'splitGenres'
  ];
  const out = {};
  for (const n of names) out[n] = get(n);
  // Массивы из песочницы несут чужой Array.prototype — разворачиваем
  out.SCALE_ORDER = [...out.SCALE_ORDER];
  return out;
}

export async function loadArchiveCsv() {
  return readSource('data.csv');
}
