'use strict';

// Botão "⬇" na barra de ações de cada tweet com vídeo/GIF (x.com e twitter.com).
(() => {
  const BTN_CLASS = 'svd-x-btn';
  const VIDEO_SEL = '[data-testid="videoPlayer"], [data-testid="videoComponent"]';

  let scheduled = false;

  function tweetLink(article) {
    const a = article.querySelector('time') && article.querySelector('time').closest('a');
    if (a && a.href) return a.href;
    return /\/status\/\d+/.test(location.pathname) ? location.href : null;
  }

  function actionBar(article) {
    // a barra de ações é o role="group" que contém o botão de responder
    const groups = article.querySelectorAll('[role="group"]');
    for (let i = groups.length - 1; i >= 0; i--) {
      if (groups[i].querySelector('[data-testid="reply"]')) return groups[i];
    }
    return null;
  }

  function createButton(article) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = BTN_CLASS;
    btn.title = 'Baixar vídeo';
    btn.setAttribute('aria-label', 'Baixar vídeo');
    btn.textContent = '⬇';
    btn.style.cssText = [
      'display:inline-flex',
      'align-items:center',
      'justify-content:center',
      'width:30px',
      'height:30px',
      'margin-left:4px',
      'padding:0',
      'background:#00e5ff',
      'color:#001418',
      'border:1px solid #00e5ff',
      'border-radius:8px',
      'font:700 15px system-ui,-apple-system,"Segoe UI",sans-serif',
      'line-height:1',
      'cursor:pointer',
      'flex:none',
      'align-self:center',
    ].join(';');

    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const url = tweetLink(article);
      if (!url) return;
      btn.disabled = true;
      btn.textContent = '…';
      try {
        const res = await chrome.runtime.sendMessage({ type: 'downloadUrl', url });
        btn.textContent = res && res.ok ? '✓' : '!';
      } catch {
        btn.textContent = '!'; // extensão recarregada: recarregue a página
      }
      setTimeout(() => {
        btn.textContent = '⬇';
        btn.disabled = false;
      }, 2000);
    });
    return btn;
  }

  function scan() {
    scheduled = false;
    document.querySelectorAll('article').forEach((article) => {
      if (article.querySelector('.' + BTN_CLASS)) return; // nunca duas vezes no mesmo tweet
      if (!article.querySelector(VIDEO_SEL)) return;
      const bar = actionBar(article);
      if (bar) bar.appendChild(createButton(article));
    });
  }

  // O feed é dinâmico (rolagem infinita e SPA): reavalia a cada mutação do DOM.
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(scan);
  }

  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
  scan();
})();
