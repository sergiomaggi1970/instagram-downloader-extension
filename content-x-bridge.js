'use strict';
// Content script isolado (document_start): repassa as capturas do world MAIN ao background.
window.addEventListener('message', (event) => {
  if (event.source !== window || !event.data || event.data.source !== 'svd-x-capture') return;
  try {
    chrome.runtime.sendMessage({ type: 'xCapture', payload: event.data.payload }).catch(() => {});
  } catch {
    /* contexto da extensão invalidado */
  }
});
