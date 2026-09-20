'use strict';
// Fills the tooltip from its query string. A separate file because the CSP
// (rightly) refuses inline script; everything here treats the query as text —
// the note can be model output and the wake phrase comes from the environment,
// so every word goes in through textContent, never as markup.
const q = new URLSearchParams(location.search);
const card = document.getElementById('card');

/** One line of the card: [before, bold, after] parts, a dim middle dot between them. */
function row(parts) {
  const line = document.createElement('div');
  line.className = 'row';
  parts.forEach(([before, strong, after], i) => {
    if (i) {
      const dot = document.createElement('span');
      dot.className = 'dim';
      dot.textContent = ' · ';
      line.append(dot);
    }
    const b = document.createElement('b');
    b.textContent = strong;
    line.append(before, b, after);
  });
  return line;
}

const note = q.get('n');
if (note) {
  card.classList.add('note');
  card.textContent = note;
} else {
  // The voice row is main's decision (wake-info.js): it is here only while
  // saying the phrase, or holding the orb, would really open a line.
  const w = q.get('w');
  const phrase = q.get('p');
  if (w === 'say') card.append(row([['say ', phrase ? `“${phrase}”` : 'my wake word', ' to talk']]));
  else if (w === 'hold') card.append(row([['', 'hold', ' me for a conversation']]));
  if (card.childElementCount) card.classList.add('rows');

  const gestures = [];
  if (q.get('v') === '1') gestures.push(['', 'click', ' to talk']);
  gestures.push(['', 'right-click', ' to chat'], ['', 'scroll', ' to resize']);
  card.append(row(gestures));
}
if (q.get('b') === '1') document.body.classList.add('below');
const tx = Number(q.get('tx'));
if (Number.isFinite(tx)) {
  document.getElementById('tail').style.left = (tx - 6) + 'px';
}
