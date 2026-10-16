import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import { makeApp } from '../server/app.mjs';
import { playlistId } from '../lib/spotify.mjs';

const ID = '3UiLmCyhLOYPEnrjaIpZVC';
const CLOSED = '2ZEScQkKcGtP3JxMYfkp7A';

/* Сервер с подставным Spotify. Часы тоже подставные — чтобы проверить
   кеш и ограничение, не дожидаясь настоящих десяти минут. */
async function start(opts = {}) {
  const calls = [];
  let clock = 1_000_000;
  const app = makeApp({
    playlistId,
    now: () => clock,
    status: async () => ({ token: 'есть' }),
    fetchPlaylist: async id => {
      calls.push(id);
      if (id === CLOSED) throw new Error('Плейлист не найден или закрыт. Сделай его публичным.');
      if (opts.fail) throw new Error('Spotify fetchPlaylistContents: HTTP 500');
      const tracks = Array.from({ length: opts.n || 3 }, (_, i) => ({
        id: 't' + i, title: 'Song ' + i, artists: [{ id: 'a', name: 'Reol' }], ms: 200_000, album: 'X'
      }));
      return { name: 'Ну типа да', total: tracks.length, tracks };
    },
    ...opts.app
  });
  // как в server/index.mjs: упавший обработчик — это 500, а не тишина
  const srv = http.createServer((q, s) => app(q, s).catch(() => { s.writeHead(500); s.end('null'); }));
  await new Promise(r => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const get = (path, headers = {}) => new Promise((resolve, reject) => {
    http.get(base + path, { headers }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        let buf = Buffer.concat(chunks);
        if (res.headers['content-encoding'] === 'gzip') buf = zlib.gunzipSync(buf);
        resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(buf.toString() || 'null') });
      });
    }).on('error', reject).setTimeout(5000, function () { this.destroy(new Error('сервер не ответил')); });
  });
  return { get, calls, tick: ms => { clock += ms; }, close: () => srv.close() };
}

test('плейлист по ссылке: треки без альбома, с разрешением для браузера', async t => {
  const s = await start(); t.after(s.close);
  const r = await s.get('/playlist?url=' + encodeURIComponent(`https://open.spotify.com/playlist/${ID}?si=abc`));
  assert.equal(r.status, 200);
  assert.equal(r.body.name, 'Ну типа да');
  assert.equal(r.body.tracks.length, 3);
  assert.deepEqual(Object.keys(r.body.tracks[0]).sort(), ['artists', 'id', 'ms', 'title']);
  assert.equal(r.headers['access-control-allow-origin'], '*');
});

test('не ссылка на плейлист — понятная ошибка, Spotify не трогаем', async t => {
  const s = await start(); t.after(s.close);
  const r = await s.get('/playlist?url=https://open.spotify.com/album/' + ID);
  assert.equal(r.status, 400);
  assert.match(r.body.error, /не похоже/);
  assert.equal(s.calls.length, 0);
});

test('закрытый плейлист — 404 с подсказкой, и ошибка не кешируется', async t => {
  const s = await start(); t.after(s.close);
  const r = await s.get('/playlist?id=' + CLOSED);
  assert.equal(r.status, 404);
  assert.match(r.body.error, /публичным/);
  await s.get('/playlist?id=' + CLOSED);
  assert.equal(s.calls.length, 2, 'вдруг его уже открыли — спрашиваем снова');
});

test('сбой Spotify — 502, без подробностей внутренней кухни', async t => {
  const s = await start({ fail: true }); t.after(s.close);
  const r = await s.get('/playlist?id=' + ID);
  assert.equal(r.status, 502);
  assert.doesNotMatch(r.body.error, /HTTP 500|fetchPlaylistContents/);
});

test('кеш: пять минут отдаём сохранённое, потом спрашиваем Spotify заново', async t => {
  const s = await start(); t.after(s.close);
  assert.equal((await s.get('/playlist?id=' + ID)).headers['x-cache'], 'miss');
  s.tick(4 * 60_000);
  assert.equal((await s.get('/playlist?id=' + ID)).headers['x-cache'], 'hit');
  s.tick(2 * 60_000);
  assert.equal((await s.get('/playlist?id=' + ID)).headers['x-cache'], 'miss');
  assert.equal(s.calls.length, 2);
});

test('одновременные запросы одного плейлиста — один поход в Spotify', async t => {
  const s = await start(); t.after(s.close);
  await Promise.all([1, 2, 3].map(() => s.get('/playlist?id=' + ID)));
  assert.equal(s.calls.length, 1);
});

test('ограничение: 20 новых плейлистов за 10 минут с одного адреса', async t => {
  const s = await start(); t.after(s.close);
  const ids = Array.from({ length: 21 }, (_, i) => ID.slice(0, -2) + String(i).padStart(2, '0'));
  for (const id of ids.slice(0, 20)) assert.equal((await s.get('/playlist?id=' + id)).status, 200);
  const r = await s.get('/playlist?id=' + ids[20]);
  assert.equal(r.status, 429);
  // уже загруженный плейлист из кеша отдаём и сверх лимита
  assert.equal((await s.get('/playlist?id=' + ids[0])).status, 200);
  s.tick(10 * 60_000 + 1);
  assert.equal((await s.get('/playlist?id=' + ids[20])).status, 200);
});

test('большой ответ сжимается, если браузер это умеет', async t => {
  const s = await start({ n: 2000 }); t.after(s.close);
  const r = await s.get('/playlist?id=' + ID, { 'accept-encoding': 'gzip, br' });
  assert.equal(r.headers['content-encoding'], 'gzip');
  assert.equal(r.body.tracks.length, 2000);
});

test('/health не ходит в Spotify', async t => {
  const s = await start({ app: { status: async () => { throw new Error('нельзя'); } } }); t.after(s.close);
  assert.deepEqual((await s.get('/health')).body, { ok: true });
  assert.equal((await s.get('/status')).status, 502);
});

/* ---------- /genres ---------- */
const A1 = 'A'.repeat(22), A2 = 'B'.repeat(22), A3 = 'C'.repeat(22);
function genreServer(impl) {
  const calls = [];
  const genresFor = async ids => { calls.push([...ids]); return impl(ids); };
  return { calls, genresFor };
}

test('/genres: жанры по ID, и второй раз в MusicBrainz не ходим', async t => {
  const g = genreServer(ids => Object.fromEntries(ids.map(id => [id, id === A1 ? ['j-pop'] : []])));
  const s = await start({ app: { genresFor: g.genresFor } }); t.after(s.close);
  const r = await s.get(`/genres?ids=${A1},${A2}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.genres, { [A1]: ['j-pop'], [A2]: [] });
  await s.get(`/genres?ids=${A1},${A2}`);
  assert.equal(g.calls.length, 1, 'и «не нашлось» тоже запомнили');
  await s.get(`/genres?ids=${A1},${A3}`);
  assert.deepEqual(g.calls[1], [A3], 'спрашиваем только новых');
});

test('/genres: одновременные запросы тех же артистов — один поход', async t => {
  const g = genreServer(async ids => { await new Promise(r => setTimeout(r, 50)); return Object.fromEntries(ids.map(id => [id, ['pop']])); });
  const s = await start({ app: { genresFor: g.genresFor } }); t.after(s.close);
  const rs = await Promise.all([1, 2, 3].map(() => s.get(`/genres?ids=${A1}`)));
  assert.ok(rs.every(r => r.body.genres[A1][0] === 'pop'));
  assert.equal(g.calls.length, 1);
});

test('/genres: мусор и слишком длинный список отклоняются без похода', async t => {
  const g = genreServer(() => ({}));
  const s = await start({ app: { genresFor: g.genresFor } }); t.after(s.close);
  assert.equal((await s.get('/genres?ids=<script>,x')).status, 400);
  const many = Array.from({ length: 301 }, (_, i) => String(i).padStart(22, 'z')).join(',');
  assert.equal((await s.get('/genres?ids=' + many)).status, 400);
  assert.equal(g.calls.length, 0);
});

test('/genres: сбой MusicBrainz — 502, и он не запоминается', async t => {
  let fail = true;
  const g = genreServer(ids => { if (fail) throw new Error('503'); return Object.fromEntries(ids.map(id => [id, ['rock']])); });
  const s = await start({ app: { genresFor: g.genresFor } }); t.after(s.close);
  assert.equal((await s.get(`/genres?ids=${A1}`)).status, 502);
  fail = false;
  assert.deepEqual((await s.get(`/genres?ids=${A1}`)).body.genres[A1], ['rock']);
});

test('/genres: через две недели спрашиваем заново', async t => {
  const g = genreServer(ids => Object.fromEntries(ids.map(id => [id, []])));
  const s = await start({ app: { genresFor: g.genresFor } }); t.after(s.close);
  await s.get(`/genres?ids=${A1}`);
  s.tick(13 * 24 * 3600_000);
  await s.get(`/genres?ids=${A1}`);
  assert.equal(g.calls.length, 1);
  s.tick(2 * 24 * 3600_000);
  await s.get(`/genres?ids=${A1}`);
  assert.equal(g.calls.length, 2);
});
