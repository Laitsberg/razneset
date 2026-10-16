/* Жанры артистов архива из MusicBrainz → data/mb-genres.json

     node scripts/mb-genres.mjs

   Самих артистов в MusicBrainz искать не нужно: сайт статистики уже
   нашёл их, когда собирал страны (data/countries.json, ключ — тот же
   ключ участника, что в архиве, с уверенностью совпадения ≥ 90).
   Отсюда только дотягиваем жанры по готовому ID — пачками по 50
   (lib/mbgenres.mjs). Сначала спрашивали по одному: MusicBrainz
   разрешает раз в секунду, и четыре тысячи артистов шли бы часами. */
import fs from 'node:fs';
import { SITE } from '../lib/shared.mjs';
import { genresForMbids } from '../lib/mbgenres.mjs';

const OUT = 'data/mb-genres.json';
const countries = await (await fetch(new URL('data/countries.json', SITE))).json();
const cache = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {};
const all = [...new Set(Object.values(countries.artists).map(a => a.mbid).filter(Boolean))];
const want = all.filter(id => !(id in cache));
console.log(`Артистов с ID MusicBrainz: ${all.length}, уже есть: ${all.length - want.length}, спрашиваю: ${want.length}`);

// по 500 за раз и сразу на диск: оборвалось — следующий запуск продолжит
for (let i = 0; i < want.length; i += 500) {
  Object.assign(cache, await genresForMbids(want.slice(i, i + 500)));
  fs.writeFileSync(OUT, JSON.stringify(cache));
  console.log(`  ${Math.min(i + 500, want.length)}/${want.length}`);
}
const withG = all.filter(id => cache[id]?.length).length;
console.log(`Готово: жанры есть у ${withG} из ${all.length}.`);
