'use strict';
// Fills the tooltip from its query string. A separate file because the CSP
// (rightly) refuses inline script; everything here treats the query as text.
const q = new URLSearchParams(location.search);
const card = document.getElementById('card');
const note = q.get('n');
if (note) {
  card.classList.add('note');
  card.textContent = note;         // textContent: the note can be model output
} else {
  const parts = [];
  if (q.get('v') === '1') parts.push('<b>click</b> to talk');
  parts.push('<b>right-click</b> to chat', '<b>scroll</b> to resize');
  card.innerHTML = parts.join(' <span class="dim">&middot;</span> ');
}
if (q.get('b') === '1') document.body.classList.add('below');
const tx = Number(q.get('tx'));
if (Number.isFinite(tx)) {
  document.getElementById('tail').style.left = (tx - 6) + 'px';
}
