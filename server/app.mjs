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

/* Жанры MusicBrainz артиста меняются редко, а спрашивать их дорого
   (раз в секунду на всех) — помним две недели. «Не нашлось» помним
   так же: иначе каждый плейлист заново спрашивал бы сотни безвестных. */
const GENRE_MS = 14 * 24 * 3600_000;
const GENRE_IDS_MAX = 300;      // за один запрос — адрес не должен распухать
const GENRE_RATE_N = 30;        // запросов с новыми артистами за 10 минут

export function makeApp({ fetchPlaylist, playlistId, status, genresFor = null, now = Date.now,
                          allowOrigin = '*' }) {
  const cache = new Map();     // id → { at, promise }
  const genreCache = new Map();  // id артиста Spotify → { at, g } или { at, promise }

  const limiter = (n, ms) => {
    const hits = new Map();    // ip → [метки времени]
    return ip => {
      const t = now();
      const list = (hits.get(ip) || []).filter(x => t - x < ms);
      if (list.length >= n) { hits.set(ip, list); return true; }
      list.push(t);
      hits.set(ip, list);
      return false;
    };
  };
  const overLimit = limiter(RATE_N, RATE_MS);
  const overGenreLimit = limiter(GENRE_RATE_N, RATE_MS);
  const clientIp = req => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '')
    .split(',')[0].trim();

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
      const ip = clientIp(req);
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

    if (u.pathname === '/genres' && genresFor) {
      const ids = [...new Set((u.searchParams.get('ids') || '').split(','))]
        .filter(id => /^[A-Za-z0-9]{22}$/.test(id));
      if (!ids.length) return send(req, res, 400, { error: 'Нужны ID артистов Spotify через запятую.' });
      if (ids.length > GENRE_IDS_MAX) return send(req, res, 400, { error: `Не больше ${GENRE_IDS_MAX} артистов за раз.` });

      const fresh = id => { const c = genreCache.get(id); return c && (c.promise || now() - c.at < GENRE_MS); };
      const missing = ids.filter(id => !fresh(id));
      if (missing.length && overGenreLimit(clientIp(req))) {
        return send(req, res, 429, { error: 'Слишком много запросов жанров подряд.' },
                    { 'retry-after': String(RATE_MS / 1000) });
      }
      if (missing.length) {
        // одна пачка на всех недостающих; кто придёт за ними же, пока она
        // в пути, дождётся её, а не пойдёт в MusicBrainz второй раз
        const batch = genresFor(missing);
        for (const id of missing) {
          const promise = batch.then(r => r[id] || []);
          genreCache.set(id, { at: now(), promise });
          promise.then(g => genreCache.set(id, { at: now(), g }), () => genreCache.delete(id));
        }
      }
      try {
        const out = {};
        for (const id of ids) {
          const c = genreCache.get(id);
          out[id] = c.promise ? await c.promise : c.g;
        }
        return send(req, res, 200, { genres: out });
      } catch (e) {
        // причину — в лог: снаружи видно только «не ответил», а чинить
        // по этому нечего (первый запуск на Railway так и разбирали)
        console.error('/genres:', e.message);
        return send(req, res, 502, { error: 'MusicBrainz не ответил. Жанры подтянутся в следующий раз.' });
      }
    }

    return send(req, res, 404, { error: 'Нет такого адреса. Есть /playlist?url=…, /genres?ids=…, /health, /status' });
  };
}
