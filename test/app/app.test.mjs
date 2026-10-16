/* Приложение в настоящем браузере. Сервер на Railway подменяем: проверки
   не должны зависеть от сети и от того, что сегодня в чьём-то плейлисте.
   Модель — настоящая, из data/, и ожидаемые числа считаем тем же
   splitLibrary: экран обязан показывать ровно то, что посчитал
   проверенный по истории код, а не что-то своё. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from 'playwright';
import { serve } from '../../scripts/serve.mjs';
import { indexModel, splitLibrary } from '../../lib/predict.mjs';

const SERVER = 'https://server-production-ae29.up.railway.app';
const ID = '3UiLmCyhLOYPEnrjaIpZVC';
const LINK = `https://open.spotify.com/playlist/${ID}?si=abc`;

const model = JSON.parse(fs.readFileSync('data/model.json', 'utf8'));
const ix = indexModel(model);
// Трек, который точно есть в архиве: берём из самой модели, со ссылкой
const ratedRow = model.tracks.find(t => t.sp && t.a.length === 1 && model.artists[t.a[0]].n >= 3);
const known = model.artists[ratedRow.a[0]].name;

const T = (id, title, artist, ms = 200_000) => ({ id, title, ms, artists: [{ id: '', name: artist }] });
const TRACKS = [
  { ...T(ratedRow.sp, 'Как угодно — найдётся по ссылке', known), id: ratedRow.sp },
  T('known1', 'Совсем новая песня', known),
  T('long1', 'Очень длинная', known, 7 * 60_000),
  T('short1', 'Короткая', known, 60_000),
  T('inst1', 'Песня (Instrumental)', known),
  T('xss', '<img src=x onerror="window.__xss=1">', 'Хакер'),
  ...Array.from({ length: 230 }, (_, i) => T('u' + i, 'Незнакомая ' + i, 'Никто Неизвестный ' + i))
];
const EXPECT = splitLibrary(ix, TRACKS);

let site, browser;
before(async () => { site = await serve(); browser = await chromium.launch(); });
after(async () => { await browser?.close(); site?.close(); });

/* Страница с подменённым сервером. reply — что он отвечает на /playlist */
async function open({ reply = () => ({ status: 200, body: { id: ID, name: 'Тестовый', total: TRACKS.length, tracks: TRACKS } }),
                      genres = () => ({ status: 200, body: { genres: {} } }),
                      width = 360, ctx = null, url = site.url } = {}) {
  const context = ctx || await browser.newContext({ viewport: { width, height: 800 }, serviceWorkers: 'block' });
  const page = await context.newPage();
  const calls = [];
  const genreCalls = [];
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route(SERVER + '/**', async route => {
    const u = route.request().url();
    let r;
    if (u.includes('/genres?')) { genreCalls.push(u); r = await genres(u); }
    else { calls.push(u); r = await reply(calls.length); }
    if (r === 'hang') return;   // сервер молчит
    await route.fulfill({ status: r.status, contentType: 'application/json',
                          headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(r.body) });
  });
  await page.goto(url);
  return { page, context, calls, genreCalls, errors };
}

const submit = async (page, link) => {
  await page.waitForSelector('#start:not([hidden])');
  await page.fill('#url', link);
  await page.click('#form button[type=submit]');
};
const text = (page, sel) => page.locator(sel).innerText();

test('первый вход: форма, а не пустой экран', async () => {
  const { page, context, errors } = await open();
  await page.waitForSelector('#start:not([hidden])');
  assert.match(await text(page, '#archive'), new RegExp(model.rated.toLocaleString('ru-RU').replace(/\s/g, '\\s')));
  assert.deepEqual(errors, []);
  await context.close();
});

test('не ссылка на плейлист — подсказка, сервер не трогаем', async () => {
  const { page, context, calls } = await open();
  await submit(page, 'https://open.spotify.com/album/' + ID);
  await page.waitForSelector('#formErr:not([hidden])');
  assert.match(await text(page, '#formErr'), /не похоже на ссылку/);
  assert.equal(calls.length, 0);
  await context.close();
});

test('списки на экране — ровно то, что насчитал прогноз', async () => {
  const { page, context, errors } = await open();
  await submit(page, LINK);
  await page.waitForSelector('#result:not([hidden])');
  const n = s => s.replace(/\s/g, '');
  assert.equal(n(await text(page, '#nTodo')), String(EXPECT.todo.length));
  assert.equal(n(await text(page, '#nRated')), String(EXPECT.rated.length));
  assert.ok(EXPECT.rated.length >= 1, 'трек со ссылкой из архива должен узнаться');
  // первая строка — лучший прогноз
  assert.equal(await page.locator('#list .rate').first().innerText(), EXPECT.todo[0].label);
  // скрытые перечислены
  const hidden = await text(page, '#hidden');
  assert.match(hidden, /1 короче 2:00/);
  assert.match(hidden, /1 минусовка/);
  // длинный трек помечен
  const long = page.locator('#list li', { hasText: 'Очень длинная' });
  assert.match(await long.innerText(), /доплата/);
  // незнакомый артист нарисован пунктиром, знакомый — нет
  assert.equal(await page.locator('#list li', { hasText: 'Совсем новая песня' }).locator('.rate.guess').count(), 0);
  assert.equal(errors.length, 0, errors.join('\n'));
  await context.close();
});

test('название трека с HTML показывается текстом, а не выполняется', async () => {
  const { page, context } = await open();
  await submit(page, LINK);
  await page.waitForSelector('#result:not([hidden])');
  await page.fill('#q', 'img');
  assert.match(await text(page, '#list'), /<img src=x onerror/);
  assert.equal(await page.evaluate(() => window.__xss), undefined);
  await context.close();
});

test('по 100 строк и «Показать ещё»; поиск и «знакомые артисты»', async () => {
  const { page, context } = await open();
  await submit(page, LINK);
  await page.waitForSelector('#result:not([hidden])');
  assert.equal(await page.locator('#list li').count(), 100);
  await page.click('#more');
  assert.equal(await page.locator('#list li').count(), 200);

  await page.click('[data-f="known"]');
  const knownN = EXPECT.todo.filter(x => x.basis.length).length;
  assert.equal(await page.locator('#list li').count(), knownN);
  assert.equal(await page.locator('#list .rate.guess').count(), 0);

  await page.click('[data-f="all"]');
  await page.fill('#q', 'Незнакомая 229');  // «17» нашла бы и 170–179
  assert.equal(await page.locator('#list li').count(), 1);
  await page.fill('#q', 'нет такого трека');
  assert.match(await text(page, '#empty'), /Ничего не нашлось/);
  await context.close();
});

test('вкладка «Уже разнесли»: настоящая оценка и номер стрима', async () => {
  const { page, context } = await open();
  await submit(page, LINK);
  await page.click('#tabRated');
  const first = EXPECT.rated[0].ratings[0];
  assert.equal(await page.locator('#list .rate').first().innerText(), first.l);
  assert.match(await page.locator('#list li').first().innerText(), new RegExp('стрим №' + first.s));
  await context.close();
});

test('закрытый плейлист — объяснение на экране ввода', async () => {
  const { page, context } = await open({
    reply: () => ({ status: 404, body: { error: 'Плейлист не найден или закрыт. Сделай его публичным.' } })
  });
  await submit(page, LINK);
  await page.waitForSelector('#formErr:not([hidden])');
  assert.match(await text(page, '#formErr'), /публичным/);
  await context.close();
});

test('повторный вход: прошлый список сразу, свежий — следом', async () => {
  const context = await browser.newContext({ viewport: { width: 360, height: 800 }, serviceWorkers: 'block' });
  const first = await open({ ctx: context });
  await submit(first.page, LINK);
  await first.page.waitForSelector('#result:not([hidden])');
  await first.page.close();

  // второй вход: сервер молчит — а список всё равно на экране
  const second = await open({ ctx: context, reply: () => 'hang' });
  await second.page.waitForSelector('#result:not([hidden])');
  assert.equal((await text(second.page, '#nTodo')).replace(/\s/g, ''), String(EXPECT.todo.length));
  assert.equal(second.calls.length, 1, 'и при этом за свежим сходили');
  await second.page.close();

  // третий: сервер ответил ошибкой — список остаётся, сверху плашка
  const third = await open({ ctx: context, reply: () => ({ status: 502, body: { error: 'Spotify не ответил.' } }) });
  await third.page.waitForSelector('#banner:not([hidden])');
  assert.match(await text(third.page, '#banner'), /Не удалось обновить: Spotify не ответил/);
  assert.equal(await third.page.locator('#result').isVisible(), true);
  await context.close();
});

test('узкий телефон: страница не ездит вбок', async () => {
  const { page, context } = await open({ width: 320 });
  await submit(page, LINK);
  await page.waitForSelector('#result:not([hidden])');
  for (const tab of ['#tabTodo', '#tabRated']) {
    await page.click(tab);
    const over = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    assert.ok(over <= 0, `${tab}: шире экрана на ${over}px`);
  }
  await context.close();
});

/* Офлайн-режим Playwright на запросы самого сервис-воркера не действует:
   воркер и «без сети» достаёт файлы с локального сервера, и запасной путь
   из кеша ни разу не срабатывает — проверка проходила, даже когда его
   сломали. Поэтому у этой проверки свой сервер, и его выключаем. */
test('без сети открывается из кеша (сервис-воркер)', async () => {
  const own = await serve();
  const context = await browser.newContext({ viewport: { width: 360, height: 800 } });
  try {
    const { page } = await open({ ctx: context, url: own.url });
    await submit(page, LINK);
    await page.waitForSelector('#result:not([hidden])');
    await page.evaluate(() => navigator.serviceWorker.ready);
    // воркер берёт управление со второй загрузки — загружаем ещё раз при сети
    await page.reload();
    await page.waitForSelector('#result:not([hidden])');
    await page.waitForFunction(() => navigator.serviceWorker.controller);
    own.close();
    await context.setOffline(true);
    await page.reload();
    await page.waitForSelector('#result:not([hidden])');
    assert.equal((await text(page, '#nTodo')).replace(/\s/g, ''), String(EXPECT.todo.length));
  } finally {
    own.close();
    await context.close();
  }
});

/* ---------- жанры незнакомых артистов ---------- */
const JAZZ_ID = 'J'.repeat(22), PUNK_ID = 'P'.repeat(22), NONE_ID = 'N'.repeat(22);
const GT = [
  { id: 'g1', title: 'Джазовый новичок', ms: 200_000, artists: [{ id: JAZZ_ID, name: 'Никому Не Известный Джазмен' }] },
  { id: 'g2', title: 'Панковый новичок', ms: 200_000, artists: [{ id: PUNK_ID, name: 'Никому Не Известный Панк' }] },
  { id: 'g3', title: 'Совсем безвестный', ms: 200_000, artists: [{ id: NONE_ID, name: 'Никому Не Известный Вообще' }] }
];
const GENRES = { [JAZZ_ID]: ['jazz'], [PUNK_ID]: ['punk'], [NONE_ID]: [] };
const plWith = tracks => () => ({ status: 200, body: { id: ID, name: 'Жанры', total: tracks.length, tracks } });

test('жанры MusicBrainz: незнакомые артисты получают прогноз по жанру', async () => {
  assert.ok(model.mb.jazz && model.mb.punk, 'в модели должны быть жанры jazz и punk');
  const { page, context, genreCalls } = await open({
    reply: plWith(GT), genres: () => ({ status: 200, body: { genres: GENRES } })
  });
  await submit(page, LINK);
  await page.waitForSelector('#genreNote:not([hidden])');
  await page.waitForFunction(() => /нашёлся у/.test(document.getElementById('genreNote').textContent));
  assert.match(await text(page, '#genreNote'), /Жанр нашёлся у 2 из 3 незнакомых артистов/);
  assert.equal(genreCalls.length, 1);
  assert.deepEqual(new URL(genreCalls[0]).searchParams.get('ids').split(',').sort(), [JAZZ_ID, NONE_ID, PUNK_ID].sort());

  // ровно то, что посчитал бы splitLibrary с этими жанрами
  const expect = splitLibrary(ix, GT.map(t => GENRES[t.artists[0].id].length ? { ...t, mbGenres: GENRES[t.artists[0].id] } : t));
  const shown = await page.locator('#list li').evaluateAll(lis => lis.map(li => ({
    title: li.querySelector('.name').textContent, rate: li.querySelector('.rate').textContent })));
  assert.deepEqual(shown.map(x => x.title), expect.todo.map(x => x.track.title));
  const jazz = shown.find(x => x.title === 'Джазовый новичок');
  assert.match(jazz.rate, /≈ по жанру/);
  assert.match(shown.find(x => x.title === 'Совсем безвестный').rate, /≈ новичок/);
  assert.match(await page.locator('#list li', { hasText: 'Джазовый новичок' }).innerText(), /новичков в жанре «jazz»/);
  await context.close();
});

test('жанры запоминаются: второй вход MusicBrainz не спрашивает', async () => {
  const context = await browser.newContext({ viewport: { width: 360, height: 800 }, serviceWorkers: 'block' });
  const g = () => ({ status: 200, body: { genres: GENRES } });
  const first = await open({ ctx: context, reply: plWith(GT), genres: g });
  await submit(first.page, LINK);
  await first.page.waitForFunction(() => /нашёлся у/.test(document.getElementById('genreNote').textContent));
  await first.page.close();
  const second = await open({ ctx: context, reply: plWith(GT), genres: g });
  await second.page.waitForSelector('#result:not([hidden])');
  await second.page.waitForFunction(() => /нашёлся у/.test(document.getElementById('genreNote').textContent));
  assert.equal(second.genreCalls.length, 0);
  await context.close();
});

test('MusicBrainz тянет: сначала часть, недоисканное переспрашиваем', async () => {
  let n = 0;
  const { page, context, genreCalls } = await open({
    reply: plWith(GT),
    genres: () => (++n === 1)
      ? { status: 200, body: { genres: { [JAZZ_ID]: ['jazz'] }, pending: [PUNK_ID, NONE_ID] } }
      : { status: 200, body: { genres: { [PUNK_ID]: ['punk'], [NONE_ID]: [] }, pending: [] } }
  });
  // не ждать 25 секунд в проверке
  await page.clock.install();
  await submit(page, LINK);
  await page.waitForFunction(() => /ещё 2 ищутся/.test(document.getElementById('genreNote').textContent));
  assert.equal(await page.locator('#list .rate', { hasText: 'по жанру' }).count(), 1);
  await page.clock.runFor(26_000);
  await page.waitForFunction(() => /нашёлся у 2 из 3/.test(document.getElementById('genreNote').textContent));
  assert.deepEqual(new URL(genreCalls[1]).searchParams.get('ids').split(',').sort(), [NONE_ID, PUNK_ID].sort());
  assert.equal(await page.locator('#list .rate', { hasText: 'по жанру' }).count(), 2);
  await context.close();
});

test('MusicBrainz не ответил — список на месте, прогноз без жанра, честная пометка', async () => {
  const { page, context, genreCalls } = await open({
    reply: plWith(GT), genres: () => ({ status: 502, body: { error: 'MusicBrainz не ответил.' } })
  });
  await page.clock.install();
  await submit(page, LINK);
  await page.waitForSelector('#result:not([hidden])');
  for (let i = 0; i < 4; i++) await page.clock.runFor(26_000);
  await page.waitForFunction(() => /при следующем открытии/.test(document.getElementById('genreNote').textContent));
  assert.equal(genreCalls.length, 4, 'переспросили, но не бесконечно');
  assert.equal(await page.locator('#list li').count(), 3);
  assert.equal(await page.locator('#list .rate', { hasText: 'по жанру' }).count(), 0);
  await context.close();
});
