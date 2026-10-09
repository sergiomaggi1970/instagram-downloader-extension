/* Plataforma: TikTok (vídeos e posts de fotos). */
import { PlatformError, sanitizeFilename, extFromUrl, waitTabComplete } from './common.js';

export const id = 'tiktok';
export const tag = 'TT';

const FOLDER = 'TikTok';
const REFERER_RULE_ID = 9001;
const CDN_DOMAINS = ['tiktok.com', 'tiktokcdn.com', 'tiktokcdn-us.com', 'tiktokv.com'];

export const MSG = {
  GONE: 'Vídeo apagado ou indisponível',
  PRIVATE: 'Vídeo privado ou restrito: faça login no TikTok neste navegador',
  RATE: 'Muitas requisições, aguarde alguns minutos',
  BLOCKED: 'O TikTok pediu verificação: abra tiktok.com neste navegador, conclua e tente de novo',
  FORBIDDEN: 'O TikTok bloqueou o acesso (HTTP 403) a este navegador ou rede. Confira se tiktok.com abre normalmente aqui; VPN, proxy ou muitas tentativas podem causar isso',
  NO_MEDIA: 'Post sem vídeo ou foto',
  INVALID: 'Link não reconhecido',
};

/** Mostrado no log (aviso) quando o download de um arquivo é recusado. */
export const downloadRetries = 1; // o CDN às vezes recusa a primeira tentativa

/** Ajustáveis (os testes encurtam os tempos). */
export const settings = { retryDelayMs: 1500, tabPollMs: 750 };

export const downloadHint =
  'Se o download foi recusado (403), abra tiktok.com uma vez neste navegador e tente de novo';

/* ------------------------------------------------------------------ *
 * Funções puras (testáveis em Node)
 * ------------------------------------------------------------------ */

/**
 * Normaliza o link. Retorna
 *  {type:'post', kind:'video'|'photo', id, username|null, normalized}
 *  {type:'short', code, normalized}   (vm.tiktok.com, vt.tiktok.com, tiktok.com/t/…)
 * ou null.
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
  const host = u.hostname.toLowerCase();
  const path = u.pathname;

  if (/^(vm|vt)\.tiktok\.com$/.test(host)) {
    const m = path.match(/^\/([A-Za-z0-9_-]{4,})/);
    return m ? { type: 'short', code: m[1], normalized: `https://${host}/${m[1]}/` } : null;
  }
  if (!/^(www\.|m\.)?tiktok\.com$/.test(host)) return null;

  let m = path.match(/^\/@([^/]+)\/(video|photo)\/(\d+)/);
  if (m) {
    return {
      type: 'post',
      kind: m[2],
      id: m[3],
      username: m[1],
      normalized: `https://www.tiktok.com/@${m[1]}/${m[2]}/${m[3]}`,
    };
  }
  m = path.match(/^\/v\/(\d+)/); // m.tiktok.com/v/ID.html (link antigo)
  if (m) {
    return { type: 'post', kind: 'video', id: m[1], username: null, normalized: `https://www.tiktok.com/@_/video/${m[1]}` };
  }
  m = path.match(/^\/t\/([A-Za-z0-9_-]{4,})/);
  if (m) return { type: 'short', code: m[1], normalized: `https://www.tiktok.com/t/${m[1]}/` };
  return null;
}

/**
 * Lê o JSON embutido na página (__UNIVERSAL_DATA_FOR_REHYDRATION__).
 * Retorna {state:'ok', item} | {state:'gone'} | {state:'private'} | {state:'blocked'}
 * ('blocked' = a página não trouxe os dados, p.ex. verificação/captcha).
 */
export function extractItem(html) {
  const m = String(html || '').match(
    /<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/
  );
  return m ? extractItemFromJson(m[1]) : { state: 'blocked' };
}

/** Mesmo que extractItem, a partir do texto do <script> já isolado. */
export function extractItemFromJson(jsonText) {
  let data;
  try {
    data = JSON.parse(jsonText);
  } catch {
    return { state: 'blocked' };
  }
  const detail = data && data.__DEFAULT_SCOPE__ && data.__DEFAULT_SCOPE__['webapp.video-detail'];
  if (!detail) return { state: 'blocked' };
  const item = detail.itemInfo && detail.itemInfo.itemStruct;
  if (item && item.id) return { state: 'ok', item };
  return detail.statusCode === 10222 ? { state: 'private' } : { state: 'gone' };
}

/**
 * URL do vídeo sem marca d'água (playAddr/bitrateInfo). Prefere h264, que toca em qualquer
 * lugar, e dentro dele o de maior bitrate; sem h264, o de maior bitrate entre os demais.
 */
export function pickVideoUrl(item) {
  const v = (item && item.video) || {};
  const list = (Array.isArray(v.bitrateInfo) ? v.bitrateInfo : []).filter(
    (b) => b && b.PlayAddr && Array.isArray(b.PlayAddr.UrlList) && b.PlayAddr.UrlList[0]
  );
  const h264 = list.filter((b) => /^h264$/i.test(b.CodecType || ''));
  const pool = h264.length ? h264 : list;
  if (pool.length) {
    const best = pool.reduce((a, b) => ((b.Bitrate || 0) > (a.Bitrate || 0) ? b : a));
    return best.PlayAddr.UrlList[0];
  }
  return v.playAddr || v.downloadAddr || null;
}

/** Posts de fotos (carrossel): [{url, ext}] na ordem. */
export function pickPhotos(item) {
  const images = (item && item.imagePost && item.imagePost.images) || [];
  return images
    .map((im) => im && im.imageURL && im.imageURL.urlList && im.imageURL.urlList[0])
    .filter(Boolean)
    .map((url) => ({ url, ext: extFromUrl(url, 'jpg') }));
}

/** [{url, filename}] — "TikTok/{usuario} - {id}[_n].ext" */
export function buildFiles(item, fallbackUser) {
  const user = (item.author && item.author.uniqueId) || fallbackUser || 'tiktok';
  const base = sanitizeFilename(`${user} - ${item.id}`);

  const photos = pickPhotos(item);
  if (photos.length) {
    const multiple = photos.length > 1;
    return photos.map((p, i) => ({
      url: p.url,
      filename: `${FOLDER}/${base}${multiple ? `_${i + 1}` : ''}.${p.ext}`,
    }));
  }
  const url = pickVideoUrl(item);
  return url ? [{ url, filename: `${FOLDER}/${base}.mp4` }] : [];
}

/* ------------------------------------------------------------------ *
 * Rede
 * ------------------------------------------------------------------ */

/**
 * O CDN do TikTok recusa (403) pedidos sem Referer tiktok.com. O chrome.downloads não deixa
 * definir Referer, então uma regra de sessão do declarativeNetRequest faz isso, só para
 * pedidos que não vêm de abas (tabIds: [-1] = a própria extensão e seus downloads).
 */
async function ensureReferer() {
  if (!chrome.declarativeNetRequest) return;
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [REFERER_RULE_ID],
    addRules: [
      {
        id: REFERER_RULE_ID,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [{ header: 'referer', operation: 'set', value: 'https://www.tiktok.com/' }],
        },
        condition: {
          requestDomains: CDN_DOMAINS,
          tabIds: [-1],
          resourceTypes: ['xmlhttprequest', 'media', 'other'],
        },
      },
    ],
  });
}

export function isFatal(err) {
  return err instanceof PlatformError && (err.code === 'rate' || err.code === 'blocked');
}

export async function cleanup() {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Roda dentro da aba: devolve o JSON que a própria página embute. */
function readRehydrationJson() {
  const el = document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__');
  return el ? el.textContent : null;
}

/**
 * Plano B quando a requisição direta é barrada: abre o vídeo numa aba em segundo plano
 * (navegação real, que passa pela verificação do TikTok), lê o JSON da página e fecha a aba.
 */
async function loadViaTab(url) {
  const tab = await chrome.tabs.create({ url, active: false });
  try {
    await waitTabComplete(tab.id, 30000);
    for (let i = 0; i < 4; i++) {
      try {
        const r = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: readRehydrationJson });
        const text = r && r[0] && r[0].result;
        if (text) return text;
      } catch {
        /* página ainda carregando ou bloqueada */
      }
      await sleep(settings.tabPollMs);
    }
    return null;
  } finally {
    try {
      await chrome.tabs.remove(tab.id);
    } catch {
      /* já fechada */
    }
  }
}

/** Busca os dados da página: 2 tentativas diretas e, se continuar barrado, uma aba real. */
async function fetchItem(url) {
  let status = 0; // 0 = erro de rede
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await sleep(settings.retryDelayMs);
    let res;
    try {
      res = await fetch(url, { credentials: 'include' });
    } catch {
      status = 0;
      continue;
    }
    status = res.status;
    if (status === 429) throw new PlatformError('rate', MSG.RATE);
    if (status === 404) throw new PlatformError('notfound', MSG.GONE);
    const r = extractItem(await res.text());
    if (r.state !== 'blocked') return r;
  }

  const json = await loadViaTab(url);
  if (json) {
    const r = extractItemFromJson(json);
    if (r.state !== 'blocked') return r;
  }
  if (status === 0) throw new PlatformError('http', 'Erro de rede ao consultar o TikTok');
  throw new PlatformError('blocked', status === 403 ? MSG.FORBIDDEN : MSG.BLOCKED);
}

/** Resolve o link em arquivos a baixar: [{url, filename}]. */
export async function resolve(parsed, ctx = {}) {
  await ensureReferer();

  const r = await fetchItem(parsed.normalized);
  if (r.state === 'private') throw new PlatformError('auth', MSG.PRIVATE);
  if (r.state === 'gone') throw new PlatformError('notfound', MSG.GONE);

  const files = buildFiles(r.item, parsed.username);
  if (!files.length) throw new PlatformError('nomedia', MSG.NO_MEDIA);
  return files;
}

export function runSelfTest() {
  const results = [];
  const check = (name, actual, expected) =>
    results.push({ name, ok: JSON.stringify(actual) === JSON.stringify(expected), actual, expected });
  check('ID do vídeo', (parse('https://www.tiktok.com/@foo/video/6718335390845095173?is_from_webapp=1') || {}).id, '6718335390845095173');
  check('link curto', (parse('https://vm.tiktok.com/ZSabc123/') || {}).type, 'short');
  check('link inválido', parse('https://www.tiktok.com/@foo'), null);
  return results;
}
