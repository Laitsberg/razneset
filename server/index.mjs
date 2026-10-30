/* Запуск сервера. На Railway порт приходит в переменной PORT.
   ALLOW_ORIGIN — с какого сайта браузеру можно читать ответы
   (по умолчанию с любого: данные и так публичные). */
import http from 'node:http';
import { makeApp } from './app.mjs';
import { genresForSpotify } from '../lib/mbgenres.mjs';
import { fetchPlaylist, playlistId, anonToken, queryHashes, hashSource } from '../lib/spotify.mjs';
import { fetchYoutubePlaylist, youtubePlaylistId } from '../lib/youtube.mjs';

const app = makeApp({
  fetchPlaylist,
  playlistId,
  fetchYoutube: id => fetchYoutubePlaylist(id),
  youtubeId: youtubePlaylistId,
  genresFor: ids => genresForSpotify(ids),
  allowOrigin: process.env.ALLOW_ORIGIN || '*',
  status: async () => {
    const token = await anonToken();
    const hashes = await queryHashes();
    return { token: token ? 'есть' : 'нет', hashesFrom: hashSource(), hashes };
  }
});

const port = +process.env.PORT || 3000;
http.createServer((req, res) => {
  app(req, res).catch(e => {
    console.error(e);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
}).listen(port, () => console.log(`razneset: слушаю порт ${port}`));
