/* Utilidades compartilhadas entre as plataformas. */

export class PlatformError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PlatformError';
    this.code = code; // 'auth' | 'notfound' | 'rate' | 'invalid' | 'http' | 'empty' | 'download' ...
  }
}

/** Remove caracteres inválidos no Windows/Mac e emojis; mantém acentos. */
export function sanitizeFilename(name) {
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

export function extFromUrl(url, fallback) {
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

/** Espera a aba terminar de carregar (ou o timeout). */
export function waitTabComplete(tabId, timeout = 30000) {
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
