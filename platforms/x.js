/* Plataforma: X (antigo Twitter). */
import { PlatformError, sanitizeFilename, extFromUrl, waitTabComplete } from './common.js';

export const id = 'x';
export const tag = 'X';

const FOLDER = 'X';

export const MSG = {
  NO_VIDEO: 'Tweet sem vídeo',
  GONE: 'Tweet apagado ou indisponível',
  LOGIN: 'Conteúdo restrito: faça login no X neste navegador',
  RATE: 'Muitas requisições, aguarde alguns minutos',
  INVALID: 'Link não reconhecido',
};

/** Ajustáveis (os testes encurtam os tempos). */
export const settings = {
  captureTimeoutMs: 15000,
  graceMs: 2000,
};

/* ------------------------------------------------------------------ *
 * Funções puras (testáveis em Node)
 * ------------------------------------------------------------------ */

/**
 * Normaliza o link e extrai o ID do tweet (sempre string: o ID não cabe em Number).
 * Retorna {type:'tweet', id, username|null, normalized} ou null.
 */
export function parse(raw) {
  let text = String(raw || '').trim();
  if (!text) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = 'https://' + text;

  let u;
  try {
    u = new URL(text);
  } catch {
    return null;
  }
  if (!/^(www\.|mobile\.)?(x|twitter)\.com$/i.test(u.hostname)) return null;

  const m = u.pathname.match(/^\/(i\/web|[^/]+)\/status(?:es)?\/(\d+)/);
  if (!m) return null;
  const username = m[1] === 'i/web' || m[1] === 'i' ? null : m[1];
  return {
    type: 'tweet',
    id: m[2],
    username,
    normalized: `https://x.com/${username || 'i'}/status/${m[2]}`,
  };
}

/** Token do endpoint de syndication (fórmula do embed oficial). */
export function syndicationToken(tweetId) {
  return ((Number(tweetId) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '');
}

export function syndicationUrl(tweetId) {
  return `https://cdn.syndication.twimg.com/tweet-result?id=${tweetId}&token=${syndicationToken(tweetId)}&lang=pt`;
}

/** Entre as variantes, o mp4 de maior bitrate (GIFs têm bitrate 0). */
export function pickBestVariant(variants) {
  const mp4 = (Array.isArray(variants) ? variants : []).filter(
    (v) => v && v.content_type === 'video/mp4' && v.url
  );
  if (!mp4.length) return null;
  return mp4.reduce((best, cur) => ((cur.bitrate || 0) > (best.bitrate || 0) ? cur : best));
}

function photoUrlOrig(url) {
  try {
    const u = new URL(url);
    u.searchParams.set('name', 'orig');
    return u.toString();
  } catch {
    return `${url}?name=orig`;
  }
}

function photoExt(url) {
  try {
    const f = new URL(url).searchParams.get('format');
    if (f && /^[a-z0-9]{3,4}$/i.test(f)) return f.toLowerCase();
  } catch {
    /* ignora */
  }
  return extFromUrl(url, 'jpg');
}

/** mediaDetails (syndication) ou extended_entities.media (página) → [{kind,url,ext}] */
export function mediaFromDetails(details) {
  const out = [];
  for (const d of Array.isArray(details) ? details : []) {
    if (!d) continue;
    if (d.type === 'video' || d.type === 'animated_gif') {
      const v = pickBestVariant(d.video_info && d.video_info.variants);
      if (v) out.push({ kind: 'video', url: v.url, ext: 'mp4' });
    } else if (d.type === 'photo' && d.media_url_https) {
      out.push({ kind: 'image', url: photoUrlOrig(d.media_url_https), ext: photoExt(d.media_url_https) });
    }
  }
  return out;
}

/** Mídia de um objeto de tweet da syndication (com fallback para photos/video). */
function mediaFromSyndicationTweet(t) {
  if (!t) return [];
  let media = mediaFromDetails(t.mediaDetails);
  if (!media.length && Array.isArray(t.photos)) {
    media = mediaFromDetails(t.photos.map((p) => ({ type: 'photo', media_url_https: p.url })));
  }
  if (!media.length && t.video && Array.isArray(t.video.variants)) {
    media = mediaFromDetails([{ type: 'video', video_info: { variants: t.video.variants } }]);
  }
  return media;
}

/**
 * Interpreta a resposta da syndication.
 * state: 'ok' | 'nomedia' | 'gone' | 'restricted' | 'error'. Lança PlatformError só no 429.
 */
export function parseSyndication(status, text) {
  if (status === 429) throw new PlatformError('rate', MSG.RATE);
  if (status === 404) return { state: 'gone' };
  if (status >= 400) return { state: 'error', status };

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { state: 'error', status };
  }
  if (!data || typeof data !== 'object' || !Object.keys(data).length) return { state: 'gone' };
  if (data.__typename === 'TweetTombstone' || data.tombstone) return { state: 'restricted' };

  const screenName = (data.user && data.user.screen_name) || null;
  let media = mediaFromSyndicationTweet(data);
  let quoted = false;
  if (!media.length && data.quoted_tweet) {
    media = mediaFromSyndicationTweet(data.quoted_tweet);
    quoted = media.length > 0;
  }
  if (media.length) return { state: 'ok', screenName, media, quoted };
  // Sem mídia visível mas marcado como sensível: o embed pode estar omitindo; confere na página.
  if (data.possibly_sensitive) return { state: 'restricted', screenName };
  return { state: 'nomedia', screenName };
}

/**
 * Avalia o que a página já devolveu. `tweets`: Map(id → {screenName, media, quotedId});
 * `tombstone`: a página respondeu com tombstone para este tweet.
 * Retorna {status:'ok'|'nomedia'|'tombstone', ...} ou null se ainda indeciso.
 */
export function evaluateCapture(tweets, tweetId, tombstone = false) {
  const t = tweets.get(tweetId);
  if (t) {
    let media = mediaFromDetails(t.media);
    if (media.length) return { status: 'ok', screenName: t.screenName, media, quoted: false };
    const q = t.quotedId && tweets.get(t.quotedId);
    if (q) {
      media = mediaFromDetails(q.media);
      if (media.length) return { status: 'ok', screenName: t.screenName, media, quoted: true };
    }
    return { status: 'nomedia', screenName: t.screenName };
  }
  if (tombstone) return { status: 'tombstone' };
  return null;
}

function buildFiles(media, screenName, tweetId) {
  const base = sanitizeFilename(`${screenName || 'x'} - ${tweetId}`);
  const multiple = media.length > 1;
  return media.map((m, i) => ({
    url: m.url,
    filename: `${FOLDER}/${base}${multiple ? `_${i + 1}` : ''}.${m.ext}`,
  }));
}

/* ------------------------------------------------------------------ *
 * Método principal: endpoint de embed (sem login)
 * ------------------------------------------------------------------ */

async function syndicationFetch(tweetId) {
  const res = await fetch(syndicationUrl(tweetId), { credentials: 'omit' });
  return { status: res.status, text: await res.text() };
}

/* ------------------------------------------------------------------ *
 * Fallback: capturar a resposta GraphQL da própria página do X
 * ------------------------------------------------------------------ */

let pending = null; // {tabId, add(payload)}
const earlyCaptures = new Map(); // capturas que chegaram antes do registro da aba

/** Chamado pelo background quando o content script envia uma captura. */
export function handleCapture(tabId, payload) {
  if (tabId == null || !payload) return;
  if (pending && pending.tabId === tabId) {
    pending.add(payload);
  } else {
    const list = earlyCaptures.get(tabId) || [];
    list.push(payload);
    earlyCaptures.set(tabId, list.slice(-20));
  }
}

/** Roda na aba: a UI de visitante (sem sessão) mostra botão de login e não o menu da conta. */
function pageIsLoggedOut() {
  const loggedIn = document.querySelector(
    '[data-testid="SideNav_AccountSwitcher_Button"], [data-testid="AppTabBar_Profile_Link"]'
  );
  const loginUi = document.querySelector('[data-testid="loginButton"], a[href="/login"]');
  return !loggedIn && !!loginUi;
}

async function isLoggedOut(tabId) {
  try {
    const r = await chrome.scripting.executeScript({ target: { tabId }, func: pageIsLoggedOut });
    return !!(r && r[0] && r[0].result);
  } catch {
    return false;
  }
}

async function captureFromPage(url, tweetId) {
  const tab = await chrome.tabs.create({ url, active: false });
  const tabId = tab.id;
  const tweets = new Map();
  let tombstone = false;

  try {
    const result = await new Promise((resolve) => {
      let graceTimer = null;
      let settled = false;
      const settle = (r) => {
        if (settled) return;
        settled = true;
        clearTimeout(graceTimer);
        clearTimeout(timeout);
        pending = null;
        resolve(r);
      };
      const timeout = setTimeout(() => settle(evaluateCapture(tweets, tweetId, tombstone) || { status: 'timeout' }), settings.captureTimeoutMs);

      const add = (payload) => {
        for (const t of payload.tweets || []) if (t && t.id) tweets.set(t.id, t);
        if (payload.tombstone) tombstone = true;
        const ev = evaluateCapture(tweets, tweetId, tombstone);
        if (!ev) return;
        if (ev.status === 'ok') return settle(ev);
        // sem mídia / tombstone: espera um pouco, pode chegar mais dados (tweet citado etc.)
        clearTimeout(graceTimer);
        graceTimer = setTimeout(() => settle(evaluateCapture(tweets, tweetId, tombstone)), settings.graceMs);
      };

      pending = { tabId, add };
      for (const p of earlyCaptures.get(tabId) || []) add(p);
      earlyCaptures.delete(tabId);
    });

    if (result.status === 'ok' || result.status === 'nomedia') return result;
    return { ...result, loggedOut: await isLoggedOut(tabId) };
  } finally {
    pending = null;
    earlyCaptures.delete(tabId);
    try {
      await chrome.tabs.remove(tabId);
    } catch {
      /* já fechada */
    }
  }
}

/* ------------------------------------------------------------------ *
 * Interface da plataforma
 * ------------------------------------------------------------------ */

export function isFatal(err) {
  return err instanceof PlatformError && err.code === 'rate';
}

export async function cleanup() {}

/** Resolve o link em arquivos a baixar: [{url, filename}]. */
export async function resolve(parsed, ctx = {}) {
  const log = ctx.log || (() => {});
  const fallbackName = parsed.username;

  let synd;
  try {
    const r = await syndicationFetch(parsed.id);
    synd = parseSyndication(r.status, r.text);
  } catch (e) {
    if (e instanceof PlatformError) throw e;
    synd = { state: 'error' }; // falha de rede: tenta pela página
  }

  if (synd.state === 'ok') {
    if (synd.quoted) log('aviso', 'Tweet sem mídia própria; baixando o vídeo do tweet citado');
    return buildFiles(synd.media, synd.screenName || fallbackName, parsed.id);
  }
  if (synd.state === 'nomedia') throw new PlatformError('nomedia', MSG.NO_VIDEO);

  log('info', 'Sem acesso pelo embed; tentando pela página do X…');
  const cap = await captureFromPage(parsed.normalized, parsed.id);

  if (cap.status === 'ok') {
    if (cap.quoted) log('aviso', 'Tweet sem mídia própria; baixando o vídeo do tweet citado');
    return buildFiles(cap.media, cap.screenName || synd.screenName || fallbackName, parsed.id);
  }
  if (cap.status === 'nomedia') throw new PlatformError('nomedia', MSG.NO_VIDEO);

  const restricted = synd.state === 'restricted' || cap.status === 'tombstone';
  if (cap.loggedOut && restricted) throw new PlatformError('auth', MSG.LOGIN);
  throw new PlatformError('notfound', MSG.GONE);
}

/** Auto-teste (usado pelo botão/mensagem selfTest). */
export function runSelfTest() {
  const results = [];
  const check = (name, actual, expected) =>
    results.push({ name, ok: JSON.stringify(actual) === JSON.stringify(expected), actual, expected });
  check('token do tweet 20', syndicationToken('20'), '6dq1a2xwd93');
  check('ID do link', (parse('https://x.com/jack/status/20?s=20') || {}).id, '20');
  check('link inválido', parse('https://x.com/jack'), null);
  return results;
}
