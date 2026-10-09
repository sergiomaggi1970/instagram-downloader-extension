/* Service worker (módulo): fila, roteamento por plataforma, log e downloads. */
import { PlatformError } from './platforms/common.js';
import { platforms, detectPlatform, parseLinks } from './platforms/index.js';
import * as instagram from './platforms/instagram.js';
import * as x from './platforms/x.js';
import * as tiktok from './platforms/tiktok.js';

const MAX_LOG = 500;
let minDelayMs = 1500;
let maxDelayMs = 3000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;

const INVALID = 'Link não reconhecido';

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
        finish(new PlatformError('download', `Download interrompido (${(delta.error && delta.error.current) || 'erro'})`));
      }
    };
    const timer = setTimeout(
      () => finish(new PlatformError('download', 'Tempo esgotado no download')),
      DOWNLOAD_TIMEOUT_MS
    );
    chrome.downloads.onChanged.addListener(onChanged);
    chrome.downloads.search({ id }).then((items) => {
      const it = items && items[0];
      if (it && it.state === 'complete') finish();
      else if (it && it.state === 'interrupted') finish(new PlatformError('download', 'Download interrompido'));
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
  if (id === undefined) throw new PlatformError('download', 'O Chrome recusou o download');
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

/** `platform` é a tag curta ('IG' | 'X'); o popup mostra como [IG] / [X]. */
function addLog(level, text, platform) {
  const entry = { t: Date.now(), level, text };
  if (platform) entry.platform = platform;
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
  while (Date.now() < end && !stopRequested) await sleep(Math.min(100, ms));
}

async function processLine(route) {
  const { platform, parsed } = route;
  const log = (level, text) => addLog(level, text, platform.tag);

  log('info', `Processando ${parsed.normalized}`);
  const files = await platform.resolve(parsed, { log });

  let failed = 0;
  for (const f of files) {
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          await downloadFile(f.url, f.filename);
          break;
        } catch (e) {
          if (attempt >= (platform.downloadRetries || 0)) throw e;
          await sleep(1500);
        }
      }
      log('ok', `✔ ${f.filename}`);
    } catch (e) {
      failed++;
      log('erro', `✖ ${f.filename}: ${e.message}`);
    }
  }
  if (failed && platform.downloadHint) log('aviso', platform.downloadHint);
  if (failed) throw new PlatformError('download', `${failed} de ${files.length} arquivo(s) falharam`);
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
        await politeDelay(minDelayMs + Math.random() * (maxDelayMs - minDelayMs));
        if (stopRequested) break;
      }
      const line = queue.shift();
      needDelay = true;
      const route = detectPlatform(line);
      try {
        if (!route) throw new PlatformError('invalid', INVALID);
        await processLine(route);
        stats.ok++;
      } catch (e) {
        stats.fail++;
        const code = e instanceof PlatformError ? e.code : 'unknown';
        addLog('erro', `${e.message || e} — ${line}`, route && route.platform.tag);
        if (code === 'invalid') needDelay = false;
        if (route && route.platform.isFatal(e)) {
          // Falha que vale para a plataforma inteira (sem login, 429): descarta os links dela (e os não reconhecidos).
          const before = queue.length;
          queue = queue.filter((l) => {
            const r = detectPlatform(l);
            return r && r.platform !== route.platform;
          });
          const dropped = before - queue.length;
          if (dropped) {
            addLog('aviso', `Fila interrompida; ${dropped} link(s) não processado(s)`, route.platform.tag);
          }
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
    for (const p of platforms) {
      try {
        await p.cleanup();
      } catch {
        /* ignora */
      }
    }
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
 * Mensagens (popup / content scripts)
 * ------------------------------------------------------------------ */

const TAB_PATTERNS = [
  'https://www.instagram.com/*',
  'https://x.com/*',
  'https://www.x.com/*',
  'https://twitter.com/*',
  'https://www.twitter.com/*',
  'https://mobile.twitter.com/*',
  'https://www.tiktok.com/*',
  'https://m.tiktok.com/*',
  'https://vm.tiktok.com/*',
  'https://vt.tiktok.com/*',
];

async function handleMessage(msg, sender) {
  await ready;
  switch (msg && msg.type) {
    case 'start':
      return { ok: true, queued: enqueue(parseLinks(msg.text)) };
    case 'downloadUrl':
      return { ok: true, queued: enqueue(parseLinks(msg.url)) };
    case 'xCapture':
      x.handleCapture(sender && sender.tab && sender.tab.id, msg.payload);
      return { ok: true };
    case 'listTabs': {
      const tabs = await chrome.tabs.query({ url: TAB_PATTERNS });
      const seen = new Set();
      const urls = [];
      for (const tab of tabs.sort((a, b) => a.index - b.index)) {
        const route = detectPlatform(tab.url);
        if (route && !seen.has(route.parsed.normalized)) {
          seen.add(route.parsed.normalized);
          urls.push({ url: route.parsed.normalized, active: tab.active, windowId: tab.windowId });
        }
      }
      return { ok: true, urls };
    }
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
      const results = [...instagram.runSelfTest(), ...x.runSelfTest(), ...tiktok.runSelfTest()];
      results.forEach((r) => addLog(r.ok ? 'ok' : 'erro', `${r.ok ? 'PASSOU' : 'FALHOU'}: ${r.name}`));
      return { ok: results.every((r) => r.ok), results };
    }
    default:
      return { ok: false, error: 'mensagem desconhecida' };
  }
}

if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    handleMessage(msg, sender).then(sendResponse, (e) => sendResponse({ ok: false, error: String(e) }));
    return true; // resposta assíncrona
  });
}

/** Só para os testes: encurta o intervalo entre links. */
export function configureDelay(min, max) {
  minDelayMs = min;
  maxDelayMs = max;
}
