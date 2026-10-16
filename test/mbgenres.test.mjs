/* Разбор ответов MusicBrainz — на подставных ответах, без сети.
   Формы ответов сняты с настоящего MusicBrainz 16.10.2026. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { genresForSpotify, genresForMbids, topGenres, _setGenreList, _setBackoff, mbFetch } from '../lib/mbgenres.mjs';

const GENRE_LIST = ['j-pop', 'pop', 'alternative rock', 'indie rock', 'pop rock', 'new wave', 'rock'];
// свой список вместо data/mb-genre-list.json: проверка не должна зависеть
// от того, что сегодня в MusicBrainz
_setGenreList(GENRE_LIST);

/* Подставной MusicBrainz. log — какие адреса спрашивали и когда. */
function fakeMb({ urls = {}, artists = {} } = {}) {
  const log = [];
  const fetchImpl = async url => {
    const u = new URL(url);
    log.push({ path: u.pathname, at: Date.now() });
    const ok = body => new Response(JSON.stringify(body), { status: 200 });
    if (u.pathname.endsWith('/genre/all')) {
      const off = +u.searchParams.get('offset');
      return ok({ 'genre-count': GENRE_LIST.length, genres: GENRE_LIST.slice(off, off + 100).map(name => ({ name })) });
    }
    if (u.pathname.endsWith('/url')) {
      const res = u.searchParams.getAll('resource');
      const found = res.filter(r => urls[r.split('/').pop()]).map(r => ({
        resource: r, relations: [{ 'target-type': 'artist', artist: { id: urls[r.split('/').pop()] } }]
      }));
      // настоящий MusicBrainz: одна ссылка — без обёртки, не нашлась — 404
      if (res.length === 1) return found.length ? ok(found[0]) : new Response('{}', { status: 404 });
      return ok({ urls: found });
    }
    if (u.pathname.endsWith('/artist')) {
      const ids = [...u.searchParams.get('query').matchAll(/arid:([\w-]+)/g)].map(m => m[1]);
      // поиск может подмешать постороннего — проверяем, что его не берём
      return ok({ artists: [...ids.filter(id => artists[id]).map(id => ({ id, tags: artists[id] })),
                            { id: 'stranger', tags: [{ name: 'pop', count: 99 }] }] });
    }
    throw new Error('неожиданный адрес ' + url);
  };
  return { fetchImpl, log };
}

const SP = { ado: 'A'.repeat(22), killers: 'K'.repeat(22), nobody: 'N'.repeat(22) };

test('жанры по ID Spotify: только официальные жанры, по убыванию голосов, не больше трёх', async () => {
  const mb = fakeMb({
    urls: { [SP.ado]: 'mb-ado', [SP.killers]: 'mb-killers' },
    artists: {
      'mb-ado': [{ name: 'utaite', count: 3 }, { name: 'j-pop', count: 2 }, { name: 'vocalist', count: 5 },
                 { name: 'alternative rock', count: 1 }, { name: '2020s', count: 4 }],
      'mb-killers': [{ name: 'new wave', count: 5 }, { name: 'alternative rock', count: 19 },
                     { name: 'indie rock', count: 9 }, { name: 'pop rock', count: 6 }, { name: 'rock', count: 0 }]
    }
  });
  const g = await genresForSpotify([SP.ado, SP.killers, SP.nobody], mb.fetchImpl);
  assert.deepEqual(g[SP.ado], ['j-pop', 'alternative rock'], 'теги «utaite», «vocalist», «2020s» — не жанры');
  assert.deepEqual(g[SP.killers], ['alternative rock', 'indie rock', 'pop rock']);
  assert.deepEqual(g[SP.nobody], [], 'кого MusicBrainz не знает — пустой список, а не дыра');
  assert.equal(Object.keys(g).length, 3, 'посторонний из поиска в ответ не попал');
});

test('одна ссылка, которой нет в MusicBrainz (404), — не сбой', async () => {
  const mb = fakeMb();
  assert.deepEqual(await genresForSpotify([SP.nobody], mb.fetchImpl), { [SP.nobody]: [] });
});

test('пачками: 250 артистов — 3 запроса ссылок, а не 250', async () => {
  const ids = Array.from({ length: 250 }, (_, i) => String(i).padStart(22, 'x'));
  const mb = fakeMb();
  await genresForSpotify(ids, mb.fetchImpl);
  assert.equal(mb.log.filter(x => x.path.endsWith('/url')).length, 3);
});

test('не чаще раза в секунду, даже когда спрашивают двое разом', async () => {
  const mb = fakeMb({ artists: { a: [{ name: 'pop', count: 1 }], b: [{ name: 'rock', count: 1 }] } });
  await Promise.all([genresForMbids(['a'], mb.fetchImpl), genresForMbids(['b'], mb.fetchImpl)]);
  const times = mb.log.map(x => x.at);
  for (let i = 1; i < times.length; i++) {
    assert.ok(times[i] - times[i - 1] >= 1050, `между запросами ${times[i] - times[i - 1]} мс`);
  }
});

test('topGenres: первые три по списку', () => {
  assert.deepEqual(topGenres([['a', 9], ['b', 5], ['c', 3], ['d', 1]]), ['a', 'b', 'c']);
  assert.deepEqual(topGenres(undefined), []);
});

test('посторонний из выдачи поиска не попадает в файл жанров архива', async () => {
  const mb = fakeMb({ artists: { a: [{ name: 'pop', count: 1 }] } });
  assert.deepEqual(await genresForMbids(['a', 'missing'], mb.fetchImpl), { a: [['pop', 1]], missing: [] });
});

test('перегрузка MusicBrainz: 503 пережидаем, а не сдаёмся с третьей попытки', async () => {
  _setBackoff(10);
  let n = 0;
  const fetchImpl = async () => (++n <= 4)
    ? new Response('', { status: 503, headers: { 'retry-after': '0' } })
    : new Response(JSON.stringify({ ok: 1 }), { status: 200 });
  assert.deepEqual(await mbFetch('/x', fetchImpl), { ok: 1 });
  assert.equal(n, 5);
  _setBackoff(1000);
});
