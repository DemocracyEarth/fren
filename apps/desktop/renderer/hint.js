'use strict';
// Fills the tooltip from its query string. A separate file because the CSP
// (rightly) refuses inline script; everything here treats the query as text.
const q = new URLSearchParams(location.search);
const card = document.getElementById('card');
const note = q.get('n');
const thought = q.get('t');
if (thought) {
  // A passing thought: the comic cloud, its trail aimed at the orb below.
  document.body.classList.add('thought');
  const cloud = document.getElementById('cloud');
  cloud.querySelector('.thought-text').textContent = thought;   // model output: text only
  const tx = Number(q.get('tx'));
  const rect = cloud.getBoundingClientRect();
  const aim = Number.isFinite(tx) ? tx - rect.left : rect.width - 22;
  if (window.FrenCloud) {
    window.FrenCloud.decorate(cloud, {
      trail: { x: Math.max(18, Math.min(rect.width - 18, aim)), side: 'below' },
    });
  }
} else if (note) {
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
