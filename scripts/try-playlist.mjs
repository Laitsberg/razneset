/* Прогон плейлиста через прогноз — посмотреть глазами до того, как
   появится приложение.

     node scripts/try-playlist.mjs https://open.spotify.com/playlist/…  [сколько показать]

   Нужен собранный data/model.json (npm run model). */
import fs from 'node:fs';
import { fetchPlaylist, playlistId } from '../lib/spotify.mjs';
import { indexModel, splitLibrary } from '../lib/predict.mjs';

const id = playlistId(process.argv[2]);
const top = +(process.argv[3] || 25);
if (!id) { console.error('Дай ссылку на плейлист Spotify'); process.exit(1); }

const ix = indexModel(JSON.parse(fs.readFileSync('data/model.json', 'utf8')));
const pl = await fetchPlaylist(id, {
  onProgress: (n, total) => process.stderr.write(`\r  загружено ${n}/${total}`)
});
process.stderr.write('\n');

const { rated, todo, dropped } = splitLibrary(ix, pl.tracks);
const mmss = ms => ms == null ? '?' : `${Math.floor(ms / 60000)}:${String(Math.round(ms / 1000) % 60).padStart(2, '0')}`;
const who = t => t.artists.map(a => a.name).join(', ');

console.log(`«${pl.name}»: ${pl.tracks.length} треков`);
console.log(`  уже разнесли: ${rated.length}`);
console.log(`  ещё не разнесли: ${todo.length} (из них длиннее 6:00 — ${todo.filter(x => x.long).length})`);
console.log(`  отброшено: короче 2:00 — ${dropped.short}, минусовки/караоке/фортепиано — ${dropped.version}, ` +
            `дубли — ${dropped.dup}`);

console.log(`\n=== Уже разнесли (последние ${Math.min(top, rated.length)}) ===`);
for (const { track, ratings } of rated.slice(0, top)) {
  const r = ratings[0];
  const more = ratings.length > 1 ? ` (+ ещё ${ratings.length - 1})` : '';
  console.log(`  ${r.l.padEnd(16)} ${who(track)} — ${track.title}  ·  стрим №${r.s ?? '?'} ${r.d ?? ''}${more}`);
}

const show = list => list.forEach(x => console.log(
  `  ${x.label.padEnd(16)} ${x.score.toFixed(2)}  ${x.long ? '[>6:00] ' : ''}${who(x.track)} — ${x.track.title} ` +
  `[${mmss(x.track.ms)}]\n${' '.repeat(20)}↳ ${x.why}`));
console.log(`\n=== Ещё не разнесли: лучшие ${top} по прогнозу ===`);
show(todo.slice(0, top));
console.log(`\n=== …и худшие 10 ===`);
show(todo.slice(-10));
