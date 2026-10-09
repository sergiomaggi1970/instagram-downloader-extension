/* Plataforma: Instagram (lógica original, sem alterações de comportamento). */
import { PlatformError, sanitizeFilename, extFromUrl, waitTabComplete } from './common.js';

export const id = 'instagram';
export const tag = 'IG';

const ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const APP_ID = '936619743392459';
const FOLDER = 'Instagram';

export const MSG = {
  LOGIN: 'Faça login no Instagram neste navegador',
  NOT_FOUND: 'Post apagado ou privado',
  RATE: 'Muitas requisições, aguarde alguns minutos',
  INVALID: 'Link não reconhecido',
};

export const IGError = PlatformError;

/** Converte o shortcode (11 primeiros caracteres) em media_id decimal (string). */
export function shortcodeToMediaId(shortcode) {
  const code = String(shortcode).slice(0, 11);
  if (!code) throw new PlatformError('invalid', MSG.INVALID);
  let id = 0n;
  for (const ch of code) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) throw new PlatformError('invalid', MSG.INVALID);
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
export function parseInstagramUrl(raw) {
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

/** Escolhe o candidato de maior largura (desempate pela altura). */
export function pickBest(list) {
  if (!Array.isArray(list) || !list.length) return null;
  return list.reduce((best, cur) => {
    const bw = best.width || 0;
    const cw = cur.width || 0;
    if (cw !== bw) return cw > bw ? cur : best;
    return (cur.height || 0) > (best.height || 0) ? cur : best;
  });
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
export function collectMedia(item) {
  const nodes =
    Array.isArray(item.carousel_media) && item.carousel_media.length
      ? item.carousel_media
      : [item];
  return nodes.map(mediaFromNode).filter(Boolean);
}

/** "Instagram/{username} - {shortcode}[_n].ext" */
export function buildFilenames(media, username, code) {
  const base = sanitizeFilename(`${username} - ${code}`);
  const multiple = media.length > 1;
  return media.map((m, i) => `${FOLDER}/${base}${multiple ? `_${i + 1}` : ''}.${m.ext}`);
}

/** Transforma a resposta HTTP do endpoint media/info em item ou lança IGError. */
export function parseInfoResponse(status, text, finalUrl) {
  if (status === 429) throw new PlatformError('rate', MSG.RATE);
  if (status === 404) throw new PlatformError('notfound', MSG.NOT_FOUND);
  if (status === 401 || status === 403) throw new PlatformError('auth', MSG.LOGIN);
  if (finalUrl && /\/accounts\/login/i.test(finalUrl)) throw new PlatformError('auth', MSG.LOGIN);

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    // HTML (página de login) em vez de JSON
    throw new PlatformError('auth', MSG.LOGIN);
  }
  if (data && (data.message === 'login_required' || data.require_login)) {
    throw new PlatformError('auth', MSG.LOGIN);
  }
  if (status === 400 && data && /not found|media/i.test(String(data.message || ''))) {
    throw new PlatformError('notfound', MSG.NOT_FOUND);
  }
  if (status >= 400) throw new PlatformError('http', `Erro HTTP ${status}`);

  const item = data && Array.isArray(data.items) ? data.items[0] : null;
  if (!item) throw new PlatformError('notfound', MSG.NOT_FOUND);
  return item;
}

/** Auto-teste: pares conhecidos shortcode → media_id e demais verificações. */
export function runSelfTest() {
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

export async function cleanup() {
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
  if (!result) throw new PlatformError('http', 'Não foi possível consultar o Instagram pela aba');
  if (result.error) throw new PlatformError('http', `Erro de rede: ${result.error}`);
  return result;
}

export async function fetchItem(mediaId) {
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


export function isFatal(err) {
  return err instanceof PlatformError && (err.code === 'auth' || err.code === 'rate');
}

/** Resolve o link em arquivos a baixar: [{url, filename}]. */
export async function resolve(parsed) {
  const mediaId = parsed.type === 'story' ? parsed.mediaId : shortcodeToMediaId(parsed.shortcode);
  const item = await fetchItem(mediaId);

  const username =
    (item.user && item.user.username) ||
    (item.owner && item.owner.username) ||
    parsed.username ||
    'instagram';
  const code = parsed.type === 'story' ? parsed.mediaId : parsed.shortcode;

  const media = collectMedia(item);
  if (!media.length) throw new PlatformError('empty', 'Nenhuma mídia encontrada neste link');
  const names = buildFilenames(media, username, code);
  return media.map((m, i) => ({ url: m.url, filename: names[i] }));
}

export const parse = parseInstagramUrl;
