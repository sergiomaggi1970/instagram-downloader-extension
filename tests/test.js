'use strict';
// Rode com: node tests/test.js
const assert = require('node:assert/strict');
const bg = require('../background.js');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    console.error(`  FAIL ${name}\n       ${e.message}`);
    process.exitCode = 1;
  }
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
function mediaIdToShortcode(id) {
  let n = BigInt(id);
  let s = '';
  while (n > 0n) {
    s = ALPHABET[Number(n % 64n)] + s;
    n /= 64n;
  }
  return s.padStart(11, 'A');
}

console.log('shortcode → media_id');
test('pares conhecidos', () => {
  assert.equal(bg.shortcodeToMediaId('AAAAAAAAAAB'), '1');
  assert.equal(bg.shortcodeToMediaId('AAAAAAAAAAA'), '0');
  assert.equal(bg.shortcodeToMediaId('BAAAAAAAAAA'), (64n ** 10n).toString());
  assert.equal(bg.shortcodeToMediaId('AAAAAAAAA-_'), String(62 * 64 + 63));
});
test('ida e volta com ids grandes (acima de 2^53, exige BigInt)', () => {
  for (const id of ['3123456789012345678', '2900000000000000001', '1234567890123456789']) {
    const code = mediaIdToShortcode(id);
    assert.equal(code.length, 11);
    assert.equal(bg.shortcodeToMediaId(code), id);
  }
});
test('usa só os 11 primeiros caracteres', () => {
  assert.equal(bg.shortcodeToMediaId('AAAAAAAAAABxyzQQ'), '1');
});
test('caractere inválido → Link não reconhecido', () => {
  assert.throws(() => bg.shortcodeToMediaId('AAAA!AAAAAA'), { message: bg.MSG.INVALID });
});

console.log('URLs');
test('reel com parâmetros utm/igsh', () => {
  const r = bg.parseInstagramUrl('https://www.instagram.com/reel/CwAbC123xyZ/?utm_source=ig_web_copy_link&igsh=MWx4');
  assert.deepEqual(r, {
    type: 'media', kind: 'reel', shortcode: 'CwAbC123xyZ',
    normalized: 'https://www.instagram.com/reel/CwAbC123xyZ/',
  });
});
test('/reels/, /p/, /tv/ e prefixo de usuário', () => {
  assert.equal(bg.parseInstagramUrl('https://www.instagram.com/reels/CwAbC123xyZ/').kind, 'reel');
  assert.equal(bg.parseInstagramUrl('https://www.instagram.com/p/CwAbC123xyZ').kind, 'p');
  assert.equal(bg.parseInstagramUrl('https://instagram.com/tv/CwAbC123xyZ/').kind, 'tv');
  assert.equal(bg.parseInstagramUrl('https://www.instagram.com/fulano/reel/CwAbC123xyZ/').shortcode, 'CwAbC123xyZ');
});
test('story já traz o media_id', () => {
  const r = bg.parseInstagramUrl('https://www.instagram.com/stories/fulano_x/3123456789012345678/?igsh=abc');
  assert.deepEqual(r, {
    type: 'story', username: 'fulano_x', mediaId: '3123456789012345678',
    normalized: 'https://www.instagram.com/stories/fulano_x/3123456789012345678/',
  });
});
test('inválidos', () => {
  for (const bad of ['', 'abc', 'https://example.com/reel/CwAbC123xyZ/', 'https://www.instagram.com/', 'https://www.instagram.com/fulano/', 'https://www.instagram.com/stories/highlights/17900000000/']) {
    assert.equal(bg.parseInstagramUrl(bad), null, bad);
  }
});
test('lista: ignora vazias e comentários (#)', () => {
  assert.deepEqual(bg.parseLinks('  a \n\n# b\r\n c'), ['a', 'c']);
});

console.log('Seleção de mídia e nomes');
const v = (w, url) => ({ width: w, height: w * 2, url });
const reel = { code: 'X', user: { username: 'fulano' }, media_type: 2, video_versions: [v(480, 'https://c/a.mp4'), v(1080, 'https://c/b.mp4'), v(720, 'https://c/c.mp4')], image_versions2: { candidates: [v(100, 'https://c/t.jpg')] } };
const carousel = {
  media_type: 8,
  carousel_media: [
    { image_versions2: { candidates: [v(320, 'https://c/s.jpg'), v(1080, 'https://c/l.jpg?x=1')] } },
    { video_versions: [v(720, 'https://c/v.mp4')], image_versions2: { candidates: [v(720, 'https://c/vt.jpg')] } },
    { image_versions2: { candidates: [v(1080, 'https://c/p.webp')] } },
  ],
};
const photo = { media_type: 1, image_versions2: { candidates: [v(640, 'https://c/a.jpg'), v(1440, 'https://c/b.jpg')] } };

test('reel: vídeo de maior largura', () => {
  const m = bg.collectMedia(reel);
  assert.equal(m.length, 1);
  assert.equal(m[0].url, 'https://c/b.mp4');
  assert.deepEqual(bg.buildFilenames(m, 'fulano', 'CwAbC123xyZ'), ['Instagram/fulano - CwAbC123xyZ.mp4']);
});
test('carrossel: vídeos e imagens, sufixo _1.._n', () => {
  const m = bg.collectMedia(carousel);
  assert.deepEqual(m.map((x) => [x.kind, x.url]), [['image', 'https://c/l.jpg?x=1'], ['video', 'https://c/v.mp4'], ['image', 'https://c/p.webp']]);
  assert.deepEqual(bg.buildFilenames(m, 'fulano', 'CODE'), ['Instagram/fulano - CODE_1.jpg', 'Instagram/fulano - CODE_2.mp4', 'Instagram/fulano - CODE_3.webp']);
});
test('foto única: maior resolução', () => {
  assert.equal(bg.collectMedia(photo)[0].url, 'https://c/b.jpg');
});
test('story (nome usa o media_id)', () => {
  const story = { user: { username: 'fulano' }, video_versions: [v(720, 'https://c/s.mp4')] };
  const m = bg.collectMedia(story);
  assert.deepEqual(bg.buildFilenames(m, 'fulano', '3123456789012345678'), ['Instagram/fulano - 3123456789012345678.mp4']);
});
test('sem mídia → lista vazia', () => assert.deepEqual(bg.collectMedia({}), []));

console.log('Nomes de arquivo');
test('acentos preservados, emojis e inválidos removidos', () => {
  assert.equal(bg.sanitizeFilename('José 🎉: ação/?'), 'José ação');
  assert.equal(bg.sanitizeFilename('a<b>c|d"e\\f*g'), 'abcdefg');
  assert.equal(bg.sanitizeFilename('👨‍👩‍👧 família ❤️ 🇧🇷'), 'família');
});
test('normaliza NFD → NFC', () => {
  assert.equal(bg.sanitizeFilename('José'), 'José');
});
test('sem path traversal, pontos finais, nomes reservados, vazio', () => {
  assert.equal(bg.sanitizeFilename('../../etc'), 'etc');
  assert.equal(bg.sanitizeFilename('nome...'), 'nome');
  assert.equal(bg.sanitizeFilename('CON'), '_CON');
  assert.equal(bg.sanitizeFilename('🎉🎉'), 'instagram');
});
test('nome com emoji/acento vira caminho válido', () => {
  const f = bg.buildFilenames([{ ext: 'mp4' }], 'maría_🎉', 'Cw/AbC');
  assert.deepEqual(f, ['Instagram/maría_ - CwAbC.mp4']);
});

console.log('Respostas da API (inclui sem login)');
const ok = JSON.stringify({ items: [reel] });
test('200 com JSON válido', () => assert.equal(bg.parseInfoResponse(200, ok, 'https://www.instagram.com/api/v1/media/1/info/').user.username, 'fulano'));
test('401/403 → login', () => {
  for (const s of [401, 403]) assert.throws(() => bg.parseInfoResponse(s, '{}'), { code: 'auth', message: bg.MSG.LOGIN });
});
test('HTML da página de login → login', () => {
  assert.throws(() => bg.parseInfoResponse(200, '<!DOCTYPE html><html>Login • Instagram</html>'), { code: 'auth' });
});
test('redirecionado para /accounts/login → login', () => {
  assert.throws(() => bg.parseInfoResponse(200, ok, 'https://www.instagram.com/accounts/login/?next=/api'), { code: 'auth' });
});
test('login_required no JSON → login', () => {
  assert.throws(() => bg.parseInfoResponse(200, '{"message":"login_required","require_login":true}'), { code: 'auth' });
});
test('404 → apagado/privado; 429 → muitas requisições', () => {
  assert.throws(() => bg.parseInfoResponse(404, ''), { code: 'notfound', message: bg.MSG.NOT_FOUND });
  assert.throws(() => bg.parseInfoResponse(429, ''), { code: 'rate', message: bg.MSG.RATE });
});
test('items vazio → apagado/privado', () => {
  assert.throws(() => bg.parseInfoResponse(200, '{"items":[]}'), { code: 'notfound' });
});

console.log('Auto-teste embutido');
test('runSelfTest() do background.js', () => {
  const r = bg.runSelfTest();
  assert.ok(r.length > 0 && r.every((x) => x.ok), JSON.stringify(r.filter((x) => !x.ok)));
});

console.log(`\n${passed} teste(s) passaram${process.exitCode ? ' — HÁ FALHAS' : ''}`);
