/* Снимки приложения в трёх ширинах — посмотреть глазами.

     node scripts/shots.mjs [ссылка на плейлист]

   Проверки ловят «сломано», но не ловят «пусто» и «некрасиво» (это
   знание из faryma.stats). Поэтому после правок в app/ или index.html —
   снять и посмотреть. Плейлист берётся живой, с сервера на Railway.
   Заодно проверяем, что страница не ездит вбок. Снимки — в shots/. */
import fs from 'node:fs';
import { chromium } from 'playwright';
import { serve } from './serve.mjs';

const PLAYLIST = process.argv[2] || 'https://open.spotify.com/playlist/3UiLmCyhLOYPEnrjaIpZVC';
const WIDTHS = [[360, 780], [412, 915], [1280, 900]];

fs.mkdirSync('shots', { recursive: true });
const site = await serve();
const browser = await chromium.launch();
let bad = 0;

for (const [w, h] of WIDTHS) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: w < 500 ? 2 : 1,
                                         serviceWorkers: 'block' });
  const page = await ctx.newPage();
  page.on('pageerror', e => { bad++; console.error(`[${w}] ошибка на странице:`, e.message); });
  const snap = async name => {
    const over = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    if (over > 0) { bad++; console.error(`[${w}] ${name}: страница шире экрана на ${over}px`); }
    await page.screenshot({ path: `shots/${w}-${name}.png` });
    console.log(`shots/${w}-${name}.png`);
  };

  await page.goto(site.url);
  await page.waitForSelector('#start:not([hidden])');
  await snap('1-start');

  await page.fill('#url', PLAYLIST);
  await page.click('#form button[type=submit]');
  await page.waitForSelector('#result:not([hidden])', { timeout: 60_000 });
  await snap('2-todo');

  // где начинаются незнакомые артисты — пунктирные плашки
  await page.evaluate(async () => {
    for (let i = 0; i < 20 && !document.querySelector('.rate.guess'); i++) document.getElementById('more').click();
    document.querySelector('.rate.guess')?.closest('li').scrollIntoView({ block: 'center' });
  });
  await snap('2b-guess');

  await page.evaluate(() => scrollTo(0, 0));
  await page.click('#tabRated');
  await snap('3-rated');

  await page.click('#tabTodo');
  await page.click('[data-f="known"]');
  await page.evaluate(() => document.querySelector('#result details').open = true);
  await page.evaluate(() => scrollTo(0, document.body.scrollHeight));
  await snap('4-bottom');
  await ctx.close();
}
await browser.close();
site.close();
if (bad) { console.error(`Проблем: ${bad}`); process.exit(1); }
