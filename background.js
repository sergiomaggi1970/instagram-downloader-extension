'use strict';

/* ------------------------------------------------------------------ *
 * Constantes
 * ------------------------------------------------------------------ */

const ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const APP_ID = '936619743392459';
const FOLDER = 'Instagram';
const MAX_LOG = 500;
const MIN_DELAY_MS = 1500;
const MAX_DELAY_MS = 3000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;

const MSG = {
  LOGIN: 'Faça login no Instagram neste navegador',
  NOT_FOUND: 'Post apagado ou privado',
  RATE: 'Muitas requisições, aguarde alguns minutos',
  INVALID: 'Link não reconhecido',
};

class IGError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'IGError';
    this.code = code; // 'auth' | 'notfound' | 'rate' | 'invalid' | 'http' | 'empty' | 'download'
  }
}

/* ------------------------------------------------------------------ *
 * Funções puras (testáveis em Node: ver tests/test.js)
 * ------------------------------------------------------------------ */

/** Converte o shortcode (11 primeiros caracteres) em media_id decimal (string). */
function shortcodeToMediaId(shortcode) {
  const code = String(shortcode).slice(0, 11);
  if (!code) throw new IGError('invalid', MSG.INVALID);
  let id = 0n;
  for (const ch of code) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) throw new IGError('invalid', MSG.INVALID);
    id = id * 64n + BigInt(idx);
  }
  return id.toString();
}

/**
 * Identifica o tipo do link e normaliza (sem utm_source, igsh etc.).
 * Retorna {type:'media', kind, shortcode, normalized}
 *      ou {type:'story', username, mediaId, normalized}
 *      ou null se o link não for reconhecido.
 */
function parseInstagramUrl(raw) {
  let text = String(raw || '').trim();
  if (!text) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = 'https://' + text;

  let u;
  try {
    u = new URL(text);
  } catch {
    return null;
  }
  if (!/^(www\.|m\.)?instagram\.com$/i.test(u.hostname)) return null;

  const path = u.pathname; // query e hash ficam de fora de propósito

  const story = path.match(/^\/stories\/([^/]+)\/(\d+)\/?/);
  if (story && story[1] !== 'highlights') {
    return {
      type: 'story',
      username: story[1],
      mediaId: story[2],
      normalized: `https://www.instagram.com/stories/${story[1]}/${story[2]}/`,
    };
  }

  const media = path.match(/^(?:\/[^/]+)?\/(reel|reels|p|tv)\/([A-Za-z0-9_-]{5,})/);
  if (media) {
    const kind = media[1] === 'reels' ? 'reel' : media[1];
    return {
      type: 'media',
      kind,
      shortcode: media[2],
      normalized: `https://www.instagram.com/${kind}/${media[2]}/`,
    };
  }
  return null;
}

/** Remove caracteres inválidos no Windows/Mac e emojis; mantém acentos. */
function sanitizeFilename(name) {
  let s = String(name ?? '').normalize('NFC');
  s = s.replace(
    /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}\u{E0020}-\u{E007F}‍️⃣]/gu,
    ''
  );
  s = s.replace(/[\\/:*?"<>|\u0000-\u001F\u007F]/g, '');
  s = s.replace(/\s+/g, ' ').trim();
  s = s.replace(/^\.+/, '').replace(/[. ]+$/, '');
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(s)) s = '_' + s;
  s = Array.from(s).slice(0, 120).join('').trim();
  return s || 'instagram';
}

/** Escolhe o candidato de maior largura (desempate pela altura). */
function pickBest(list) {
  if (!Array.isArray(list) || !list.length) return null;
  return list.reduce((best, cur) => {
    const bw = best.width || 0;
    const cw = cur.width || 0;
    if (cw !== bw) return cw > bw ? cur : best;
    return (cur.height || 0) > (best.height || 0) ? cur : best;
  });
}

function extFromUrl(url, fallback) {
  try {
    const m = new URL(url).pathname.match(/\.([a-z0-9]{3,4})$/i);
    if (m && ['jpg', 'jpeg', 'png', 'webp', 'heic'].includes(m[1].toLowerCase())) {
      return m[1].toLowerCase();
    }
  } catch {
    /* ignora */
  }
  return fallback;
}

function mediaFromNode(node) {
  const video = pickBest(node && node.video_versions);
  if (video && video.url) return { kind: 'video', url: video.url, ext: 'mp4' };
  const image = pickBest(node && node.image_versions2 && node.image_versions2.candidates);
  if (image && image.url) {
    return { kind: 'image', url: image.url, ext: extFromUrl(image.url, 'jpg') };
  }
  return null;
}

/** Vídeo único, foto única ou carrossel (vídeos + imagens). */
function collectMedia(item) {
  const nodes =
    Array.isArray(item.carousel_media) && item.carousel_media.length
      ? item.carousel_media
      : [item];
  return nodes.map(mediaFromNode).filter(Boolean);
}

/** "Instagram/{username} - {shortcode}[_n].ext" */
function buildFilenames(media, username, code) {
  const base = sanitizeFilename(`${username} - ${code}`);
  const multiple = media.length > 1;
  return media.map((m, i) => `${FOLDER}/${base}${multiple ? `_${i + 1}` : ''}.${m.ext}`);
}

/** Transforma a resposta HTTP do endpoint media/info em item ou lança IGError. */
function parseInfoResponse(status, text, finalUrl) {
  if (status === 429) throw new IGError('rate', MSG.RATE);
  if (status === 404) throw new IGError('notfound', MSG.NOT_FOUND);
  if (status === 401 || status === 403) throw new IGError('auth', MSG.LOGIN);
  if (finalUrl && /\/accounts\/login/i.test(finalUrl)) throw new IGError('auth', MSG.LOGIN);

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    // HTML (página de login) em vez de JSON
    throw new IGError('auth', MSG.LOGIN);
  }
  if (data && (data.message === 'login_required' || data.require_login)) {
    throw new IGError('auth', MSG.LOGIN);
  }
  if (status === 400 && data && /not found|media/i.test(String(data.message || ''))) {
    throw new IGError('notfound', MSG.NOT_FOUND);
  }
  if (status >= 400) throw new IGError('http', `Erro HTTP ${status}`);

  const item = data && Array.isArray(data.items) ? data.items[0] : null;
  if (!item) throw new IGError('notfound', MSG.NOT_FOUND);
  return item;
}

function parseLinks(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

/** Auto-teste: pares conhecidos shortcode → media_id e demais verificações. */
function runSelfTest() {
  const results = [];
  const check = (name, actual, expected) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    results.push({ name, ok, actual, expected });
  };
  check('AAAAAAAAAAB → 1', shortcodeToMediaId('AAAAAAAAAAB'), '1');
  check('BAAAAAAAAAA → 64^10', shortcodeToMediaId('BAAAAAAAAAA'), (64n ** 10n).toString());
  check('usa só 11 caracteres', shortcodeToMediaId('AAAAAAAAAABxyz'), '1');
  check('"-_" no fim → 62*64+63', shortcodeToMediaId('AAAAAAAAA-_'), String(62 * 64 + 63));
  check(
    'URL sem utm/igsh',
    parseInstagramUrl('https://www.instagram.com/reel/Cabc123xyZ_/?igsh=abc&utm_source=ig_web')
      .normalized,
    'https://www.instagram.com/reel/Cabc123xyZ_/'
  );
  check('story', parseInstagramUrl('https://www.instagram.com/stories/fulano/3123456789012345678/').mediaId, '3123456789012345678');
  check('link inválido', parseInstagramUrl('https://example.com/reel/abc12345/'), null);
  check('nome com acento e emoji', sanitizeFilename('José 🎉: ação/?'), 'José ação');
  return results;
}

/* ------------------------------------------------------------------ *
 * Rede: busca dos dados da mídia
 * ------------------------------------------------------------------ */

const INFO_URL = (id) => `https://www.instagram.com/api/v1/media/${id}/info/`;

async function directFetch(mediaId) {
  const res = await fetch(INFO_URL(mediaId), {
    headers: { 'X-IG-App-ID': APP_ID, 'X-Requested-With': 'XMLHttpRequest' },
    credentials: 'include',
  });
  const text = await res.text();
  return { status: res.status, text, url: res.url };
}

/** Executado DENTRO da aba do Instagram (same-origin, leva os cookies). */
async function pageFetch(mediaId, appId) {
  try {
    const res = await fetch(`https://www.instagram.com/api/v1/media/${mediaId}/info/`, {
      headers: { 'X-IG-App-ID': appId, 'X-Requested-With': 'XMLHttpRequest' },
      credentials: 'include',
    });
    const text = await res.text();
    return { status: res.status, text, url: res.url };
  } catch (e) {
    return { error: String((e && e.message) || e) };
  }
}

let helperTab = null; // {id, created}

function waitTabComplete(tabId, timeout = 30000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      clearTimeout(timer);
      resolve();
    };
    const onUpdated = (id, info) => {
      if (id === tabId && info.status === 'complete') finish();
    };
    const timer = setTimeout(finish, timeout);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.get(tabId).then((t) => t.status === 'complete' && finish(), finish);
  });
}

async function getHelperTab() {
  if (helperTab) {
    try {
      await chrome.tabs.get(helperTab.id);
      return helperTab.id;
    } catch {
      helperTab = null;
    }
  }
  const tabs = await chrome.tabs.query({ url: 'https://www.instagram.com/*' });
  if (tabs.length) {
    const tab = tabs.find((t) => t.status === 'complete') || tabs[0];
    helperTab = { id: tab.id, created: false };
    await waitTabComplete(tab.id);
    return tab.id;
  }
  const tab = await chrome.tabs.create({ url: 'https://www.instagram.com/', active: false });
  helperTab = { id: tab.id, created: true };
  await waitTabComplete(tab.id);
  return tab.id;
}

async function closeHelperTab() {
  const h = helperTab;
  helperTab = null;
  if (h && h.created) {
    try {
      await chrome.tabs.remove(h.id);
    } catch {
      /* já fechada */
    }
  }
}

async function tabFetch(mediaId) {
  const tabId = await getHelperTab();
  const injected = await chrome.scripting.executeScript({
    target: { tabId },
    func: pageFetch,
    args: [String(mediaId), APP_ID],
  });
  const result = injected && injected[0] && injected[0].result;
  if (!result) throw new IGError('http', 'Não foi possível consultar o Instagram pela aba');
  if (result.error) throw new IGError('http', `Erro de rede: ${result.error}`);
  return result;
}

async function fetchItem(mediaId) {
  try {
    const r = await directFetch(mediaId);
    return parseInfoResponse(r.status, r.text, r.url);
  } catch (e) {
    // Só 401/403/login (auth) ou falha de rede justificam o fallback.
    if (e instanceof IGError && e.code !== 'auth') throw e;
  }
  const r = await tabFetch(mediaId);
  return parseInfoResponse(r.status, r.text, r.url);
}

/* ------------------------------------------------------------------ *
 * Downloads
 * ------------------------------------------------------------------ */

function waitDownload(id) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      chrome.downloads.onChanged.removeListener(onChanged);
      clearTimeout(timer);
      err ? reject(err) : resolve();
    };
    const onChanged = (delta) => {
      if (delta.id !== id || !delta.state) return;
      if (delta.state.current === 'complete') finish();
      else if (delta.state.current === 'interrupted') {
        finish(new IGError('download', `Download interrompido (${(delta.error && delta.error.current) || 'erro'})`));
      }
    };
    const timer = setTimeout(
      () => finish(new IGError('download', 'Tempo esgotado no download')),
      DOWNLOAD_TIMEOUT_MS
    );
    chrome.downloads.onChanged.addListener(onChanged);
    chrome.downloads.search({ id }).then((items) => {
      const it = items && items[0];
      if (it && it.state === 'complete') finish();
      else if (it && it.state === 'interrupted') finish(new IGError('download', 'Download interrompido'));
    });
  });
}

async function downloadFile(url, filename) {
  const id = await chrome.downloads.download({
    url,
    filename,
    conflictAction: 'uniquify',
    saveAs: false,
  });
  if (id === undefined) throw new IGError('download', 'O Chrome recusou o download');
  await waitDownload(id);
}

/* ------------------------------------------------------------------ *
 * Estado, log e fila
 * ------------------------------------------------------------------ */

let logEntries = [];
let stats = { ok: 0, fail: 0 };
let running = false;
let stopRequested = false;
let queue = [];
let keepAliveTimer = null;

const ready = (async () => {
  if (typeof chrome === 'undefined' || !chrome.storage) return; // Node (testes)
  const saved = await chrome.storage.local.get(['log', 'stats']);
  logEntries = Array.isArray(saved.log) ? saved.log : [];
  stats = saved.stats || { ok: 0, fail: 0 };
})();

function broadcast(message) {
  try {
    chrome.runtime.sendMessage(message).catch(() => {});
  } catch {
    /* popup fechado */
  }
}

function persist() {
  return chrome.storage.local.set({ log: logEntries, stats });
}

function addLog(level, text) {
  const entry = { t: Date.now(), level, text };
  logEntries.push(entry);
  if (logEntries.length > MAX_LOG) logEntries = logEntries.slice(-MAX_LOG);
  persist();
  broadcast({ type: 'log', entry });
}

function broadcastState() {
  persist();
  broadcast({ type: 'state', running, stats });
}

function getState() {
  return { running, stats, log: logEntries, queued: queue.length };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Espera com checagem do botão Parar. */
async function politeDelay(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end && !stopRequested) await sleep(100);
}

async function processLine(line) {
  const parsed = parseInstagramUrl(line);
  if (!parsed) throw new IGError('invalid', MSG.INVALID);

  addLog('info', `Processando ${parsed.normalized}`);
  const mediaId = parsed.type === 'story' ? parsed.mediaId : shortcodeToMediaId(parsed.shortcode);
  const item = await fetchItem(mediaId);

  const username =
    (item.user && item.user.username) ||
    (item.owner && item.owner.username) ||
    parsed.username ||
    'instagram';
  const code = parsed.type === 'story' ? parsed.mediaId : parsed.shortcode;

  const media = collectMedia(item);
  if (!media.length) throw new IGError('empty', 'Nenhuma mídia encontrada neste link');
  const names = buildFilenames(media, username, code);

  let failed = 0;
  for (let i = 0; i < media.length; i++) {
    try {
      await downloadFile(media[i].url, names[i]);
      addLog('ok', `✔ ${names[i]}`);
    } catch (e) {
      failed++;
      addLog('erro', `✖ ${names[i]}: ${e.message}`);
    }
  }
  if (failed) throw new IGError('download', `${failed} de ${media.length} arquivo(s) falharam`);
}

async function runQueue() {
  if (running) return;
  running = true;
  stopRequested = false;
  stats = { ok: 0, fail: 0 };
  broadcastState();
  keepAliveTimer = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20000);

  try {
    let needDelay = false; // só espera quando o item anterior fez requisição
    while (queue.length && !stopRequested) {
      if (needDelay) {
        await politeDelay(MIN_DELAY_MS + Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS));
        if (stopRequested) break;
      }
      const line = queue.shift();
      needDelay = true;
      try {
        await processLine(line);
        stats.ok++;
      } catch (e) {
        stats.fail++;
        const code = e instanceof IGError ? e.code : 'unknown';
        addLog('erro', `${e.message || e} — ${line}`);
        if (code === 'invalid') needDelay = false;
        if (code === 'auth' || code === 'rate') {
          if (queue.length) addLog('aviso', `Fila interrompida; ${queue.length} link(s) não processado(s)`);
          queue = [];
        }
      }
      broadcastState();
    }
    if (stopRequested) {
      if (queue.length) addLog('aviso', `Parado pelo usuário; ${queue.length} link(s) não processado(s)`);
      else addLog('aviso', 'Parado pelo usuário');
      queue = [];
    }
  } finally {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
    await closeHelperTab();
    running = false;
    stopRequested = false;
    addLog(stats.fail ? 'aviso' : 'ok', `${stats.ok} baixado(s) · ${stats.fail} falha(s)`);
    broadcastState();
  }
}

function enqueue(lines) {
  if (!lines.length) {
    addLog('aviso', 'Nenhum link para baixar');
    return 0;
  }
  queue.push(...lines);
  if (running) addLog('info', `${lines.length} link(s) adicionado(s) à fila`);
  runQueue().catch((e) => addLog('erro', `Erro inesperado: ${e.message || e}`));
  return lines.length;
}

/* ------------------------------------------------------------------ *
 * Mensagens (popup / content script)
 * ------------------------------------------------------------------ */

async function handleMessage(msg) {
  await ready;
  switch (msg && msg.type) {
    case 'start':
      return { ok: true, queued: enqueue(parseLinks(msg.text)) };
    case 'downloadUrl':
      return { ok: true, queued: enqueue(parseLinks(msg.url)) };
    case 'stop':
      if (running) {
        stopRequested = true;
        addLog('aviso', 'Parando depois do item atual…');
      }
      return { ok: true };
    case 'clear':
      logEntries = [];
      if (!running) stats = { ok: 0, fail: 0 };
      await persist();
      broadcast({ type: 'cleared' });
      broadcast({ type: 'state', running, stats });
      return { ok: true };
    case 'getState':
      return getState();
    case 'selfTest': {
      const results = runSelfTest();
      results.forEach((r) => addLog(r.ok ? 'ok' : 'erro', `${r.ok ? 'PASSOU' : 'FALHOU'}: ${r.name}`));
      return { ok: results.every((r) => r.ok), results };
    }
    default:
      return { ok: false, error: 'mensagem desconhecida' };
  }
}

if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    handleMessage(msg).then(sendResponse, (e) => sendResponse({ ok: false, error: String(e) }));
    return true; // resposta assíncrona
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    IGError,
    MSG,
    shortcodeToMediaId,
    parseInstagramUrl,
    sanitizeFilename,
    pickBest,
    collectMedia,
    buildFilenames,
    parseInfoResponse,
    parseLinks,
    runSelfTest,
  };
}
