import { test } from 'node:test';
import assert from 'node:assert/strict';
import { kanaToRomaji, nameNorm, nameSorted, titleNorm, titleKeys } from '../lib/names.mjs';
import { isAltVersion } from '../lib/predict.mjs';

test('кана → ромадзи: слоги, маленькие я/ю/ё, удвоение', () => {
  assert.equal(kanaToRomaji('きゃりーぱみゅぱみゅ'), 'kyaripamyupamyu');
  assert.equal(kanaToRomaji('がっこう'), 'gakkou');
  assert.equal(kanaToRomaji('シャイニー'), 'shaini');
  assert.equal(kanaToRomaji('ちゃ じゃ'), 'cha ja');
});

test('японское имя в любой записи — один ключ', () => {
  const k = nameNorm('Kouji Wada');
  assert.equal(nameNorm('Kōji Wada'), k);
  assert.equal(nameNorm('Koji Wada'), k);
  assert.equal(nameNorm('KOUJI  WADA'), k);
  assert.notEqual(nameNorm('Wada Kouji'), k, 'порядок слов точный ключ различает');
  assert.equal(nameSorted('Wada Kouji'), nameSorted('Kōji Wada'), 'а ключ без порядка — нет');
});

test('название: версии и скобки не мешают узнать песню', () => {
  assert.equal(titleNorm('Yesterday - Remastered 2009'), titleNorm('Yesterday'));
  assert.equal(titleNorm('Gurenge (TV Size)'), titleNorm('Gurenge'));
  assert.equal(titleNorm('Innocent ~Mujaki na mama de~'), titleNorm('Innocent ~無邪気なままで~'));
  assert.equal(titleNorm('Keep on keeping on <MODv> (Self-cover)'), titleNorm('Keep on keeping on'));
  // незакрытая скобка из архива
  assert.equal(
    titleNorm('1/6 -out of the gravity- (Vocaliod-P feat. Hatsune Miku — 1/6 -out of the gravity-; Live)'),
    titleNorm('1/6 -out of the gravity- (feat. 初音ミク) - 2019 Live'));
  assert.equal(titleNorm('1,000,000 TIMES feat. chelly (EGOIST)'), titleNorm('1,000,000 TIMES'));
});

test('название целиком в скобках не схлопывается в пустоту', () => {
  assert.notEqual(titleNorm('(Untitled)'), '');
  assert.notEqual(titleNorm('(Untitled)'), titleNorm('(Something Else)'));
});

test('смешанное японско-английское название даёт второй ключ', () => {
  const keys = titleKeys('悲しみがとまらない　I CAN\'T STOP THE LONELINESS');
  assert.ok(keys.includes(titleNorm('I CAN’T STOP THE LONELINESS')));
  // слишком короткая латиница второго ключа не даёт
  assert.equal(titleKeys('ZOC実験室').length, 1);
  assert.equal(titleKeys('Lemon').length, 1);
});

test('минусовки, караоке и фортепианные версии узнаются', () => {
  for (const t of ['ROCKSTAR (Instrumental)', '雲雀 -Instrumental-', 'String Theory - Instrumental',
                   'Song (Inst.)', 'Song -inst-', 'Song (Off Vocal)', 'Song - off vocal ver.',
                   'Song [Piano Version]', 'Song (Piano)', 'Song - Piano', 'Song (Karaoke)',
                   'Song (オリジナル・カラオケ)', 'Song インストゥルメンタル', 'Song (ピアノ ver.)']) {
    assert.ok(isAltVersion(t), t);
  }
});

test('…а обычные песни с похожими словами — нет', () => {
  for (const t of ['Piano Man', 'Instinct', 'Primal Instinct (Live)', 'The Pianist',
                   'Song (Instinct Remix)', 'Wild ~Instinct~', 'Song - Inside Out',
                   'Karma', 'Vocal Lesson', 'ピアノ・レッスン の 歌']) {
    assert.ok(!isAltVersion(t), t);
  }
});
