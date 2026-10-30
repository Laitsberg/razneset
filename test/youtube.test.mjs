import { test } from 'node:test';
import assert from 'node:assert/strict';
import { youtubePlaylistId, parsePage, parseItems, fetchYoutubePlaylist } from '../lib/youtube.mjs';

test('ссылка на плейлист YouTube → ID', () => {
  const id = 'PLZN_exA7d4RVmCQrG5VlWIjMOkMFZVVOc';
  assert.equal(youtubePlaylistId(`https://www.youtube.com/playlist?list=${id}`), id);
  assert.equal(youtubePlaylistId(`https://music.youtube.com/playlist?list=${id}&si=x`), id);
  assert.equal(youtubePlaylistId(`https://youtu.be/dQw4w9WgXcQ?list=${id}`), id);
  assert.equal(youtubePlaylistId(id), id);
  assert.equal(youtubePlaylistId('OLAK5uy_kXyz1234567890abcdefg'), 'OLAK5uy_kXyz1234567890abcdefg');
  // «Смотреть позже», «Понравившиеся» и просто ролик без плейлиста — не плейлист
  assert.equal(youtubePlaylistId('https://www.youtube.com/playlist?list=WL'), '');
  assert.equal(youtubePlaylistId('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), '');
  assert.equal(youtubePlaylistId('просто текст'), '');
});

/* Кусок разметки в том виде, в каком его отдаёт YouTube (30.10.2026) */
const lockup = (id, title, channel, len, type = 'LOCKUP_CONTENT_TYPE_VIDEO') => ({ lockupViewModel: {
  contentId: id, contentType: type,
  contentImage: { thumbnailViewModel: { overlays: [{ thumbnailBottomOverlayViewModel: { badges: [
    { thumbnailBadgeViewModel: { text: len } }] } }] } },
  metadata: { lockupMetadataViewModel: { title: { content: title }, metadata: { contentMetadataViewModel: {
    metadataRows: [{ metadataParts: [{ text: { content: channel } }] }] } } } }
} });
const more = token => ({ continuationItemViewModel: { continuationCommand: { innertubeCommand: {
  continuationCommand: { token, request: 'CONTINUATION_REQUEST_TYPE_BROWSE' } } } } });
const page = (items, extra = {}) => '<script>var ytInitialData = ' + JSON.stringify({
  metadata: { playlistMetadataRenderer: { title: 'Мой рок' } },
  contents: { twoColumnBrowseResultsRenderer: { tabs: [{ tabRenderer: { content: { sectionListRenderer: { contents: [
    { itemSectionRenderer: { contents: items } },
    // похожие плейлисты — во втором куске; их брать нельзя
    { itemSectionRenderer: { contents: [lockup('PLother', 'Чужой плейлист', 'кто-то', '', 'LOCKUP_CONTENT_TYPE_PLAYLIST')] } },
    more('ПОХОЖИЕ')
  ] } } } }] } }, ...extra
}) + ';</script><script>"INNERTUBE_CLIENT_VERSION":"2.20261029.01.00"</script>';

test('страница плейлиста: ролики, длительность, токен продолжения', () => {
  const p = parsePage(page([lockup('aaaaaaaaaaa', 'Queen - Somebody To Love (Official Video)', 'Queen Official', '5:10'),
                            lockup('bbbbbbbbbbb', 'Long', 'X', '1:02:03'), more('ДАЛЬШЕ')]));
  assert.equal(p.name, 'Мой рок');
  assert.deepEqual(p.videos, [
    { id: 'aaaaaaaaaaa', title: 'Queen - Somebody To Love (Official Video)', channel: 'Queen Official', ms: 310_000 },
    { id: 'bbbbbbbbbbb', title: 'Long', channel: 'X', ms: 3_723_000 }
  ]);
  assert.equal(p.token, 'ДАЛЬШЕ');
  assert.equal(p.version, '2.20261029.01.00');
});

test('старая разметка (playlistVideoRenderer) тоже читается', () => {
  const { videos } = parseItems([{ playlistVideoRenderer: { videoId: 'ccccccccccc', title: { runs: [{ text: 'Song' }] },
    shortBylineText: { runs: [{ text: 'Chan' }] }, lengthSeconds: '200' } }]);
  assert.deepEqual(videos, [{ id: 'ccccccccccc', title: 'Song', channel: 'Chan', ms: 200_000 }]);
});

test('в списке только ролики: плейлист или канал среди них не трек', () => {
  const { videos } = parseItems([lockup('PLother000000', 'Подборка', 'кто-то', '', 'LOCKUP_CONTENT_TYPE_PLAYLIST'),
                                 lockup('ddddddddddd', 'Song', 'Chan', '3:00')]);
  assert.deepEqual(videos.map(v => v.id), ['ddddddddddd']);
});

test('плейлист целиком: продолжение, повторы склеены, закрытый — понятная ошибка', async () => {
  const calls = [];
  const fake = async (url, init) => {
    calls.push(url);
    if (url.includes('list=PLclosed')) return { ok: false, status: 404 };
    if (url.includes('/playlist?')) return { ok: true, status: 200, text: async () =>
      page([lockup('aaaaaaaaaaa', 'A', 'x', '3:00'), more('T1')]) };
    const { continuation } = JSON.parse(init.body);
    const items = continuation === 'T1' ? [lockup('bbbbbbbbbbb', 'B', 'x', '3:00'), lockup('aaaaaaaaaaa', 'A', 'x', '3:00'), more('T2')]
                                        : [lockup('ccccccccccc', 'C', 'x', '3:00')];
    return { ok: true, status: 200, json: async () => ({ onResponseReceivedActions: [{ appendContinuationItemsAction: { continuationItems: items } }] }) };
  };
  const pl = await fetchYoutubePlaylist('PLtest1234567890', { fetchImpl: fake });
  assert.equal(pl.name, 'Мой рок');
  assert.deepEqual(pl.tracks.map(t => t.id), ['aaaaaaaaaaa', 'bbbbbbbbbbb', 'ccccccccccc']);
  assert.equal(pl.total, 3);
  assert.equal(calls.filter(u => u.includes('/browse')).length, 2);
  await assert.rejects(fetchYoutubePlaylist('PLclosed', { fetchImpl: fake }), /не найден или закрыт/);
});
