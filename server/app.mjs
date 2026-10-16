/* ============================================================
   СЕРВЕР: ТРЕКИ ПЛЕЙЛИСТА ПО ССЫЛКЕ
   ------------------------------------------------------------
   Зачем он вообще. Сами треки браузер мог бы брать у Spotify напрямую
   (их GraphQL разрешает запросы с любого сайта), но анонимный токен
   лежит на embed-странице, а её браузеру с чужого сайта не прочитать.
   Плюс отпечаток запроса надо выковыривать из кода веб-плеера — это
   несколько мегабайт, телефону их качать незачем. Поэтому всё общение
   со Spotify — здесь, а прогноз считает телефон по модели с GitHub Pages.

   GET /playlist?url=<ссылка или ID>  → { id, name, total, tracks: [...] }
   GET /health                        → жив ли (Spotify не трогает)
   GET /status                        → ходит ли в Spotify: токен и отпечатки

   Здесь только обработчик; запуск — в server/index.mjs. Так его можно
   проверять с подставным Spotify, не уходя в сеть.
   ============================================================ */
import zlib from 'node:zlib';

/* Свежесть: «при каждом открытии новые треки подтягиваются сами».
   Пять минут — достаточно, чтобы переоткрытие приложения и двое
   друзей с одним плейлистом не гоняли Spotify заново, и достаточно
   мало, чтобы только что добавленный трек появился почти сразу. */
const CACHE_MS = 5 * 60_000;
const CACHE_MAX = 50;

/* Плейлист на 10 000 треков — сотня запросов к Spotify. Чтобы один
   человек (или чужой скрипт) не выжег анонимный доступ на всех,
   ограничиваем не-кешированные загрузки с одного адреса. */
const RATE_N = 20;
const RATE_MS = 10 * 60_000;

export function makeApp({ fetchPlaylist, playlistId, status, now = Date.now,
                          allowOrigin = '*' }) {
  const cache = new Map();     // id → { at, promise }
  const hits = new Map();      // ip → [метки времени]

  function overLimit(ip) {
    const t = now();
    const list = (hits.get(ip) || []).filter(x => t - x < RATE_MS);
    if (list.length >= RATE_N) { hits.set(ip, list); return true; }
    list.push(t);
    hits.set(ip, list);
    return false;
  }

  function load(id) {
    const c = cache.get(id);
    if (c && now() - c.at < CACHE_MS) return { promise: c.promise, cached: true };
    const promise = fetchPlaylist(id).then(pl => ({
      id, name: pl.name, total: pl.total,
      // альбом в прогнозе не нужен, а на 10 000 треках это лишние сотни КБ
      tracks: pl.tracks.map(t => ({ id: t.id, title: t.title, artists: t.artists, ms: t.ms }))
    }));
    // ошибку не кешируем: закрытый плейлист могут открыть через минуту
    promise.catch(() => cache.delete(id));
    cache.set(id, { at: now(), promise });
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    return { promise, cached: false };
  }

  function send(req, res, code, body, extra = {}) {
    const json = JSON.stringify(body);
    const headers = {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': allowOrigin,
      'cache-control': 'no-store',
      ...extra
    };
    // 10 000 треков — около 1,5 МБ JSON, сжатый — раз в шесть меньше
    if (json.length > 2048 && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
      res.writeHead(code, { ...headers, 'content-encoding': 'gzip', vary: 'accept-encoding' });
      res.end(zlib.gzipSync(json));
    } else {
      res.writeHead(code, headers);
      res.end(json);
    }
  }

  return async function handler(req, res) {
    const u = new URL(req.url, 'http://x');
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'access-control-allow-origin': allowOrigin,
                           'access-control-allow-methods': 'GET' });
      return res.end();
    }
    if (req.method !== 'GET') return send(req, res, 405, { error: 'Только GET' });

    if (u.pathname === '/health') return send(req, res, 200, { ok: true });

    if (u.pathname === '/status') {
      try { return send(req, res, 200, { ok: true, ...(await status()) }); }
      catch (e) { return send(req, res, 502, { ok: false, error: e.message }); }
    }

    if (u.pathname === '/playlist') {
      const id = playlistId(u.searchParams.get('url') || u.searchParams.get('id') || '');
      if (!id) return send(req, res, 400, { error: 'Это не похоже на ссылку на плейлист Spotify.' });

      // Railway стоит за прокси: настоящий адрес — первый в x-forwarded-for
      const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '')
        .split(',')[0].trim();
      const c = cache.get(id);
      const fresh = c && now() - c.at < CACHE_MS;
      if (!fresh && overLimit(ip)) {
        return send(req, res, 429, { error: 'Слишком много плейлистов подряд. Попробуй минут через десять.' },
                    { 'retry-after': String(RATE_MS / 1000) });
      }
      try {
        const { promise, cached } = load(id);
        const body = await promise;
        return send(req, res, 200, body, { 'x-cache': cached ? 'hit' : 'miss' });
      } catch (e) {
        const closed = /не найден|закрыт/i.test(e.message);
        return send(req, res, closed ? 404 : 502, {
          error: closed ? e.message : 'Spotify не ответил. Попробуй ещё раз чуть позже.'
        });
      }
    }

    return send(req, res, 404, { error: 'Нет такого адреса. Есть /playlist?url=…, /health, /status' });
  };
}
