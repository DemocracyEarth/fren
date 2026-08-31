'use strict';
// The debug window: backlog first, then every line as it happens. Sticks to
// the bottom unless the reader has scrolled up to study something.
const lines = document.getElementById('lines');
const nearBottom = () =>
  window.innerHeight + window.scrollY >= document.body.scrollHeight - 40;
function add(line) {
  const stick = nearBottom();
  lines.appendChild(document.createTextNode(line + '\n'));
  if (stick) window.scrollTo(0, document.body.scrollHeight);
}
(async () => {
  try { for (const line of await window.fren.debugLog()) add(line); } catch { /* empty is fine */ }
  window.fren.onDebugLine(add);
  window.scrollTo(0, document.body.scrollHeight);
})();
