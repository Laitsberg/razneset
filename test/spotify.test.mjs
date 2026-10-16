/* lib/spotify.mjs с подставным интернетом: проверяем поведение, которое
   на живом Spotify не воспроизвести по заказу. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { playlistId } from '../lib/spotify.mjs';

test('ID плейлиста из любой формы ссылки', () => {
  const id = '3UiLmCyhLOYPEnrjaIpZVC';
  assert.equal(playlistId(`https://open.spotify.com/playlist/${id}?si=x&utm_source=copy-link`), id);
  assert.equal(playlistId(`https://open.spotify.com/intl-ru/playlist/${id}`), id);
  assert.equal(playlistId(`spotify:playlist:${id}`), id);
  assert.equal(playlistId(`  ${id} `), id);
  assert.equal(playlistId(`https://open.spotify.com/album/${id}`), '');
  assert.equal(playlistId('привет'), '');
});

test('устаревший отпечаток запроса заменяется свежим без перезапуска', async t => {
  const real = globalThis.fetch;
  t.after(() => { globalThis.fetch = real; });
  let playerVersion = 0;
  const gqlHashes = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    const reply = (status, body) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
    if (u.includes('/embed/')) {
      const nd = { props: { pageProps: { state: { settings: { session: {
        accessToken: 'TOKEN', accessTokenExpirationTimestampMs: Date.now() + 3600_000 } } } } } };
      return reply(200, `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(nd)}</script>`);
    }
    if (u === 'https://open.spotify.com/') {
      return reply(200, '<script src="https://open.spotifycdn.com/cdn/build/web-player/web-player.abc123.js">');
    }
    if (u.includes('web-player.abc123.js')) {
      // первый раз плеер ещё старый, во второй — уже обновлённый
      const h = (playerVersion++ === 0 ? 'a' : 'b').repeat(64);
      return reply(200, `x("fetchPlaylistContents","query","${h}");y("getTrack","query","${h}")`);
    }
    if (u.includes('pathfinder')) {
      const h = JSON.parse(opts.body).extensions.persistedQuery.sha256Hash;
      gqlHashes.push(h[0]);
      if (h !== 'b'.repeat(64)) return reply(412, '"Invalid query hash"');
      return reply(200, { data: { trackUnion: {
        __typename: 'Track', uri: 'spotify:track:T1', name: 'Lemon',
        firstArtist: { items: [{ uri: 'spotify:artist:A1', profile: { name: 'Kenshi Yonezu' } }] },
        otherArtists: { items: [] }, duration: { totalMilliseconds: 255000 } } } });
    }
    throw new Error('неожиданный адрес ' + u);
  };
  // модуль со свежим состоянием (токен и отпечатки хранятся внутри)
  const { fetchTrack, hashSource } = await import('../lib/spotify.mjs?fresh=' + Date.now());
  const tr = await fetchTrack('T1');
  assert.deepEqual(tr.artists, [{ id: 'A1', name: 'Kenshi Yonezu' }]);
  assert.equal(tr.ms, 255000);
  assert.deepEqual(gqlHashes, ['a', 'b'], 'сначала старый отпечаток, после 412 — свежий');
  assert.equal(hashSource(), 'player');
});
