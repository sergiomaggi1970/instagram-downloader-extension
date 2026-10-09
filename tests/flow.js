'use strict';
// Fluxo completo do background com chrome/fetch simulados:
// lista mista IG + X, fallback pela página do X, 429 por plataforma e regressão do Instagram.
// Rode com: node tests/flow.js
import assert from 'node:assert/strict';

/* ---------- mundo simulado ---------- */
const logs = [];
const downloads = [];
const closedTabs = [];
let messageHandler;
let tabSeq = 100;
let captureForTab = () => null; // (url) => payload|null  — o que a página do X "enviaria"

const v = (w, url) => ({ width: w, height: w * 2, url });
const igCarousel = {
  user: { username: 'fulano' },
  carousel_media: [
    { image_versions2: { candidates: [v(320, 'https://cdn/s.jpg'), v(1080, 'https://cdn/l.jpg')] } },
    { video_versions: [v(480, 'https://cdn/v1.mp4'), v(1080, 'https://cdn/v2.mp4')] },
  ],
};
const igReel = { user: { username: 'fulano' }, video_versions: [v(480, 'https://cdn/r1.mp4'), v(1080, 'https://cdn/r2.mp4')] };

const variants = [
  { bitrate: 256000, content_type: 'video/mp4', url: 'https://video.twimg.com/low.mp4' },
  { bitrate: 2176000, content_type: 'video/mp4', url: 'https://video.twimg.com/high.mp4' },
];
const vid = { type: 'video', video_info: { variants } };
const gif = { type: 'animated_gif', video_info: { variants: [{ bitrate: 0, content_type: 'video/mp4', url: 'https://video.twimg.com/gif.mp4' }] } };
const photo = (n) => ({ type: 'photo', media_url_https: `https://pbs.twimg.com/media/${n}.jpg` });
const T = (user, o) => JSON.stringify({ __typename: 'Tweet', user: { screen_name: user }, ...o });

// id → resposta da syndication
const syndication = {
  '1001': [200, T('ana', { mediaDetails: [vid] })],
  '1002': [200, T('bia', { mediaDetails: [gif] })],
  '1003': [200, T('caio', { mediaDetails: [photo('A'), vid, photo('B')] })],
  '1004': [200, T('duda', { mediaDetails: [], quoted_tweet: { user: { screen_name: 'x' }, mediaDetails: [vid] } })],
  '1005': [404, '<!DOCTYPE html>'], // apagado
  '1006': [200, JSON.stringify({ __typename: 'TweetTombstone', tombstone: {} })], // restrito → página captura
  '1007': [200, T('edu', { text: 'só texto' })],
  '1008': [429, ''],
  '1009': [200, T('fabi', { mediaDetails: [vid] })],
};

globalThis.fetch = async (url) => {
  url = String(url);
  if (url.includes('instagram.com/api/v1/media/')) {
    const item = url.includes('/' + igMediaId.carousel + '/') ? igCarousel : igReel;
    return { status: igMode === '401' ? 401 : 200, url: 'https://www.instagram.com/api', text: async () => (igMode === '401' ? '<html>login</html>' : JSON.stringify({ items: [item] })) };
  }
  const m = url.match(/tweet-result\?id=(\d+)&token=([a-z0-9]+)&lang=pt$/);
  assert.ok(m, 'URL inesperada: ' + url);
  const [status, text] = syndication[m[1]] || [404, ''];
  return { status, text: async () => text };
};
let igMode = 'ok';
import { shortcodeToMediaId } from '../platforms/instagram.js';
const igMediaId = { carousel: shortcodeToMediaId('CwAbC123xyZ') };
// reels usam outro shortcode, para o mock devolver o item certo

const noop = { addListener() {}, removeListener() {} };
globalThis.chrome = {
  runtime: {
    onMessage: { addListener: (f) => (messageHandler = f) },
    sendMessage: async (m) => { if (m.type === 'log') logs.push(m.entry); },
    getPlatformInfo() {},
  },
  storage: { local: { get: async () => ({}), set: async () => {} } },
  tabs: {
    query: async () => [],
    create: async ({ url }) => {
      const id = ++tabSeq;
      const payload = captureForTab(url);
      if (payload) setTimeout(() => messageHandler({ type: 'xCapture', payload }, { tab: { id } }, () => {}), 5);
      return { id, status: 'complete' };
    },
    get: async () => ({ status: 'complete' }),
    remove: async (id) => closedTabs.push(id),
    onUpdated: noop,
  },
  scripting: {
    // com args: consulta do Instagram dentro da aba; sem args: checagem "sem login" do X
    executeScript: async (o) =>
      o.args
        ? [{ result: { status: 200, text: JSON.stringify({ items: [igReel] }), url: 'https://www.instagram.com/api' } }]
        : [{ result: false }],
  },
  downloads: { download: async (o) => { downloads.push(o); return downloads.length; }, search: async () => [{ state: 'complete' }], onChanged: noop },
};

const bg = await import('../background.js');
const x = await import('../platforms/x.js');
bg.configureDelay(0, 0);
x.settings.captureTimeoutMs = 300;
x.settings.graceMs = 50;

async function run(text) {
  logs.length = 0;
  downloads.length = 0;
  closedTabs.length = 0;
  await new Promise((r) => messageHandler({ type: 'start', text }, {}, r));
  for (let i = 0; i < 200; i++) {
    await new Promise((r) => setTimeout(r, 25));
    if (logs.some((l) => /baixado\(s\) · \d+ falha\(s\)/.test(l.text))) break;
  }
  return { files: downloads.map((d) => d.filename), logs: logs.map((l) => `${l.platform ? '[' + l.platform + '] ' : ''}${l.level}: ${l.text}`) };
}
let failed = 0;
async function scenario(name, fn) {
  try { await fn(); console.log('  ok  ', name); } catch (e) { failed++; console.error('  FAIL', name, '\n      ', e.message); }
}

/* ---------- cenários ---------- */
console.log('Lista mista IG + X');
const mixed = await run([
  'https://www.instagram.com/p/CwAbC123xyZ/?igsh=abc',       // carrossel IG
  'https://x.com/ana/status/1001?s=20&t=zz',                 // 1 vídeo
  'https://twitter.com/bia/status/1002/video/1',             // GIF
  'https://mobile.twitter.com/caio/status/1003',             // foto + vídeo + foto
  'https://x.com/i/status/1004',                             // citado com vídeo
  'https://x.com/gone/status/1005',                          // apagado
  'https://x.com/edu/status/1007',                           // sem vídeo
  'https://example.com/nada',                                // inválido
  '# comentário ignorado',
  'https://www.instagram.com/reel/DaReel12345/',             // reel IG 
].join('\n'));

await scenario('nomes e pastas: Instagram/ e X/', () => {
  assert.deepEqual(mixed.files, [
    'Instagram/fulano - CwAbC123xyZ_1.jpg',
    'Instagram/fulano - CwAbC123xyZ_2.mp4',
    'X/ana - 1001.mp4',
    'X/bia - 1002.mp4',
    'X/caio - 1003_1.jpg',
    'X/caio - 1003_2.mp4',
    'X/caio - 1003_3.jpg',
    'X/duda - 1004.mp4',
    'Instagram/fulano - DaReel12345.mp4',
  ]);
});
await scenario('URLs baixadas (maior bitrate / ?name=orig / maior largura)', () => {
  const urls = downloads.map((d) => d.url);
  assert.ok(urls.includes('https://video.twimg.com/high.mp4'));
  assert.ok(!urls.includes('https://video.twimg.com/low.mp4'));
  assert.ok(urls.includes('https://pbs.twimg.com/media/A.jpg?name=orig'));
  assert.ok(urls.includes('https://cdn/l.jpg') && urls.includes('https://cdn/v2.mp4') && urls.includes('https://cdn/r2.mp4'));
  assert.ok(downloads.every((d) => d.conflictAction === 'uniquify'));
});
await scenario('mensagens de erro e prefixo [IG]/[X]', () => {
  const t = mixed.logs.join('\n');
  assert.match(t, /\[X\] erro: Tweet apagado ou indisponível — https:\/\/x\.com\/gone\/status\/1005/);
  assert.match(t, /\[X\] erro: Tweet sem vídeo — https:\/\/x\.com\/edu\/status\/1007/);
  assert.match(t, /erro: Link não reconhecido — https:\/\/example\.com\/nada/);
  assert.match(t, /\[X\] aviso: Tweet sem mídia própria; baixando o vídeo do tweet citado/);
  assert.match(t, /\[IG\] info: Processando https:\/\/www\.instagram\.com\/p\/CwAbC123xyZ\//);
  assert.match(t, /\[X\] info: Processando https:\/\/x\.com\/ana\/status\/1001/);
  assert.match(t, /6 baixado\(s\) · 3 falha\(s\)/);
});
await scenario('aba do fallback foi fechada (apagado → 1 aba)', () => assert.equal(closedTabs.length, 1));

console.log('Fallback pela página do X');
captureForTab = () => ({
  endpoint: 'single',
  tombstone: false,
  tweets: [{ id: '1006', screenName: 'gui', media: [vid, photo('Z')], quotedId: null }],
});
const fb = await run('https://x.com/gui/status/1006');
await scenario('tweet restrito baixado a partir da captura (vídeo + foto)', () => {
  assert.deepEqual(fb.files, ['X/gui - 1006_1.mp4', 'X/gui - 1006_2.jpg']);
  assert.equal(closedTabs.length, 1);
  assert.match(fb.logs.join('\n'), /tentando pela página do X/);
});
captureForTab = () => ({ endpoint: 'single', tombstone: false, tweets: [{ id: '1006', screenName: 'gui', media: [], quotedId: '77' }, { id: '77', screenName: 'q', media: [vid], quotedId: null }] });
const fbq = await run('https://x.com/gui/status/1006');
await scenario('captura: sem mídia própria usa o tweet citado', () => {
  assert.deepEqual(fbq.files, ['X/gui - 1006.mp4']);
  assert.match(fbq.logs.join('\n'), /tweet citado/);
});
captureForTab = () => null;

console.log('Restrito sem sessão no X');
chrome.scripting.executeScript = async (o) => (o.args ? [] : [{ result: true }]); // página mostra UI de visitante
const noLogin = await run('https://x.com/gui/status/1006');
await scenario('tombstone + visitante → "Conteúdo restrito: faça login no X neste navegador"', () => {
  assert.deepEqual(noLogin.files, []);
  assert.match(noLogin.logs.join('\n'), /\[X\] erro: Conteúdo restrito: faça login no X neste navegador/);
});
const goneLoggedOut = await run('https://x.com/gone/status/1005');
await scenario('apagado (404) continua sendo "apagado" mesmo sem sessão', () =>
  assert.match(goneLoggedOut.logs.join('\n'), /Tweet apagado ou indisponível/));
chrome.scripting.executeScript = async (o) =>
  o.args ? [{ result: { status: 200, text: JSON.stringify({ items: [igReel] }), url: 'https://www.instagram.com/api' } }] : [{ result: false }];

console.log('429 só interrompe a própria plataforma');
const rate = await run(['https://x.com/a/status/1008', 'https://x.com/b/status/1009', 'https://www.instagram.com/reel/DaReel12345/'].join('\n'));
await scenario('429 no X descarta os links do X, o Instagram segue', () => {
  const t = rate.logs.join('\n');
  assert.match(t, /\[X\] erro: Muitas requisições, aguarde alguns minutos/);
  assert.match(t, /\[X\] aviso: Fila interrompida; 1 link\(s\) não processado\(s\)/);
  assert.deepEqual(rate.files, ['Instagram/fulano - DaReel12345.mp4']);
});

console.log('Regressão Instagram');
igMode = '401';
const igFallback = await run(['https://www.instagram.com/reel/DaReel12345/?utm_source=x', 'lixo'].join('\n'));
await scenario('401 direto → fallback na aba do Instagram → baixa igual', () => {
  assert.deepEqual(igFallback.files, ['Instagram/fulano - DaReel12345.mp4']);
  assert.match(igFallback.logs.join('\n'), /1 baixado\(s\) · 1 falha\(s\)/);
});
chrome.scripting.executeScript = async () => [{ result: { status: 401, text: '<html>login</html>', url: 'https://www.instagram.com/accounts/login/' } }];
const igNoLogin = await run(['https://www.instagram.com/reel/DaReel12345/', 'https://www.instagram.com/p/CxYyYyYyYyY/', 'lixo'].join('\n'));
await scenario('sem login: erro claro e fila do Instagram interrompida (como antes)', () => {
  assert.deepEqual(igNoLogin.files, []);
  const t = igNoLogin.logs.join('\n');
  assert.match(t, /\[IG\] erro: Faça login no Instagram neste navegador/);
  assert.match(t, /\[IG\] aviso: Fila interrompida; 2 link\(s\) não processado\(s\)/);
  assert.match(t, /0 baixado\(s\) · 1 falha\(s\)/);
});

console.log(failed ? `\n${failed} cenário(s) com falha` : '\nfluxo OK');
process.exit(failed ? 1 : 0);
