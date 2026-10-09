/* Downloads via chrome.downloads, compartilhados pelo background e pelas plataformas. */
import { PlatformError } from './platforms/common.js';

const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;

export function waitDownload(id) {
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

/** Baixa uma URL com o próprio chrome.downloads (pasta/nome definidos por nós). */
export async function downloadFile(url, filename) {
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
 * Downloads iniciados por uma página (link <a download> de um blob:).
 * A página salva o arquivo; aqui só definimos a pasta/nome final e esperamos terminar.
 * ------------------------------------------------------------------ */

let expectation = null; // {filename, id, resolve, reject, timer}

/**
 * Registra que logo virá um download blob: de uma página do TikTok e que ele deve ser
 * salvo como `filename` (ex.: "TikTok/usuario - id.mp4"). `promise` resolve quando termina.
 */
export function expectBlobDownload(filename) {
  let exp;
  const promise = new Promise((resolve, reject) => {
    exp = { filename, id: null, resolve, reject, timer: null };
    exp.timer = setTimeout(() => {
      if (expectation === exp) expectation = null;
      reject(new PlatformError('download', 'Tempo esgotado no download'));
    }, DOWNLOAD_TIMEOUT_MS);
  });
  expectation = exp;
  const cancel = () => {
    clearTimeout(exp.timer);
    if (expectation === exp) expectation = null;
  };
  promise.then(cancel, cancel);
  promise.catch(() => {});
  return { promise, cancel };
}

if (typeof chrome !== 'undefined' && chrome.downloads && chrome.downloads.onDeterminingFilename) {
  chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
    if (expectation && expectation.id == null && /^blob:https:\/\/www\.tiktok\.com\//.test(item.url || '')) {
      expectation.id = item.id;
      suggest({ filename: expectation.filename, conflictAction: 'uniquify' });
    }
  });
  chrome.downloads.onChanged.addListener((delta) => {
    const exp = expectation;
    if (!exp || exp.id == null || delta.id !== exp.id || !delta.state) return;
    if (delta.state.current === 'complete') exp.resolve();
    else if (delta.state.current === 'interrupted') {
      exp.reject(new PlatformError('download', `Download interrompido (${(delta.error && delta.error.current) || 'erro'})`));
    }
  });
}
