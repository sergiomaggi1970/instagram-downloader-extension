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
  if (url.includes('tiktok.com')) return tiktokFetch(url);
  const m = url.match(/tweet-result\?id=(\d+)&token=([a-z0-9]+)&lang=pt$/);
  assert.ok(m, 'URL inesperada: ' + url);
  const [status, text] = syndication[m[1]] || [404, ''];
  return { status, text: async () => text };
};
let igMode = 'ok';

// ---- TikTok simulado ----
const ttPage = (detail) => `<html><script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify({ __DEFAULT_SCOPE__: { 'webapp.video-detail': detail } })}</script></html>`;
const bi = (codec, br, url) => ({ CodecType: codec, Bitrate: br, PlayAddr: { UrlList: [url] } });
const ttVideo = (id, user) => ({ statusCode: 0, itemInfo: { itemStruct: { id, author: { uniqueId: user }, video: { bitrateInfo: [bi('h265_hvc1', 3e6, `https://v16.tiktok.com/${id}-h265.mp4`), bi('h264', 2e6, `https://v16.tiktok.com/${id}-h264.mp4`)] } } } });
const ttPhotos = (id, user) => ({ statusCode: 0, itemInfo: { itemStruct: { id, author: { uniqueId: user }, imagePost: { images: [1, 2].map((n) => ({ imageURL: { urlList: [`https://p16.tiktokcdn.com/${id}-${n}.jpeg?x=1`] } })) } } } });
let ttBlocked = false;
let ttForbidden = false;
let ttFlaky = 0; // quantas respostas 403 seguidas antes de voltar ao normal
let ttTabJson = null; // o que a aba em segundo plano "leria" da página
const tiktokPages = {
  '/@ana/video/7001': [200, ttPage(ttVideo('7001', 'ana'))],
  '/@bia/photo/7002': [200, ttPage(ttPhotos('7002', 'bia'))],
  '/@gone/video/7003': [200, ttPage({ statusCode: 10204 })],
  '/@priv/video/7004': [200, ttPage({ statusCode: 10222 })],
  '/@_/video/7005': [200, ttPage(ttVideo('7005', 'real_user'))], // link antigo m.tiktok.com/v/7005.html
  '/@ok/video/7006': [200, ttPage(ttVideo('7006', 'ok'))],
  '/@rate/video/7007': [429, ''],
  '/t/ZTshort1/': [200, ttPage(ttVideo('7008', 'curto'))],
};
const ttRules = [];
function tiktokFetch(url) {
  const u = new URL(url);
  if (ttFlaky > 0) { ttFlaky--; return { status: 403, text: async () => 'Access Denied' }; }
  if (ttForbidden) return { status: 403, text: async () => '<HTML><H1>Access Denied</H1></HTML>' };
  if (ttBlocked) return { status: 200, text: async () => '<html>Verify to continue</html>' };
  const key = u.hostname === 'vm.tiktok.com' ? '/t' + u.pathname : u.pathname;
  const [status, text] = tiktokPages[key] || [404, ''];
  return { status, text: async () => text };
}
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
  declarativeNetRequest: { updateSessionRules: async (r) => ttRules.push(r) },
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

// restaura o mock do Instagram (os cenários acima o deixaram sem login)
igMode = 'ok';
chrome.scripting.executeScript = async (o) =>
  o.func && o.func.name === 'readRehydrationJson'
    ? [{ result: ttTabJson }]
    : o.args ? [{ result: { status: 200, text: JSON.stringify({ items: [igReel] }), url: 'https://www.instagram.com/api' } }] : [{ result: false }];
const ttSettings = (await import('../platforms/tiktok.js')).settings;
ttSettings.retryDelayMs = 5;
ttSettings.tabPollMs = 5;

console.log('TikTok');
const tt = await run([
  'https://www.tiktok.com/@ana/video/7001?is_from_webapp=1&sender_device=pc',  // vídeo
  'https://www.tiktok.com/@bia/photo/7002',                                    // 2 fotos
  'https://www.tiktok.com/@gone/video/7003',                                   // apagado
  'https://www.tiktok.com/@priv/video/7004',                                   // privado
  'https://m.tiktok.com/v/7005.html',                                          // link antigo
  'https://vm.tiktok.com/ZTshort1/',                                           // link curto
  'https://x.com/ana/status/1001',                                             // misturado com X
  'https://www.instagram.com/reel/DaReel12345/',                               // e Instagram
].join('\n'));
await scenario('nomes na pasta TikTok/ (vídeo h264, fotos _n, link antigo e curto)', () => {
  assert.deepEqual(tt.files, [
    'TikTok/ana - 7001.mp4',
    'TikTok/bia - 7002_1.jpeg',
    'TikTok/bia - 7002_2.jpeg',
    'TikTok/real_user - 7005.mp4',
    'TikTok/curto - 7008.mp4',
    'X/ana - 1001.mp4',
    'Instagram/fulano - DaReel12345.mp4',
  ]);
  const urls = downloads.map((d) => d.url);
  assert.ok(urls.includes('https://v16.tiktok.com/7001-h264.mp4') && !urls.some((u) => u.includes('h265')));
});
await scenario('erros claros e prefixo [TT]', () => {
  const t = tt.logs.join('\n');
  assert.match(t, /\[TT\] info: Processando https:\/\/www\.tiktok\.com\/@ana\/video\/7001\n/);
  assert.match(t, /\[TT\] erro: Vídeo apagado ou indisponível — https:\/\/www\.tiktok\.com\/@gone\/video\/7003/);
  assert.match(t, /\[TT\] erro: Vídeo privado ou restrito: faça login no TikTok neste navegador/);
  assert.match(t, /6 baixado\(s\) · 2 falha\(s\)/);
});
await scenario('regra do Referer instalada (só pedidos fora de abas)', () => {
  const rule = ttRules[0].addRules[0];
  assert.equal(rule.action.requestHeaders[0].header, 'referer');
  assert.equal(rule.action.requestHeaders[0].value, 'https://www.tiktok.com/');
  assert.deepEqual(rule.condition.tabIds, [-1]);
  assert.ok(rule.condition.requestDomains.includes('tiktok.com') && rule.condition.requestDomains.includes('tiktokcdn.com'));
});
const ttRate = await run(['https://www.tiktok.com/@rate/video/7007', 'https://www.tiktok.com/@ok/video/7006', 'https://www.instagram.com/reel/DaReel12345/'].join('\n'));
await scenario('429 no TikTok descarta os links do TikTok; o Instagram segue', () => {
  assert.match(ttRate.logs.join('\n'), /\[TT\] erro: Muitas requisições, aguarde alguns minutos/);
  assert.match(ttRate.logs.join('\n'), /\[TT\] aviso: Fila interrompida; 1 link\(s\)/);
  assert.deepEqual(ttRate.files, ['Instagram/fulano - DaReel12345.mp4']);
});
ttBlocked = true;
const ttBlock = await run('https://www.tiktok.com/@ok/video/7006');
ttBlocked = false;
await scenario('página de verificação → mensagem pedindo para abrir tiktok.com', () =>
  assert.match(ttBlock.logs.join('\n'), /\[TT\] erro: O TikTok pediu verificação: abra tiktok\.com neste navegador/));
ttForbidden = true;
const ttForbid = await run(['https://www.tiktok.com/@ok/video/7006', 'https://www.tiktok.com/@ana/video/7001'].join('\n'));
ttForbidden = false;
await scenario('HTTP 403 do TikTok → mensagem de bloqueio de acesso (não "verificação") e fila do TikTok interrompida', () => {
  const t = ttForbid.logs.join('\n');
  assert.match(t, /\[TT\] erro: O TikTok bloqueou o acesso \(HTTP 403\) a este navegador ou rede/);
  assert.doesNotMatch(t, /pediu verificação/);
  assert.match(t, /\[TT\] aviso: Fila interrompida; 1 link\(s\)/);
  assert.deepEqual(ttForbid.files, []);
});

ttFlaky = 1; // 1ª tentativa direta barrada, a 2ª passa
const ttRetry = await run('https://www.tiktok.com/@ok/video/7006');
await scenario('intermitente: 403 na 1ª tentativa, repete e baixa (sem abrir aba)', () => {
  assert.deepEqual(ttRetry.files, ['TikTok/ok - 7006.mp4']);
  assert.equal(closedTabs.length, 0);
});
ttFlaky = 0;
ttForbidden = true;
ttTabJson = JSON.stringify({ __DEFAULT_SCOPE__: { 'webapp.video-detail': ttVideo('7006', 'ok') } });
const ttViaTab = await run('https://www.tiktok.com/@ok/video/7006');
ttForbidden = false;
ttTabJson = null;
await scenario('barrado nas duas tentativas diretas: lê a página numa aba real e fecha a aba', () => {
  assert.deepEqual(ttViaTab.files, ['TikTok/ok - 7006.mp4']);
  assert.equal(closedTabs.length, 1);
  assert.match(ttViaTab.logs.join('\n'), /1 baixado\(s\) · 0 falha\(s\)/);
});
{
  const real = chrome.downloads.download;
  let calls = 0;
  chrome.downloads.download = async (o) => (++calls === 1 ? undefined : real(o)); // CDN recusa só a 1ª vez
  const ttDl = await run('https://www.tiktok.com/@ok/video/7006');
  chrome.downloads.download = real;
  await scenario('download recusado na 1ª vez: repete uma vez e conclui', () => {
    assert.deepEqual(ttDl.files, ['TikTok/ok - 7006.mp4']);
    assert.match(ttDl.logs.join('\n'), /1 baixado\(s\) · 0 falha\(s\)/);
  });
}
const origDownload = chrome.downloads.download;
chrome.downloads.download = async () => undefined; // o Chrome recusa
const ttRefused = await run('https://www.tiktok.com/@ok/video/7006');
chrome.downloads.download = origDownload;
await scenario('download recusado → dica de abrir tiktok.com (só no TikTok)', () => {
  const t = ttRefused.logs.join('\n');
  assert.match(t, /\[TT\] aviso: Se o download foi recusado \(403\), abra tiktok\.com/);
  assert.match(t, /0 baixado\(s\) · 1 falha\(s\)/);
});

console.log(failed ? `\n${failed} cenário(s) com falha` : '\nfluxo OK');
process.exit(failed ? 1 : 0);
