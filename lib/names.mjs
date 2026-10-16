/* ============================================================
   КЛЮЧИ ДЛЯ СРАВНЕНИЯ ИМЁН И НАЗВАНИЙ
   ------------------------------------------------------------
   Это не «красивое имя», а ключ: две строки про одного артиста
   должны дать одинаковый ключ, даже если сам ключ выглядит странно.
   Поэтому смело режем долгие гласные во всех именах подряд —
   «Soundgarden» превратится в «sondgarden», но так же превратится
   и в архиве, и в Spotify, а значит совпадёт.

   Японские имена — главная беда. Одного человека пишут как
   «Kōji Wada», «Kouji Wada», «Koji Wada», «Wada Kouji» и каной.
   Spotify при запросе без языка отдаёт латиницу («Kenshi Yonezu»,
   а не «米津玄師»), так что кандзи сюда почти не доходят. Кану
   переводим в ромадзи сами, кандзи — нет: для этого нужен словарь
   на десятки мегабайт, а Spotify и так отдаёт их латиницей.
   ============================================================ */

const KANA = {
  あ:'a',い:'i',う:'u',え:'e',お:'o',か:'ka',き:'ki',く:'ku',け:'ke',こ:'ko',
  さ:'sa',し:'shi',す:'su',せ:'se',そ:'so',た:'ta',ち:'chi',つ:'tsu',て:'te',と:'to',
  な:'na',に:'ni',ぬ:'nu',ね:'ne',の:'no',は:'ha',ひ:'hi',ふ:'fu',へ:'he',ほ:'ho',
  ま:'ma',み:'mi',む:'mu',め:'me',も:'mo',や:'ya',ゆ:'yu',よ:'yo',
  ら:'ra',り:'ri',る:'ru',れ:'re',ろ:'ro',わ:'wa',ゐ:'i',ゑ:'e',を:'o',ん:'n',
  が:'ga',ぎ:'gi',ぐ:'gu',げ:'ge',ご:'go',ざ:'za',じ:'ji',ず:'zu',ぜ:'ze',ぞ:'zo',
  だ:'da',ぢ:'ji',づ:'zu',で:'de',ど:'do',ば:'ba',び:'bi',ぶ:'bu',べ:'be',ぼ:'bo',
  ぱ:'pa',ぴ:'pi',ぷ:'pu',ぺ:'pe',ぽ:'po',ゔ:'vu',
  ぁ:'a',ぃ:'i',ぅ:'u',ぇ:'e',ぉ:'o'
};
// маленькие я/ю/ё сливаются с предыдущим слогом: きゃ → kya, しゃ → sha
const SMALL_Y = { ゃ: 'a', ゅ: 'u', ょ: 'o' };

/* Катакану сводим к хирагане: таблица одна, сдвиг в Юникоде ровно 0x60 */
const toHira = s => s.replace(/[ァ-ヶ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60));

export function kanaToRomaji(input) {
  const s = toHira(String(input || ''));
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i], next = s[i + 1];
    if (c === 'っ') {
      // удвоение следующей согласной: がっこう → gakkou
      const r = KANA[next] || '';
      out += r ? r[0] : '';
      continue;
    }
    if (c === 'ー') continue;     // долгий звук — всё равно схлопнем ниже
    let r = KANA[c];
    if (r === undefined) { out += c; continue; }
    if (SMALL_Y[next]) {
      // し+ゃ → sha, ち+ゃ → cha, じ+ゃ → ja, き+ゃ → kya
      r = /^(sh|ch|j)i$/.test(r) ? r.slice(0, -1) + SMALL_Y[next]
                                 : r.slice(0, -1) + 'y' + SMALL_Y[next];
      i++;
    }
    out += r;
  }
  return out;
}

const HAS_KANA = /[぀-ヿ]/;

/* Ключ имени: регистр, диакритика, кана, долгие гласные, знаки. */
export function nameNorm(s) {
  let t = String(s || '').normalize('NFKC').toLowerCase();
  if (HAS_KANA.test(t)) t = kanaToRomaji(t);
  t = t.normalize('NFD').replace(/\p{M}+/gu, '');      // ō → o, é → e
  t = t.replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  // долгие гласные ромадзи: Kouji / Koji / Kōji, Yuuki / Yuki
  t = t.replace(/ou/g, 'o').replace(/oo/g, 'o').replace(/uu/g, 'u');
  return t.replace(/\s+/g, ' ');
}

/* Тот же ключ без учёта порядка слов: «Sawano Hiroyuki» и «Hiroyuki
   Sawano» — один человек. Берётся вторым шагом, когда точный ключ не
   нашёлся: у разных людей переставленные имена почти не встречаются,
   но рисковать на первом шаге незачем. */
export function nameSorted(s) {
  return nameNorm(s).split(' ').sort().join(' ');
}

/* Хвосты в названии, после которых идёт не сама песня, а её версия:
   «- Remastered 2011», «- TV Size», «- From "Chainsaw Man"». */
// Окончания разрешены нарочно: в Spotify пишут «Remastered», «Edited»,
// «Remixed», и без \w* граница слова после «remaster» не срабатывала —
// «Yesterday - Remastered 2009» не узнавался как «Yesterday».
const VERSION_TAIL = /\s[-–—]\s.*\b(remaster\w*|version|ver|edit\w*|\w*mix\w*|live|mono|stereo|from|feat|bonus|tv|size|anniversary|instrumental|acoustic|original|soundtrack|op|ed)\b.*$/i;

/* Ключ названия трека. Скобки любых видов выкидываем целиком: в
   архиве там источник («[OST; Magicka]») и альтернативное название,
   в Spotify — «(feat. …)», «(TV Size)». Японские подзаголовки
   в тильдах тоже: «Innocent ~Mujaki na mama de~» в архиве и
   «Innocent ~無邪気なままで~» в Spotify — одна песня. */
export function titleNorm(s) {
  let t = String(s || '').normalize('NFKC');
  t = t.replace(VERSION_TAIL, '');
  t = t.replace(/\([^)]*\)|\[[^\]]*\]|\{[^}]*\}|<[^>]*>|【[^】]*】|「[^」]*」|~[^~]*~|〜[^〜]*〜/g, ' ');
  // Незакрытая скобка: в архиве бывает «1/6 -out of the gravity-
  // (Vocaliod-P feat. Hatsune Miku — …; Live)», и разбор по длинному
  // тире внутри скобок оставляет от неё только начало. Режем до конца.
  t = t.replace(/\s*[(\[{<【「].*$/, '');
  t = t.replace(/\s(feat\.?|ft\.?|featuring)\s.*$/i, '');
  const k = nameNorm(t).replace(/ /g, '');
  // Если от названия ничего не осталось (всё было в скобках) — берём
  // целиком, иначе все такие треки склеятся в один пустой
  return k || nameNorm(s).replace(/ /g, '');
}

const CJK_CHARS = String.raw`\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}`;
const HAS_CJK = new RegExp(`[${CJK_CHARS}]`, 'u');
const CJK_RUNS = new RegExp(`[${CJK_CHARS}]+`, 'gu');

/* Все ключи названия. Японские релизы в Spotify часто идут с двумя
   названиями сразу: «悲しみがとまらない　I CAN'T STOP THE LONELINESS»,
   а в архив вписывают одно, английское. Поэтому у смешанного названия
   есть второй ключ — его латинская часть, если в ней хотя бы 4 буквы:
   короче («ZOC実験室» → «ZOC») совпадёт с чем попало. */
export function titleKeys(s) {
  const keys = [titleNorm(s)];
  const str = String(s || '');
  if (HAS_CJK.test(str)) {
    const latin = str.replace(CJK_RUNS, ' ');
    const k = titleNorm(latin);
    if ((k.match(/[a-z]/g) || []).length >= 4 && !keys.includes(k)) keys.push(k);
  }
  return keys;
}
