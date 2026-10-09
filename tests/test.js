'use strict';
// Rode com: node tests/test.js  (ou npm test, que também roda tests/flow.js)
import assert from 'node:assert/strict';
import * as ig from '../platforms/instagram.js';
import * as x from '../platforms/x.js';
import * as tt from '../platforms/tiktok.js';
import { sanitizeFilename, PlatformError } from '../platforms/common.js';
import { detectPlatform, parseLinks } from '../platforms/index.js';

const bg = { ...ig, sanitizeFilename, parseLinks };

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


console.log('X: link e token');
test('token da syndication (valores fixados; o tweet 20 foi confirmado contra o endpoint real)', () => {
  assert.equal(x.syndicationToken('20'), '6dq1a2xwd93');
  assert.equal(x.syndicationToken('1628832338187636740'), '3y54libozsy');
  assert.equal(x.syndicationToken('1'), 'bhi2ay3f28n');
  assert.match(x.syndicationUrl('20'), /tweet-result\?id=20&token=6dq1a2xwd93&lang=pt$/);
});
test('x.com, twitter.com, mobile.twitter.com, /i/status, /video/1, /photo/1, ?s=20&t=', () => {
  const id = '1628832338187636740'; // maior que 2^53: precisa continuar string
  const cases = [
    [`https://x.com/foo/status/${id}`, 'foo'],
    [`https://twitter.com/foo/status/${id}?s=20&t=AbC_dE`, 'foo'],
    [`https://mobile.twitter.com/foo/status/${id}`, 'foo'],
    [`https://x.com/foo/status/${id}/video/1`, 'foo'],
    [`https://x.com/foo/status/${id}/photo/2?s=46`, 'foo'],
    [`https://x.com/i/status/${id}`, null],
    [`https://www.x.com/foo/status/${id}/`, 'foo'],
    [`x.com/foo/status/${id}`, 'foo'],
  ];
  for (const [url, user] of cases) {
    const r = x.parse(url);
    assert.ok(r, url);
    assert.equal(r.id, id, url);
    assert.equal(r.username, user, url);
    assert.equal(r.normalized, `https://x.com/${user || 'i'}/status/${id}`, url);
  }
});
test('links inválidos do X', () => {
  for (const bad of ['', 'https://x.com/foo', 'https://x.com/foo/status/abc', 'https://x.com.evil.com/foo/status/1', 'https://example.com/foo/status/1', 'https://www.instagram.com/reel/CwAbC123xyZ/']) {
    assert.equal(x.parse(bad), null, bad);
  }
});

console.log('X: syndication');
const variants = [
  { content_type: 'application/x-mpegURL', url: 'https://v/x.m3u8' },
  { bitrate: 256000, content_type: 'video/mp4', url: 'https://v/low.mp4' },
  { bitrate: 2176000, content_type: 'video/mp4', url: 'https://v/high.mp4' },
  { bitrate: 832000, content_type: 'video/mp4', url: 'https://v/mid.mp4' },
];
const vid = (u) => ({ type: 'video', video_info: { variants: u || variants } });
const photoD = (n) => ({ type: 'photo', media_url_https: `https://pbs.twimg.com/media/${n}.jpg` });
const synd = (o) => JSON.stringify({ __typename: 'Tweet', id_str: '1', user: { screen_name: 'foo' }, ...o });

test('1 vídeo: mp4 de maior bitrate (ignora m3u8)', () => {
  const r = x.parseSyndication(200, synd({ mediaDetails: [vid()] }));
  assert.equal(r.state, 'ok');
  assert.deepEqual(r.media, [{ kind: 'video', url: 'https://v/high.mp4', ext: 'mp4' }]);
  assert.equal(r.screenName, 'foo');
  assert.equal(r.quoted, false);
});
test('vários vídeos e fotos (fotos com ?name=orig)', () => {
  const r = x.parseSyndication(200, synd({ mediaDetails: [photoD('A'), vid(), photoD('B')] }));
  assert.deepEqual(r.media.map((m) => [m.kind, m.url, m.ext]), [
    ['image', 'https://pbs.twimg.com/media/A.jpg?name=orig', 'jpg'],
    ['video', 'https://v/high.mp4', 'mp4'],
    ['image', 'https://pbs.twimg.com/media/B.jpg?name=orig', 'jpg'],
  ]);
});
test('GIF animado (bitrate 0) vira mp4', () => {
  const gif = { type: 'animated_gif', video_info: { variants: [{ bitrate: 0, content_type: 'video/mp4', url: 'https://v/g.mp4' }] } };
  const r = x.parseSyndication(200, synd({ mediaDetails: [gif] }));
  assert.deepEqual(r.media, [{ kind: 'video', url: 'https://v/g.mp4', ext: 'mp4' }]);
});
test('tweet sem mídia citando outro com vídeo → baixa o do citado (quoted=true)', () => {
  const r = x.parseSyndication(200, synd({ mediaDetails: [], quoted_tweet: { user: { screen_name: 'q' }, mediaDetails: [vid()] } }));
  assert.equal(r.state, 'ok');
  assert.equal(r.quoted, true);
  assert.equal(r.screenName, 'foo'); // nome do arquivo usa o autor do tweet do link
  assert.equal(r.media[0].url, 'https://v/high.mp4');
});
test('sem mídia → nomedia; sensível sem mídia → restricted (confere na página)', () => {
  assert.equal(x.parseSyndication(200, synd({ text: 'oi' })).state, 'nomedia');
  assert.equal(x.parseSyndication(200, synd({ possibly_sensitive: true })).state, 'restricted');
});
test('apagado (404 HTML, {}), tombstone, 429, erro', () => {
  assert.equal(x.parseSyndication(404, '<!DOCTYPE html>').state, 'gone');
  assert.equal(x.parseSyndication(200, '{}').state, 'gone');
  assert.equal(x.parseSyndication(200, JSON.stringify({ __typename: 'TweetTombstone', tombstone: { text: {} } })).state, 'restricted');
  assert.throws(() => x.parseSyndication(429, ''), { code: 'rate', message: 'Muitas requisições, aguarde alguns minutos' });
  assert.equal(x.parseSyndication(500, 'oops').state, 'error');
});

console.log('X: captura da página (fallback)');
const cap = (id, media, extra = {}) => ({ id, screenName: 'foo', media, quotedId: null, ...extra });
test('evaluateCapture: ok, citado, sem mídia, tombstone, indeciso', () => {
  const m = new Map([['1', cap('1', [vid()])]]);
  assert.equal(x.evaluateCapture(m, '1').status, 'ok');
  const q = new Map([['1', cap('1', [], { quotedId: '2' })], ['2', cap('2', [vid()])]]);
  const rq = x.evaluateCapture(q, '1');
  assert.equal(rq.status, 'ok');
  assert.equal(rq.quoted, true);
  assert.equal(x.evaluateCapture(new Map([['1', cap('1', [])]]), '1').status, 'nomedia');
  assert.equal(x.evaluateCapture(new Map(), '1', true).status, 'tombstone');
  assert.equal(x.evaluateCapture(new Map([['9', cap('9', [vid()])]]), '1'), null); // outro tweet da conversa
});

console.log('Roteamento (lista mista)');
test('detecta a plataforma pelo hostname', () => {
  const lines = [
    ['https://www.instagram.com/reel/CwAbC123xyZ/?igsh=1', 'IG'],
    ['https://x.com/foo/status/1628832338187636740?s=20', 'X'],
    ['https://twitter.com/foo/status/20', 'X'],
    ['https://www.instagram.com/stories/foo/3123456789012345678/', 'IG'],
    ['https://example.com/', null],
  ];
  for (const [l, tag] of lines) assert.equal((detectPlatform(l) || {}).platform?.tag ?? null, tag, l);
});
test('autoteste embutido do módulo X', () => {
  assert.ok(x.runSelfTest().every((r) => r.ok));
});


console.log('TikTok');
const ttPage = (detail) =>
  `<html><script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify({ __DEFAULT_SCOPE__: { 'webapp.video-detail': detail } })}</script></html>`;
const bi = (codec, bitrate, url, extra = {}) => ({ CodecType: codec, Bitrate: bitrate, PlayAddr: { UrlList: [url, url + '#2'], Width: 576, ...extra } });
const ttItem = (o = {}) => ({ id: '6718335390845095173', author: { uniqueId: 'scout2015' }, video: { playAddr: 'https://v/play.mp4', bitrateInfo: [bi('h265_hvc1', 3000000, 'https://v/h265.mp4'), bi('h264', 1000000, 'https://v/h264-low.mp4'), bi('h264', 2240963, 'https://v/h264-best.mp4')] }, ...o });

test('links: vídeo, foto, m.tiktok /v/, curtos e parâmetros', () => {
  const id = '6718335390845095173';
  const v = tt.parse(`https://www.tiktok.com/@scout2015/video/${id}?is_from_webapp=1&sender_device=pc`);
  assert.deepEqual(v, { type: 'post', kind: 'video', id, username: 'scout2015', normalized: `https://www.tiktok.com/@scout2015/video/${id}` });
  assert.equal(tt.parse(`https://www.tiktok.com/@a.b_c/photo/${id}`).kind, 'photo');
  assert.equal(tt.parse(`tiktok.com/@scout2015/video/${id}`).id, id);
  const old = tt.parse(`https://m.tiktok.com/v/${id}.html`);
  assert.equal(old.id, id);
  assert.equal(old.username, null);
  assert.equal(old.normalized, `https://www.tiktok.com/@_/video/${id}`);
  assert.deepEqual(tt.parse('https://vm.tiktok.com/ZSabc123/?x=1'), { type: 'short', code: 'ZSabc123', normalized: 'https://vm.tiktok.com/ZSabc123/' });
  assert.equal(tt.parse('https://vt.tiktok.com/ZSabc123').type, 'short');
  assert.equal(tt.parse('https://www.tiktok.com/t/ZTabc123/').normalized, 'https://www.tiktok.com/t/ZTabc123/');
});
test('links inválidos do TikTok', () => {
  for (const bad of ['', 'https://www.tiktok.com/', 'https://www.tiktok.com/@foo', 'https://www.tiktok.com/@foo/video/abc', 'https://tiktok.com.evil.com/@a/video/1', 'https://vm.tiktok.com/', 'https://example.com/@a/video/1']) {
    assert.equal(tt.parse(bad), null, bad);
  }
});
test('página: extrai o item; apagado, privado e verificação (sem JSON)', () => {
  const ok = tt.extractItem(ttPage({ statusCode: 0, itemInfo: { itemStruct: ttItem() } }));
  assert.equal(ok.state, 'ok');
  assert.equal(ok.item.id, '6718335390845095173');
  assert.equal(tt.extractItem(ttPage({ statusCode: 10204, statusMsg: "item doesn't exist" })).state, 'gone');
  assert.equal(tt.extractItem(ttPage({ statusCode: 10222 })).state, 'private');
  assert.equal(tt.extractItem('<html>Verify to continue</html>').state, 'blocked');
  assert.equal(tt.extractItem('<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">{quebrado</script>').state, 'blocked');
  assert.equal(tt.extractItem(ttPage(undefined)).state, 'blocked');
});
test('vídeo: prefere h264 de maior bitrate; sem bitrateInfo usa playAddr/downloadAddr', () => {
  assert.equal(tt.pickVideoUrl(ttItem()), 'https://v/h264-best.mp4');
  const onlyH265 = ttItem({ video: { bitrateInfo: [bi('h265_hvc1', 1, 'https://v/a.mp4'), bi('h265_hvc1', 9, 'https://v/b.mp4')] } });
  assert.equal(tt.pickVideoUrl(onlyH265), 'https://v/b.mp4');
  assert.equal(tt.pickVideoUrl(ttItem({ video: { playAddr: 'https://v/play.mp4' } })), 'https://v/play.mp4');
  assert.equal(tt.pickVideoUrl(ttItem({ video: { playAddr: '', downloadAddr: 'https://v/dl.mp4' } })), 'https://v/dl.mp4');
  assert.equal(tt.pickVideoUrl({ video: {} }), null);
});
test('arquivos: TikTok/{usuario} - {id}.mp4; foto única; várias fotos _1.._n', () => {
  assert.deepEqual(tt.buildFiles(ttItem()).map((f) => f.filename), ['TikTok/scout2015 - 6718335390845095173.mp4']);
  const photos = (n) => ({ id: '77', author: { uniqueId: 'foto' }, imagePost: { images: Array.from({ length: n }, (_, i) => ({ imageURL: { urlList: [`https://p/${i}.webp?x=1`, 'https://p/alt'] } })) } });
  assert.deepEqual(tt.buildFiles(photos(1)).map((f) => f.filename), ['TikTok/foto - 77.webp']);
  assert.deepEqual(tt.buildFiles(photos(3)).map((f) => f.filename), ['TikTok/foto - 77_1.webp', 'TikTok/foto - 77_2.webp', 'TikTok/foto - 77_3.webp']);
  assert.deepEqual(tt.buildFiles({ id: '5', video: { playAddr: 'https://v/p.mp4' } }, 'viaLink').map((f) => f.filename), ['TikTok/viaLink - 5.mp4']);
  assert.deepEqual(tt.buildFiles({ id: '5' }), []);
});
test('roteamento: links do TikTok vão para o módulo certo; 429/verificação são globais', () => {
  assert.equal(detectPlatform('https://vm.tiktok.com/ZSabc123/').platform.tag, 'TT');
  assert.equal(detectPlatform('https://www.tiktok.com/@a/video/1').platform.tag, 'TT');
  assert.equal(tt.isFatal(new PlatformError('rate', '')), true);
  assert.equal(tt.isFatal(new PlatformError('blocked', '')), true);
  assert.equal(tt.isFatal(new PlatformError('notfound', '')), false);
  assert.equal(tt.isFatal(new PlatformError('auth', '')), false); // vídeo privado não derruba os demais
});
test('autoteste embutido do módulo TikTok', () => assert.ok(tt.runSelfTest().every((r) => r.ok)));

console.log('Auto-teste embutido');
test('runSelfTest() do background.js', () => {
  const r = bg.runSelfTest();
  assert.ok(r.length > 0 && r.every((x) => x.ok), JSON.stringify(r.filter((x) => !x.ok)));
});

console.log(`\n${passed} teste(s) passaram${process.exitCode ? ' — HÁ FALHAS' : ''}`);
