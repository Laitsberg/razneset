/* Раздать приложение локально — как его раздаёт GitHub Pages.

     node scripts/serve.mjs [порт]

   Нужен для проверок и снимков экрана; сам сайт живёт на Pages. */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png'
};

export function serve(port = 0) {
  const srv = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const file = path.join(ROOT, p);
    // за пределы репозитория не выпускаем, служебное не раздаём
    if (!file.startsWith(ROOT + path.sep) || /[\\/](\.git|node_modules)[\\/]/.test(file)) {
      res.writeHead(403); return res.end();
    }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404); return res.end('нет такого файла'); }
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
      res.end(buf);
    });
  });
  return new Promise(r => srv.listen(port, '127.0.0.1', () =>
    r({ url: `http://127.0.0.1:${srv.address().port}/`,
       // closeAllConnections: иначе браузер держит соединение открытым,
       // и «выключенный» сервер продолжает отвечать
       close: () => { srv.close(); srv.closeAllConnections(); } })));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const s = await serve(+process.argv[2] || 8080);
  console.log('Приложение:', s.url);
}
