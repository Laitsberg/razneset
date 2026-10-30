/* ============================================================
   YOUTUBE БЕЗ КЛЮЧА
   ------------------------------------------------------------
   Плейлист YouTube читаем так же, как сам сайт youtube.com: страница
   плейлиста несёт первые ~100 роликов в ytInitialData, остальное
   отдаёт внутренний /youtubei/v1/browse по токену продолжения — тем
   же запросом, что шлёт страница, когда её листают. Ключ YouTube Data
   API не нужен. Проверено 30.10.2026: плейлист на 239 роликов отдал
   все 159 доступных (недоступные YouTube прячет сам).

   Это неофициальная дорожка, как и у Spotify. Если YouTube поменяет
   разметку, первым делом смотреть, где теперь ролики: сейчас это
   lockupViewModel, раньше был playlistVideoRenderer — его тоже
   понимаем, на случай отката.

   Названия — заголовки роликов, а не песен: «Queen - Somebody To Love
   (Official Video)». Делить их на исполнителя и название — забота того,
   кто список читает: здесь отдаём как есть, вместе с каналом.
   ============================================================ */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/130.0 Safari/537.36';
// SOCS — согласие на куки: без него из Европы вместо плейлиста приходит
// страница с вопросом про куки.
const HEADERS = { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9', cookie: 'SOCS=CAI' };
const TIMEOUT_MS = 20_000;
const MAX_PAGES = 60;   // ~6000 роликов: больше в плейлисте YouTube и не бывает (5000)

const CLOSED = 'Плейлист не найден или закрыт. Сделай его открытым или доступным по ссылке.';

/* «…youtube.com/playlist?list=ID», «…watch?v=…&list=ID», «music.youtube.com/…?list=ID»
   или сам ID. «Смотреть позже» (WL) и «Понравившиеся» (LL) всегда
   закрыты — их не принимаем, а объясняем. */
export function youtubePlaylistId(input) {
  const s = String(input || '').trim();
  let id = '';
  try { id = new URL(s).searchParams.get('list') || ''; } catch { /* не ссылка — может, сам ID */ }
  if (!id && /^(PL|OL|RD|UU|FL)[A-Za-z0-9_-]{10,62}$/.test(s)) id = s;
  return /^[A-Za-z0-9_-]{10,64}$/.test(id) ? id : '';
}

const walk = (o, key, out = []) => {
  if (Array.isArray(o)) for (const x of o) walk(x, key, out);
  else if (o && typeof o === 'object') {
    for (const [k, v] of Object.entries(o)) {
      if (k === key) out.push(v);
      walk(v, key, out);
    }
  }
  return out;
};

const toMs = t => {
  const p = String(t || '').trim().split(':').map(Number);
  if (!p.length || p.some(n => !Number.isFinite(n))) return null;
  return p.reduce((a, n) => a * 60 + n, 0) * 1000;
};

/* Один элемент списка → ролик или null (плейлист, «показать ещё»…) */
function item(x) {
  const l = x?.lockupViewModel;
  if (l) {
    if (l.contentType && l.contentType !== 'LOCKUP_CONTENT_TYPE_VIDEO') return null;
    const md = l.metadata?.lockupMetadataViewModel;
    const part = md?.metadata?.contentMetadataViewModel?.metadataRows?.[0]?.metadataParts?.[0];
    const badge = walk(l.contentImage, 'thumbnailBadgeViewModel').map(b => b.text).find(t => /^\d+(:\d\d)+$/.test(t || ''));
    if (!l.contentId || !md?.title?.content) return null;
    return { id: l.contentId, title: md.title.content, channel: part?.text?.content || '', ms: toMs(badge) };
  }
  const v = x?.playlistVideoRenderer;
  if (v?.videoId) {
    return { id: v.videoId, title: v.title?.runs?.[0]?.text || v.title?.simpleText || '',
             channel: v.shortBylineText?.runs?.[0]?.text || '', ms: v.lengthSeconds ? +v.lengthSeconds * 1000 : null };
  }
  return null;
}

/* Ролики и токен продолжения из куска списка */
export function parseItems(list) {
  const videos = [];
  let token = null;
  for (const x of list || []) {
    const v = item(x);
    if (v) videos.push(v);
    const c = x?.continuationItemViewModel?.continuationCommand || x?.continuationItemRenderer?.continuationEndpoint;
    const t = walk(c, 'token')[0];
    if (t) token = t;
  }
  return { videos, token };
}

/* Первая страница: название и первый кусок списка. Список роликов —
   первый itemSectionRenderer вкладки; во втором куске страницы лежат
   похожие плейлисты, их не трогаем. */
export function parsePage(html) {
  const m = html.match(/var ytInitialData\s*=\s*(\{.*?\});\s*<\/script>/s);
  if (!m) return null;
  const data = JSON.parse(m[1]);
  const meta = data.metadata?.playlistMetadataRenderer;
  if (!meta) return null;
  const tab = data.contents?.twoColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content;
  const section = walk(tab, 'itemSectionRenderer')[0];
  const plv = walk(tab, 'playlistVideoListRenderer')[0];
  const list = plv?.contents || section?.contents || [];
  const version = (html.match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/) || [])[1] || '2.20261029.01.00';
  return { name: meta.title || '', version, ...parseItems(list) };
}

async function get(url, init, fetchImpl) {
  const r = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  // несуществующий и закрытый плейлист YouTube отдаёт как 404
  if (r.status === 404) throw new Error(CLOSED);
  if (!r.ok) throw new Error(`YouTube ${new URL(url).pathname}: HTTP ${r.status}`);
  return r;
}

/* Все ролики открытого плейлиста. */
export async function fetchYoutubePlaylist(id, { fetchImpl = fetch } = {}) {
  const html = await (await get(`https://www.youtube.com/playlist?list=${encodeURIComponent(id)}&hl=en`,
    { headers: HEADERS }, fetchImpl)).text();
  const first = parsePage(html);
  if (!first) throw new Error(CLOSED);
  const videos = [...first.videos];
  let token = first.token;
  for (let n = 0; token && n < MAX_PAGES; n++) {
    const r = await get('https://www.youtube.com/youtubei/v1/browse?prettyPrint=false', {
      method: 'POST',
      headers: { ...HEADERS, 'content-type': 'application/json' },
      body: JSON.stringify({ context: { client: { clientName: 'WEB', clientVersion: first.version, hl: 'en', gl: 'US' } },
                             continuation: token })
    }, fetchImpl);
    const j = await r.json();
    const list = (j.onResponseReceivedActions || []).flatMap(a => a.appendContinuationItemsAction?.continuationItems || []);
    const page = parseItems(list);
    videos.push(...page.videos);
    token = page.token;
  }
  // один ролик бывает в плейлисте дважды — для сверки это один трек
  const seen = new Set();
  const tracks = videos.filter(v => !seen.has(v.id) && seen.add(v.id));
  return { name: first.name, total: tracks.length, tracks };
}
