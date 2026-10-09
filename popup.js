'use strict';

const $links = document.getElementById('links');
const $start = document.getElementById('start');
const $stop = document.getElementById('stop');
const $clear = document.getElementById('clear');
const $log = document.getElementById('log');
const $summary = document.getElementById('summary');

let saveTimer = null;

function appendLog(entry) {
  const nearBottom = $log.scrollHeight - $log.scrollTop - $log.clientHeight < 40;
  const line = document.createElement('div');
  line.className = 'line';

  const time = document.createElement('span');
  time.className = 'time';
  time.textContent = new Date(entry.t).toLocaleTimeString('pt-BR');

  const text = document.createElement('span');
  text.className = entry.level || 'info';
  text.textContent = entry.text;

  line.append(time, text);
  $log.appendChild(line);
  if (nearBottom) $log.scrollTop = $log.scrollHeight;
}

function renderState(state) {
  $start.disabled = state.running;
  $stop.disabled = !state.running;
  const s = state.stats || { ok: 0, fail: 0 };
  $summary.replaceChildren();
  if (state.running || s.ok || s.fail) {
    const ok = document.createElement('b');
    ok.className = 'ok';
    ok.textContent = `${s.ok} baixado(s)`;
    const fail = document.createElement('b');
    fail.className = 'fail';
    fail.textContent = `${s.fail} falha(s)`;
    $summary.append(ok, ' · ', fail);
  }
}

function send(message) {
  return chrome.runtime.sendMessage(message).catch(() => null);
}

$links.addEventListener('input', () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => chrome.storage.local.set({ urlsText: $links.value }), 200);
});

$start.addEventListener('click', async () => {
  await chrome.storage.local.set({ urlsText: $links.value });
  await send({ type: 'start', text: $links.value });
});

$stop.addEventListener('click', () => send({ type: 'stop' }));

$clear.addEventListener('click', async () => {
  $links.value = '';
  await chrome.storage.local.set({ urlsText: '' });
  await send({ type: 'clear' });
});

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg) return;
  if (msg.type === 'log') appendLog(msg.entry);
  else if (msg.type === 'state') renderState(msg);
  else if (msg.type === 'cleared') $log.replaceChildren();
});

(async () => {
  const saved = await chrome.storage.local.get('urlsText');
  $links.value = saved.urlsText || '';

  const state = await send({ type: 'getState' });
  if (state) {
    $log.replaceChildren();
    (state.log || []).forEach(appendLog);
    $log.scrollTop = $log.scrollHeight;
    renderState(state);
  }
})();
