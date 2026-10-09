'use strict';

(() => {
  const BTN_ID = 'igdl-floating-btn';
  const MEDIA_PATH = /^\/(?:[^/]+\/)?(reel|reels|p)\/[A-Za-z0-9_-]{5,}/;
  const LABEL = '⬇ Baixar';

  let scheduled = false;
  let resetTimer = null;

  function isMediaPage() {
    return MEDIA_PATH.test(location.pathname);
  }

  function setLabel(btn, text, color) {
    btn.textContent = text;
    btn.style.color = color || '#001418';
  }

  function createButton() {
    const btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.type = 'button';
    btn.textContent = LABEL;
    btn.style.cssText = [
      'position:fixed',
      'right:20px',
      'bottom:20px',
      'z-index:2147483647',
      'padding:10px 18px',
      'background:#00e5ff',
      'color:#001418',
      'border:1px solid #00e5ff',
      'border-radius:8px',
      'font:600 14px system-ui,-apple-system,"Segoe UI",sans-serif',
      'cursor:pointer',
      'box-shadow:0 4px 16px rgba(0,0,0,.5)',
    ].join(';');

    btn.addEventListener('click', async () => {
      clearTimeout(resetTimer);
      btn.disabled = true;
      setLabel(btn, 'Enviando…');
      try {
        const res = await chrome.runtime.sendMessage({ type: 'downloadUrl', url: location.href });
        if (res && res.ok) setLabel(btn, 'Na fila ✓');
        else setLabel(btn, 'Erro', '#ff5252');
      } catch {
        // contexto da extensão invalidado (extensão recarregada)
        setLabel(btn, 'Recarregue a página', '#ff5252');
      }
      btn.disabled = false;
      resetTimer = setTimeout(() => setLabel(btn, LABEL), 2500);
    });
    return btn;
  }

  function sync() {
    scheduled = false;
    const existing = document.getElementById(BTN_ID);
    if (!isMediaPage()) {
      if (existing) existing.remove();
      return;
    }
    if (!existing && document.body) document.body.appendChild(createButton());
  }

  // O Instagram é uma SPA: a URL muda sem recarregar. Reavalia a cada mutação do DOM.
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(sync);
  }

  new MutationObserver(schedule).observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
  sync();
})();
