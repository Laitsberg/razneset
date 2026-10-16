/* Код разбора берётся с сайта статистики (или из FARYMA_STATS_DIR).
   Проверяем, что он грузится в песочницу и работает в ней так же, как
   на сайте. Нужна сеть, если FARYMA_STATS_DIR не задан. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadShared } from '../lib/shared.mjs';
import { archiveRows } from '../lib/archive.mjs';

const sh = await loadShared();

test('шкала сайта: 26 ступеней, от «гениально» до «кринж-контента»', () => {
  assert.equal(sh.SCALE_ORDER.length, 26);
  assert.equal(sh.SCALE_ORDER[0], 'гениально');
  assert.equal(sh.SCALE_ORDER.at(-1), 'кринж-контент');
  assert.equal(sh.parseRate('атлична+').score, 8.3);
  // шуточный плюс к потолку — не оценка
  assert.equal(sh.parseRate('гениально+'), null);
});

const CSV = [
  'Что,Где,Когда,Кто,Тип,Оценка,Откуда,Тэги,Жанр,Фича',
  'СТРИМ №2 (15.10.26),https://vkvideo.ru/v,,,,,,,,',
  '1) Ado & Hatsune Miku — Song A,https://open.spotify.com/track/2ZapBCsQ5sWMNr9Tr1n8LX?si=x,,,донат,атлична,,,поп,',
  '2) MYTH & ROID — Frozen Rain [OST; Youjo Senki],,,,донат,хорошечно-,,,рок,',
  ',,,,донат,нормас,,,,',
  'СТРИМ №1 (14.10.26),,,,,,,,,',
  '1) Ado — Solo,,,,донат,гениально,,,,',
  '2) Hatsune Miku — Solo too,,,,донат,нормас,,,,'
].join('\n');

test('архив разбирается как на сайте', () => {
  const { rows } = archiveRows(sh, CSV);
  assert.equal(rows.length, 4, 'строка с оценкой, но без названия — ещё не разнос');
  const a = rows.find(r => r.title === 'Song A');
  // без URL в песочнице spotifyId молча отдавал бы пустоту
  assert.equal(a.spId, '2ZapBCsQ5sWMNr9Tr1n8LX');
  assert.deepEqual(a.parts, ['ado', 'hatsune miku'], 'оба поют соло — значит, двое');
  assert.equal(a.streamNum, 2);
  assert.equal(a.date, '2026-10-15');
  const m = rows.find(r => r.title === 'Frozen Rain');
  assert.deepEqual(m.parts, ['myth & roid'], 'MYTH и ROID по отдельности не выступают — это группа');
  assert.deepEqual(m.genres, ['рок']);
});
