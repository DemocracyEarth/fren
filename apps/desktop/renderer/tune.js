'use strict';
/*
 * TEMPORARY: the colour workshop's logic. Reads the controls, streams every
 * change to the orb, keeps a paste-ready recipe in the box. Delete with
 * tune.html when the palette is settled.
 */
const IDS = ['goldH', 'goldS', 'goldL', 'coralH', 'coralS', 'coralL',
             'ambient', 'key', 'fill', 'clearcoat', 'coatRough', 'rough', 'sheen'];
const el = (id) => document.getElementById(id);
const DEFAULTS = {};
for (const id of IDS) DEFAULTS[id] = Number(el(id).value);
DEFAULTS.baseHex = el('baseHex').value;

function values() {
  const out = {};
  for (const id of IDS) out[id] = Number(el(id).value);
  out.baseHex = el('baseHex').value;
  return out;
}

function send() {
  const v = values();
  const params = { ...v, baseHex: parseInt(v.baseHex.slice(1), 16) };
  window.fren.sendTune(params).catch(() => { /* orb not up yet */ });
  for (const id of IDS) el('o-' + id).value = String(v[id]);
  el('o-baseHex').value = v.baseHex;
  el('recipe').value = JSON.stringify(v, null, 1);
}

for (const id of [...IDS, 'baseHex']) el(id).addEventListener('input', send);

el('copy').addEventListener('click', async () => {
  await navigator.clipboard.writeText(el('recipe').value);
  el('copied').hidden = false;
  setTimeout(() => { el('copied').hidden = true; }, 1200);
});

el('reset').addEventListener('click', () => {
  for (const id of IDS) el(id).value = DEFAULTS[id];
  el('baseHex').value = DEFAULTS.baseHex;
  send();
});

send();
