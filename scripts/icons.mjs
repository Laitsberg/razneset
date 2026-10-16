/* Картинки значка из icons/icon.svg — запускать после правки значка.

     node scripts/icons.mjs

   Нужен Playwright с Chromium (в облачной сессии он уже стоит).
   Маскируемый вариант Android обрезает под форму значков телефона —
   круг, каплю, скруглённый квадрат, — и гарантирует видимость только
   середины (80%). Поэтому там градиент во весь квадрат без скруглений,
   а полоски сжаты к центру. */
import fs from 'node:fs';
import { chromium } from 'playwright';

const svg = fs.readFileSync('icons/icon.svg', 'utf8');
const maskable = svg
  .replace('<rect width="64" height="64" rx="14" fill="url(#g)"/>',
           '<rect width="64" height="64" fill="url(#g)"/><g transform="translate(32 32) scale(.72) translate(-32 -32)">')
  .replace('</svg>', '</g></svg>');

const OUT = [
  ['icons/icon-192.png', svg, 192],
  ['icons/icon-512.png', svg, 512],
  ['icons/maskable-512.png', maskable, 512],
  ['icons/apple-touch-icon.png', maskable, 180],   // iPhone скругляет углы сам
  ['icons/favicon-32.png', svg, 32]
];

const browser = await chromium.launch();
const page = await browser.newPage();
for (const [file, src, size] of OUT) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${src}`);
  await page.screenshot({ path: file, omitBackground: true });
  console.log(file);
}
await browser.close();
