'use strict';
// Roda no "world" MAIN (document_start) em x.com / twitter.com.
// Envolve fetch e XMLHttpRequest só para LER as respostas GraphQL que a própria página já faz
// (TweetDetail / TweetResultByRestId). Não usa query IDs nem tokens fixos.
(() => {
  if (window.__svdXCapture) return;
  window.__svdXCapture = true;

  const MARK = 'svd-x-capture';

  const wanted = (url) =>
    typeof url === 'string' &&
    url.includes('/graphql/') &&
    (url.includes('TweetDetail') || url.includes('TweetResultByRestId'));

  function screenNameOf(node) {
    const u = node.core && node.core.user_results && node.core.user_results.result;
    return (u && ((u.legacy && u.legacy.screen_name) || (u.core && u.core.screen_name))) || null;
  }

  function slimMedia(list) {
    return (Array.isArray(list) ? list : []).map((m) => ({
      type: m.type,
      media_url_https: m.media_url_https,
      video_info: m.video_info ? { variants: m.video_info.variants } : undefined,
    }));
  }

  // Percorre o JSON atrás de objetos de tweet (rest_id + legacy) e de tombstones.
  function collect(root) {
    const tweets = [];
    let tombstone = false;
    const walk = (node, depth) => {
      if (!node || typeof node !== 'object' || depth > 40) return;
      if (Array.isArray(node)) {
        for (const n of node) walk(n, depth + 1);
        return;
      }
      if (node.__typename === 'TweetTombstone') tombstone = true;
      if (typeof node.rest_id === 'string' && node.legacy && typeof node.legacy === 'object') {
        const l = node.legacy;
        const media = (l.extended_entities && l.extended_entities.media) || (l.entities && l.entities.media) || [];
        tweets.push({
          id: node.rest_id,
          screenName: screenNameOf(node),
          media: slimMedia(media),
          quotedId: l.quoted_status_id_str || null,
        });
      }
      for (const k in node) walk(node[k], depth + 1);
    };
    walk(root, 0);
    return { tweets, tombstone };
  }

  function report(url, json) {
    try {
      const { tweets, tombstone } = collect(json);
      // Tombstone só vale para o endpoint de tweet único (no TweetDetail pode ser de uma resposta).
      const single = url.includes('TweetResultByRestId');
      window.postMessage(
        { source: MARK, payload: { endpoint: single ? 'single' : 'detail', tweets, tombstone: single && tombstone } },
        window.location.origin
      );
    } catch {
      /* nunca atrapalha a página */
    }
  }

  const origFetch = window.fetch;
  window.fetch = function (...args) {
    const p = origFetch.apply(this, args);
    try {
      const req = args[0];
      const url = typeof req === 'string' ? req : (req && req.url) || String(req);
      if (wanted(url)) {
        p.then((r) => r.clone().json()).then((j) => report(url, j)).catch(() => {});
      }
    } catch {
      /* ignora */
    }
    return p;
  };

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    try {
      this.__svdUrl = String(url);
    } catch {
      /* ignora */
    }
    return origOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    if (wanted(this.__svdUrl)) {
      this.addEventListener('load', () => {
        try {
          report(this.__svdUrl, JSON.parse(this.responseText));
        } catch {
          /* resposta não-JSON */
        }
      });
    }
    return origSend.apply(this, args);
  };
})();
