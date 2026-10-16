/* ============================================================
   SPOTIFY БЕЗ ВХОДА
   ------------------------------------------------------------
   Официальный Web API с февраля 2026 в Dev Mode не отдаёт треки
   чужих плейлистов (только своих и совместных), а client credentials
   с анонимным токеном упирается в 429 QUOTA_EXCEEDED. Проверено
   16.10.2026.

   Работает то, чем пользуется сам веб-плеер open.spotify.com:
   * анонимный токен лежит в __NEXT_DATA__ любой embed-страницы
     (живёт около часа);
   * треки плейлиста отдаёт внутренний GraphQL (pathfinder) кусками
     по 100 — проверено на плейлистах в 10 000 треков, отдаёт все.

   Это неофициальная дорожка. Запросы там опознаются по «отпечатку»
   (sha256 запроса), и он меняется, когда Spotify выкатывает новый
   веб-плеер. Поэтому отпечатки не зашиты намертво: при старте их
   ищем в свежем коде плеера, а записанные ниже — запасной вариант.
   ============================================================ */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/130.0 Safari/537.36';

const GQL = 'https://api-partner.spotify.com/pathfinder/v2/query';

// найдено в web-player.c6932d85.js 16.10.2026
const FALLBACK_HASH = {
  fetchPlaylistContents: '21ea11a6ac75a5f3e01fd365d29c18e0a4a8b7dc09f89bbb5d73910190c6acaf',
  getTrack: 'a8ef9e9f02b836feb0da3003c31dbb30decc6f4b473ef89ca88c882386d668de'
};

// Любой существующий трек: нужна не музыка, а токен со страницы.
// Берём трек из самого архива («MYTH & ROID — Frozen Rain»).
const TOKEN_TRACK = '2ZapBCsQ5sWMNr9Tr1n8LX';

let token = null;      // { value, expires }
let hashes = null;

function nextData(html) {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/s);
  return m ? JSON.parse(m[1]) : null;
}

export async function anonToken() {
  // запас в минуту: иначе длинный плейлист может начаться с живым
  // токеном, а закончиться с протухшим
  if (token && token.expires - 60_000 > Date.now()) return token.value;
  const r = await fetch(`https://open.spotify.com/embed/track/${TOKEN_TRACK}`,
                        { headers: { 'user-agent': UA } });
  const d = nextData(await r.text());
  const s = d?.props?.pageProps?.state?.settings?.session;
  if (!s?.accessToken) throw new Error('Spotify: на embed-странице нет токена');
  token = { value: s.accessToken, expires: s.accessTokenExpirationTimestampMs || Date.now() + 30 * 60_000 };
  return token.value;
}

/* Отпечатки запросов — из кода веб-плеера, который сейчас на сайте */
export async function queryHashes() {
  if (hashes) return hashes;
  hashes = { ...FALLBACK_HASH };
  try {
    const page = await (await fetch('https://open.spotify.com/', { headers: { 'user-agent': UA } })).text();
    const js = page.match(/https:\/\/open\.spotifycdn\.com\/cdn\/build\/web-player\/web-player\.[0-9a-f]+\.js/);
    if (js) {
      const code = await (await fetch(js[0])).text();
      for (const op of Object.keys(FALLBACK_HASH)) {
        const m = code.match(new RegExp(`"${op}","query","([0-9a-f]{64})"`));
        if (m) hashes[op] = m[1];
      }
    }
  } catch { /* остаёмся на запасных */ }
  return hashes;
}

async function gql(op, variables) {
  const h = await queryHashes();
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(GQL, {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + await anonToken(),
        'content-type': 'application/json',
        'app-platform': 'WebPlayer',
        'user-agent': UA
        // accept-language не ставим нарочно: без него Spotify отдаёт
        // имена латиницей («Kenshi Yonezu»), с ja — «米津玄師»
      },
      body: JSON.stringify({
        variables, operationName: op,
        extensions: { persistedQuery: { version: 1, sha256Hash: h[op] } }
      })
    });
    if (r.status === 429 && attempt < 4) {
      const wait = (+r.headers.get('retry-after') || 2 ** attempt) * 1000;
      await new Promise(res => setTimeout(res, wait));
      continue;
    }
    if (r.status === 401 && attempt < 1) { token = null; continue; }
    const text = await r.text();
    if (!r.ok) throw new Error(`Spotify ${op}: HTTP ${r.status} ${text.slice(0, 200)}`);
    const j = JSON.parse(text);
    if (j.errors?.length && !j.data) throw new Error(`Spotify ${op}: ${j.errors[0].message}`);
    return j.data;
  }
}

/* «https://open.spotify.com/playlist/ID?si=…», «spotify:playlist:ID» или сам ID */
export function playlistId(input) {
  const s = String(input || '').trim();
  const m = s.match(/playlist[/:]([A-Za-z0-9]{22})/) || s.match(/^([A-Za-z0-9]{22})$/);
  return m ? m[1] : '';
}

/* Трек в том виде, в каком с ним работает прогноз */
function plainTrack(t) {
  return {
    id: String(t.uri || '').split(':').pop(),
    title: t.name,
    artists: (t.artists?.items || t.firstArtist?.items?.concat(t.otherArtists?.items || []) || [])
      .map(a => ({ id: String(a.uri || '').split(':').pop(), name: a.profile?.name || '' })),
    ms: t.trackDuration?.totalMilliseconds ?? t.duration?.totalMilliseconds ?? null,
    album: t.albumOfTrack?.name || ''
  };
}

/* Все треки публичного плейлиста. Первую страницу берём одну — из неё
   узнаём общее число, — остальные по нескольку разом. */
export async function fetchPlaylist(id, { onProgress } = {}) {
  const page = async offset => (await gql('fetchPlaylistContents', {
    uri: `spotify:playlist:${id}`, offset, limit: 100, enableWatchFeedEntrypoint: false
  }))?.playlistV2;

  // Название в запросе содержимого не приходит — берём с embed-страницы.
  // Она же честно отвечает 404 на закрытый плейлист, тогда как GraphQL
  // на закрытый может вернуть пустоту, неотличимую от пустого плейлиста.
  const embed = await fetch(`https://open.spotify.com/embed/playlist/${id}`, { headers: { 'user-agent': UA } })
    .then(r => r.text()).then(nextData).catch(() => null);
  const state = embed?.props?.pageProps;
  if (state && !state.state?.data?.entity) {
    throw new Error('Плейлист не найден или закрыт. Сделай его публичным.');
  }
  const name = state?.state?.data?.entity?.name || '';

  const first = await page(0);
  if (!first || first.__typename === 'NotFound' || !first.content) {
    throw new Error('Плейлист не найден или закрыт. Сделай его публичным.');
  }
  const total = first.content.totalCount;
  const items = [...first.content.items];
  const offsets = [];
  for (let o = 100; o < total; o += 100) offsets.push(o);
  const PAR = 4;
  for (let i = 0; i < offsets.length; i += PAR) {
    const chunk = await Promise.all(offsets.slice(i, i + PAR).map(page));
    chunk.forEach(p => items.push(...(p?.content?.items || [])));
    onProgress?.(items.length, total);
  }
  // в плейлисте бывают подкасты и локальные файлы — это не треки
  const tracks = items.map(it => it?.itemV2?.data)
    .filter(d => d && d.__typename === 'Track')
    .map(plainTrack);
  return { name: name || first.name || '', total, tracks };
}

export async function fetchTrack(id) {
  const d = await gql('getTrack', { uri: `spotify:track:${id}` });
  const t = d?.trackUnion;
  if (!t || t.__typename !== 'Track') return null;
  return plainTrack(t);
}
