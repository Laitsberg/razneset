import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildModel, bridgeArtists } from '../lib/model.mjs';
import { indexModel, predictTrack, splitLibrary, scoreLabel } from '../lib/predict.mjs';

// Кусок настоящей шкалы — в приложении она приходит из js/config.js сайта
const SCALE = [
  ['гениально', 10], ['гениально-', 9.7], ['гениально - -', 9.4],
  ['атлична++', 8.6], ['атлична+', 8.3], ['атлична', 8], ['атлична-', 7.7], ['атлична - -', 7.4],
  ['хорошечно++', 6.6], ['хорошечно+', 6.3], ['хорошечно', 6], ['хорошечно-', 5.7], ['хорошечно - -', 5.4],
  ['нормас', 4], ['ну такое', 2], ['кринж-контент', 0]
].map(([label, score]) => ({ label, score }));

let i = 0;
const row = (artist, title, score, streamNum, extra = {}) => ({
  i: i++, artist, title, score, label: '', streamNum, date: '2026-01-01',
  parts: [artist.toLowerCase()], genres: [], spId: '', ...extra
});

// Архив идёт от новых к старым, но модели это всё равно
const rows = [
  row('Reol', 'DDD', 9, 3),
  row('Reol', 'MONSTER', 9, 2),
  row('Reol', 'No title', 9, 1),
  row('Kouji Wada', 'Butter-Fly', 8, 1, { genres: ['поп-рок'] }),
  row('Masayoshi Soken', 'Answers', 10, 2, { spId: 'SP_TRACK_1' }),
  row('Some Rapper', 'Diss', 2, 1, { genres: ['хип-хоп'] }),
  row('Some Rapper', 'Diss 2', 2, 2),
  row('Jazz Guy', 'Blue', 9, 3, { genres: ['джаз'] })
];
const display = k => rows.find(r => r.parts[0] === k)?.artist || k;
const spTracks = { SP_TRACK_1: { artists: [{ id: 'SOKEN_ID', name: '祖堅 正慶' }] } };
const model = buildModel({ rows, display, scale: SCALE, spTracks });
const ix = indexModel(model);
const tr = (artists, title, ms = 200_000, id = 'x' + i++) =>
  ({ id, title, ms, artists: artists.map(a => typeof a === 'string' ? { id: '', name: a } : a) });

test('приор — среднее новичков, а не всех оценок', () => {
  // новички по хронологии: Reol(9, эфир 1), Kouji Wada(8), Some Rapper(2),
  // Soken(10, эфир 2), Jazz Guy(9, эфир 3)
  assert.equal(model.newN, 5);
  assert.equal(model.newMean, 7.6);
  assert.notEqual(model.newMean, model.globalMean);
});

test('прогноз — среднее артиста, подтянутое к приору с весом K', () => {
  const p = predictTrack(ix, tr(['Reol'], 'New Song'));
  // (9+9+9 + 1×7.6) / (3+1)
  assert.equal(p.score, 8.65);
  assert.equal(p.basis[0].n, 3);
  assert.match(p.why, /Reol: 3 разноса/);
});

test('незнакомый артист получает приор и честное объяснение', () => {
  const p = predictTrack(ix, tr(['Nobody Knows'], 'Song'));
  assert.equal(p.score, 7.6);
  assert.equal(p.basis.length, 0);
  assert.match(p.why, /артиста в архиве нет/);
});

test('известный жанр сдвигает приор новичка', () => {
  const jazz = predictTrack(ix, { ...tr(['Nobody'], 'S'), genres: ['джаз'] });
  const rap = predictTrack(ix, { ...tr(['Nobody'], 'S'), genres: ['хип-хоп'] });
  assert.ok(jazz.score > 7.6 && rap.score < 7.6, `${jazz.score} / ${rap.score}`);
});

test('имя артиста узнаётся в другой записи', () => {
  assert.equal(predictTrack(ix, tr(['Kōji Wada'], 'X')).basis[0]?.name, 'Kouji Wada');
  assert.equal(predictTrack(ix, tr(['Wada Kouji'], 'X')).basis[0]?.name, 'Kouji Wada');
});

test('иероглифическое имя узнаётся по ID артиста из связки', () => {
  const p = predictTrack(ix, tr([{ id: 'SOKEN_ID', name: '祖堅 正慶' }], 'Another'));
  assert.equal(p.basis[0]?.name, 'Masayoshi Soken');
  // без ID — не узнать: кандзи в ромадзи мы не переводим
  assert.equal(predictTrack(ix, tr(['祖堅 正慶'], 'Another')).basis.length, 0);
});

test('связка не путает издателя с композитором', () => {
  const r = [row('Johan Lindgren', 'Idle Browsing', 7, 1, { spId: 'T' })];
  const sp = { T: { artists: [{ id: 'PDX', name: 'Paradox Interactive' }] } };
  assert.deepEqual(bridgeArtists(r, k => r[0].artist, sp), {});
  const r2 = [row('Король и Шут', 'Лесник', 8, 1, { spId: 'T' })];
  const sp2 = { T: { artists: [{ id: 'KISH', name: 'Korol i Shut' }] } };
  assert.deepEqual(bridgeArtists(r2, k => r2[0].artist, sp2), { KISH: 'король и шут' });
});

test('«уже разнесли»: по ссылке Spotify и по названию с тем же артистом', () => {
  const { rated, todo } = splitLibrary(ix, [
    tr([{ id: 'SOKEN_ID', name: '祖堅 正慶' }], 'Answers (FFXIV)', 300_000, 'SP_TRACK_1'),
    tr(['Reol'], 'DDD - Remastered'),
    tr(['Other Artist'], 'DDD')          // то же название, другой артист
  ]);
  assert.equal(rated.length, 2);
  assert.equal(todo.length, 1);
  assert.equal(todo[0].track.artists[0].name, 'Other Artist');
});

test('фильтры: короткие, минусовки и дубли убираются, длинные помечаются', () => {
  const { todo, dropped } = splitLibrary(ix, [
    tr(['A'], 'Short', 119_000),
    tr(['A'], 'Exactly two', 120_000),
    tr(['A'], 'Song (Instrumental)'),
    tr(['A'], 'Long one', 6 * 60_000 + 1),
    tr(['A'], 'Same'),
    tr(['A'], 'Same - Remastered 2020')
  ]);
  assert.deepEqual(dropped, { short: 1, version: 1, dup: 1, noArtist: 0 });
  assert.equal(todo.length, 3);
  assert.equal(todo.find(x => x.track.title === 'Long one').long, true);
  assert.equal(todo.find(x => x.track.title === 'Same').long, false);
});

test('сортировка: от лучшего прогноза к худшему', () => {
  const { todo } = splitLibrary(ix, [tr(['Some Rapper'], 'X'), tr(['Reol'], 'Y'), tr(['Nobody'], 'Z')]);
  assert.deepEqual(todo.map(x => x.track.artists[0].name), ['Reol', 'Nobody', 'Some Rapper']);
});

test('число переводится в ближайшую ступень', () => {
  assert.equal(scoreLabel(ix, 8.65), 'атлична++');
  assert.equal(scoreLabel(ix, 6.6), 'хорошечно++');
  assert.equal(scoreLabel(ix, 0.4), 'кринж-контент');
});

test('жанр MusicBrainz: незнакомый артист получает среднее новичков своего жанра', () => {
  const rowsMb = [
    row('Jazz One', 'a', 9, 1), row('Jazz Two', 'b', 9, 2),
    row('Punk One', 'c', 4, 1), row('Punk Two', 'd', 4, 2)
  ];
  const mbOf = k => k.startsWith('jazz') ? ['jazz'] : ['punk'];
  const m = buildModel({ rows: rowsMb, display: k => k, scale: SCALE, mbOf });
  assert.deepEqual(m.mb, { jazz: { n: 2, mean: 9 }, punk: { n: 2, mean: 4 } });
  const i2 = indexModel(m);
  const jazz = predictTrack(i2, { ...tr(['Новенький'], 'X'), mbGenres: ['jazz'] });
  const punk = predictTrack(i2, { ...tr(['Новенький'], 'X'), mbGenres: ['punk'] });
  const none = predictTrack(i2, { ...tr(['Новенький'], 'X'), mbGenres: ['zydeco'] });
  // (2×9 + 10×6.5) / (2+10)
  assert.equal(jazz.score, 6.92);
  assert.ok(punk.score < none.score && none.score < jazz.score);
  assert.equal(none.score, m.newMean, 'жанр без единого новичка в архиве ничего не говорит');
  assert.match(jazz.why, /новичков в жанре «jazz»/);
  assert.deepEqual(jazz.prior.genres, ['jazz']);
});

test('у знакомого артиста жанр почти не влияет: решают его разносы', () => {
  const p = predictTrack(ix, { ...tr(['Reol'], 'Y'), mbGenres: ['jazz'] });
  assert.equal(p.basis[0].name, 'Reol');
  assert.match(p.why, /Reol: 3 разноса/);
});
