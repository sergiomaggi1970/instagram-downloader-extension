'use strict';
// Testa content-x-capture.js (world MAIN) e content-x-bridge.js num "window" simulado.
// Rode com: node tests/capture.js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as x from '../platforms/x.js';

const root = new URL('..', import.meta.url).pathname;
const posted = [];
const sent = [];

const graphql = {
  data: {
    threaded_conversation_with_injections_v2: {
      instructions: [{
        entries: [{
          content: { itemContent: { tweet_results: { result: {
            __typename: 'TweetWithVisibilityResults',
            tweet: {
              rest_id: '1900000000000000001',
              core: { user_results: { result: { legacy: { screen_name: 'ana' } } } },
              legacy: {
                full_text: 'oi',
                quoted_status_id_str: '1900000000000000002',
                extended_entities: { media: [{ type: 'video', media_url_https: 'https://pbs/x.jpg', id_str: '1',
                  video_info: { variants: [
                    { content_type: 'application/x-mpegURL', url: 'https://v/a.m3u8' },
                    { bitrate: 832000, content_type: 'video/mp4', url: 'https://v/mid.mp4' },
                    { bitrate: 2176000, content_type: 'video/mp4', url: 'https://v/high.mp4' } ] } }] },
              },
              quoted_status_result: { result: {
                rest_id: '1900000000000000002',
                core: { user_results: { result: { core: { screen_name: 'bia' } } } },
                legacy: { full_text: 'citado', entities: { media: [{ type: 'photo', media_url_https: 'https://pbs.twimg.com/media/Q.jpg' }] } },
              } },
            },
          } } } },
        }],
      }],
    },
  },
};

const win = {
  location: { origin: 'https://x.com' },
  postMessage: (data, origin) => posted.push({ data, origin }),
  addEventListener: (t, f) => listeners.push([t, f]),
  fetch: async () => ({ clone: () => ({ json: async () => graphql }) , json: async () => graphql }),
};
class XHR { open() {} send() {} addEventListener() {} }
const ctx = vm.createContext({ window: win, XMLHttpRequest: XHR, chrome: { runtime: { sendMessage: async (m) => sent.push(m) } } });
vm.runInContext(fs.readFileSync(root + 'content-x-capture.js', 'utf8'), ctx);

// requisição que não interessa: não captura
await win.fetch('https://x.com/i/api/graphql/abc/HomeTimeline');
await new Promise((r) => setTimeout(r, 20));
assert.equal(posted.length, 0, 'não deve capturar HomeTimeline');
// requisição TweetDetail: captura
const r = await win.fetch('https://x.com/i/api/graphql/abc/TweetDetail?variables=1');
assert.ok(r, 'a resposta original continua chegando à página');
await new Promise((r2) => setTimeout(r2, 20));
assert.equal(posted.length, 1);
const { data, origin } = posted[0];
assert.equal(origin, 'https://x.com');
assert.equal(data.source, 'svd-x-capture');
const byId = Object.fromEntries(data.payload.tweets.map((t) => [t.id, t]));
assert.deepEqual(Object.keys(byId).sort(), ['1900000000000000001', '1900000000000000002']);
assert.equal(byId['1900000000000000001'].screenName, 'ana');
assert.equal(byId['1900000000000000001'].quotedId, '1900000000000000002');
assert.equal(byId['1900000000000000002'].screenName, 'bia');
assert.equal(data.payload.tombstone, false);

// o background escolhe o mp4 de maior bitrate a partir do que foi capturado
const tweets = new Map(data.payload.tweets.map((t) => [t.id, t]));
const ev = x.evaluateCapture(tweets, '1900000000000000001');
assert.equal(ev.status, 'ok');
assert.equal(ev.screenName, 'ana');
assert.deepEqual(ev.media.map((m) => m.url), ['https://v/high.mp4']);

// ponte isolada: só repassa mensagens da própria janela com a marca certa
const bridgeListeners = [];
const bridgeWin = { addEventListener: (t, f) => bridgeListeners.push([t, f]) };
vm.runInContext(fs.readFileSync(root + 'content-x-bridge.js', 'utf8'), vm.createContext({
  window: bridgeWin, chrome: { runtime: { sendMessage: async (m) => { sent.push(m); } } },
}));
const [type, handler] = bridgeListeners[0];
assert.equal(type, 'message');
handler({ source: {}, data: { source: 'svd-x-capture', payload: { a: 1 } } }); // outra janela → ignora
handler({ source: bridgeWin, data: { source: 'outra-coisa', payload: { a: 2 } } }); // marca errada → ignora
assert.equal(sent.length, 0);
handler({ source: bridgeWin, data: { source: 'svd-x-capture', payload: { a: 3 } } });
assert.equal(JSON.stringify(sent), JSON.stringify([{ type: 'xCapture', payload: { a: 3 } }]));
console.log('captura OK: 2 tweets extraídos, mp4 de maior bitrate, página não é afetada');
