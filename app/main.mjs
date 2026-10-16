/* ============================================================
   ПРИЛОЖЕНИЕ «ЧТО РАЗНЕСУТ?»
   ------------------------------------------------------------
   Треки плейлиста берём у своего сервера на Railway (у Spotify
   напрямую браузеру не дают анонимный токен), модель — отсюда же,
   с GitHub Pages. Сам прогноз считается здесь, в телефоне, тем же
   кодом, что проверялся по истории (lib/predict.mjs).
   ============================================================ */
import { indexModel, splitLibrary } from '../lib/predict.mjs';
import { playlistId } from '../lib/spotify.mjs';

const SERVER = 'https://server-production-ae29.up.railway.app';
const MODEL_URL = 'data/model.json';
const PAGE = 100;   // строк за раз: полторы тысячи разом телефон рисует секунды

// Хранилище браузера может быть недоступно (приватное окно, запрет
// сайтов) — тогда просто ничего не помним, а не падаем.
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
  del(k) { try { localStorage.removeItem(k); } catch { /* нечего */ } }
};
const K_URL = 'razneset.playlist';     // ссылка, которую человек дал
const K_LAST = 'razneset.last';        // последний загруженный плейлист

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

let ix = null;            // модель с индексами
let pl = null;            // { id, name, total, tracks, at }
let res = null;           // { rated, todo, dropped }
const view = { tab: 'todo', filter: 'all', q: '', shown: PAGE };

/* ---------- экраны ---------- */
function show(which) {
  for (const id of ['boot', 'start', 'loading', 'result']) $(id).hidden = id !== which;
  document.body.classList.toggle('compact', which === 'result');
}

function startScreen(err = '') {
  show('start');
  $('formErr').textContent = err;
  $('formErr').hidden = !err;
  $('url').value = store.get(K_URL) || '';
}

/* ---------- данные ---------- */
async function loadModel() {
  const r = await fetch(MODEL_URL);
  if (!r.ok) throw new Error('архив оценок не загрузился (' + r.status + ')');
  return indexModel(await r.json());
}

async function fetchPlaylist(id) {
  let r;
  try {
    r = await fetch(`${SERVER}/playlist?id=${encodeURIComponent(id)}`);
  } catch {
    throw new Error('Сервер не отвечает. Проверь интернет и попробуй ещё раз.');
  }
  let body = null;
  try { body = await r.json(); } catch { /* не JSON — значит, не наш сервер ответил */ }
  if (!r.ok) throw new Error(body?.error || `Сервер ответил ошибкой ${r.status}.`);
  return { ...body, at: Date.now() };
}

/* Открыть плейлист. quiet — фоновое обновление при входе: уже показан
   сохранённый результат, и ошибку надо показать плашкой, а не выкидывать
   человека на экран ввода ссылки. */
async function open(input, { quiet = false } = {}) {
  const id = playlistId(input);
  if (!id) return startScreen('Это не похоже на ссылку на плейлист Spotify. Нужна ссылка вида open.spotify.com/playlist/…');
  if (!quiet) show('loading');
  $('refresh').disabled = true;
  try {
    const fresh = await fetchPlaylist(id);
    store.set(K_URL, input);
    // 10 000 треков — пара мегабайт; не влезет в хранилище — не беда,
    // просто в следующий раз придётся подождать загрузки
    store.set(K_LAST, fresh);
    $('banner').hidden = true;
    setPlaylist(fresh, { keepView: quiet });
  } catch (e) {
    if (quiet && pl && pl.id === id) {
      $('banner').textContent = `Не удалось обновить: ${e.message} Показан список от ${when(pl.at)}.`;
      $('banner').hidden = false;
    } else {
      startScreen(e.message);
    }
  } finally {
    $('refresh').disabled = false;
  }
}

function setPlaylist(p, { keepView = false } = {}) {
  pl = p;
  res = splitLibrary(ix, p.tracks);
  // поиск заранее: на каждую букву в поле пересчитывать дорого
  for (const x of [...res.todo, ...res.rated]) {
    x.hay = (x.track.title + ' ' + x.track.artists.map(a => a.name).join(' ')).toLowerCase();
  }
  if (!keepView) Object.assign(view, { tab: 'todo', filter: 'all', q: '', shown: PAGE });
  $('q').value = view.q;
  show('result');
  render();
}

/* ---------- подписи ---------- */
const plural = (n, one, few, many) => {
  const a = n % 10, b = n % 100;
  if (a === 1 && b !== 11) return one;
  if (a >= 2 && a <= 4 && (b < 12 || b > 14)) return few;
  return many;
};
const num = n => n.toLocaleString('ru-RU');
const mmss = ms => ms == null ? '' :
  `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
// дата эфира как в таблице: «15.10.26»
const shortDate = d => d ? `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(2, 4)}` : '';
function when(t) {
  const d = new Date(t);
  const today = new Date().toDateString() === d.toDateString();
  return today
    ? 'сегодня в ' + d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
}
const colorOf = label => ix.model.scale.find(s => s.label === label)?.c || '#A0A0A8';
const pill = (label, cls = '', extra = '') =>
  `<span class="rate ${cls}" style="--c:${esc(colorOf(label))}"><i></i>${esc(label)}${extra}</span>`;
const trackLink = t =>
  `<a class="name" href="https://open.spotify.com/track/${esc(t.id)}" target="_blank" rel="noopener">${esc(t.title)}</a>`;
const who = t => `<div class="who">${esc(t.artists.map(a => a.name).join(', '))}</div>`;

/* ---------- отрисовка ---------- */
function rowTodo(x) {
  const t = x.track;
  const known = x.basis.length > 0;
  const dur = x.long
    ? `<span class="meta dur long">${mmss(t.ms)}<b>доплата</b></span>`
    : `<span class="meta dur">${mmss(t.ms)}</span>`;
  return `<li class="row">${pill(x.label, known ? '' : 'guess', known ? '' : ' <small>≈ новичок</small>')}${dur}` +
    `${trackLink(t)}${who(t)}<div class="why">${esc(x.why)}</div></li>`;
}

function rowRated(x) {
  const t = x.track, [last, ...older] = x.ratings;
  const stream = last.s != null ? `стрим №${last.s}` : '';
  const also = older.length
    ? `<div class="also">Ещё разносили: ${older.map(o => `${esc(o.l)}${o.s != null ? ` (№${o.s})` : ''}`).join(', ')}</div>`
    : '';
  return `<li class="row">${pill(last.l)}<span class="meta">${esc(stream)}${last.d ? '<br>' + shortDate(last.d) : ''}</span>` +
    `${trackLink(t)}${who(t)}${also}</li>`;
}

function currentList() {
  let list = view.tab === 'todo' ? res.todo : res.rated;
  if (view.tab === 'todo' && view.filter === 'known') list = list.filter(x => x.basis.length);
  const q = view.q.trim().toLowerCase();
  if (q) list = list.filter(x => x.hay.includes(q));
  return list;
}

function render() {
  const m = ix.model;
  $('plName').textContent = pl.name || 'Плейлист';
  $('plMeta').textContent = `${num(pl.tracks.length)} ${plural(pl.tracks.length, 'трек', 'трека', 'треков')} · обновлено ${when(pl.at)}`;

  $('nTodo').textContent = num(res.todo.length);
  $('nRated').textContent = num(res.rated.length);
  $('tabTodo').setAttribute('aria-selected', view.tab === 'todo');
  $('tabRated').setAttribute('aria-selected', view.tab === 'rated');
  $('nKnown').textContent = num(res.todo.filter(x => x.basis.length).length);
  for (const b of $('chips').querySelectorAll('button')) b.setAttribute('aria-pressed', b.dataset.f === view.filter);
  $('chips').hidden = view.tab !== 'todo';

  const d = res.dropped;
  const parts = [];
  if (d.short) parts.push(`${num(d.short)} короче 2:00`);
  if (d.version) parts.push(`${num(d.version)} ${plural(d.version, 'минусовка или караоке', 'минусовки или караоке', 'минусовок или караоке')}`);
  if (d.dup) parts.push(`${num(d.dup)} ${plural(d.dup, 'дубль', 'дубля', 'дублей')}`);
  $('hidden').textContent = view.tab === 'todo' && parts.length ? 'Не показаны: ' + parts.join(', ') + '.' : '';
  $('hidden').hidden = !$('hidden').textContent;

  const list = currentList();
  const slice = list.slice(0, view.shown);
  $('list').innerHTML = slice.map(view.tab === 'todo' ? rowTodo : rowRated).join('');
  const left = list.length - slice.length;
  $('more').hidden = left <= 0;
  $('more').textContent = `Показать ещё ${num(Math.min(PAGE, left))} из ${num(left)}`;

  $('empty').hidden = list.length > 0;
  $('empty').textContent = view.q
    ? 'Ничего не нашлось.'
    : view.tab === 'rated'
      ? 'Ни один трек из этого плейлиста ещё не разносили.'
      : 'Здесь пусто: всё из плейлиста уже разнесли или скрыто фильтрами.';

  // объяснение — с цифрами из модели, а не вписанными руками
  const newbie = scaleLabel(m.newMean);
  $('howText').innerHTML = `
    <p>Берём все разносы артиста в архиве и их среднюю оценку. Чем меньше у артиста разносов, тем сильнее прогноз
    подтянут к тому, как в среднем оценивают новичков — артистов, которых приносят впервые: <b>${esc(newbie)}</b>.
    У трека с несколькими артистами их разносы складываются.</p>
    <p>Проверено по истории эфиров: прогноз для каждого трека строили только по тому, что разнесли раньше, и сравнили
    с настоящей оценкой. Для знакомого артиста прогноз в среднем промахивается примерно на полступени.
    Для незнакомого артиста (у таких плашка обведена пунктиром) это просто среднее новичков —
    порядок таких треков между собой ничего не значит.</p>
    <p>Скрыты треки короче 2:00, минусовки, караоке, фортепианные версии и дубли.
    Треки длиннее 6:00 помечены красным: за их разнос доплата.</p>`;
}

const scaleLabel = score => {
  let best = ix.model.scale[0];
  for (const s of ix.model.scale) if (Math.abs(s.score - score) < Math.abs(best.score - score)) best = s;
  return best.label;
};

/* ---------- события ---------- */
function wire() {
  $('form').addEventListener('submit', e => {
    e.preventDefault();
    open($('url').value.trim());
  });
  $('change').addEventListener('click', () => startScreen());
  $('refresh').addEventListener('click', () => open(store.get(K_URL) || pl.id, { quiet: true }));
  $('tabTodo').addEventListener('click', () => { view.tab = 'todo'; view.shown = PAGE; render(); });
  $('tabRated').addEventListener('click', () => { view.tab = 'rated'; view.shown = PAGE; render(); });
  $('chips').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    view.filter = b.dataset.f; view.shown = PAGE; render();
  });
  $('q').addEventListener('input', () => { view.q = $('q').value; view.shown = PAGE; render(); });
  $('more').addEventListener('click', () => { view.shown += PAGE; render(); });

  // установка на Android: Chrome сам предлагает, но кнопка понятнее
  let prompt = null;
  addEventListener('beforeinstallprompt', e => { e.preventDefault(); prompt = e; $('install').hidden = false; });
  $('install').addEventListener('click', async () => {
    if (!prompt) return;
    prompt.prompt();
    await prompt.userChoice;
    prompt = null;
    $('install').hidden = true;
  });
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  $('iosHint').hidden = standalone || !/iPhone|iPad|iPod/.test(navigator.userAgent);
}

/* ---------- старт ---------- */
async function boot() {
  wire();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  try {
    ix = await loadModel();
  } catch (e) {
    $('boot').textContent = 'Не получилось загрузить архив оценок: ' + e.message + '. Обнови страницу.';
    $('boot').classList.add('err');
    return;
  }
  const m = ix.model;
  $('archive').textContent = `Архив по ${shortDate(m.archiveDate)}: ${num(m.rated)} ${plural(m.rated, 'оценка', 'оценки', 'оценок')}.`;

  const saved = store.get(K_URL);
  const last = store.get(K_LAST);
  if (!saved) return startScreen();
  // При каждом открытии плейлист подтягивается заново — новые треки
  // появляются сами. Пока грузится, показываем прошлый результат.
  if (last && last.id === playlistId(saved)) {
    setPlaylist(last);
    open(saved, { quiet: true });
  } else {
    open(saved);
  }
}

boot();
