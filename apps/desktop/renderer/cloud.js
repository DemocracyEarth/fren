'use strict';
/**
 * A comic thought-cloud, drawn to fit whatever it holds.
 *
 * The chat's thought bubbles and the peek beside the orb both wear this, so it
 * lives in one classic script both pages load (app.js is a module; hint.js is
 * not — a global is the one thing they can share). The shape is built, not
 * stretched: an outline of outward arcs around the text's own box, one bump
 * every BUMP px, so a two-word thought and a two-line one are both puffy rather
 * than one of them squashed. A trail of shrinking circles leads toward whoever
 * is thinking it.
 */
(function () {
  const BUMP = 24;      // target width of one puff along an edge
  const MARGIN = 12;    // room outside the text box for the puffs to bulge into
  const STROKE = 2;

  /** The scalloped outline of a w×h box with the puffs bulging out by ~MARGIN. */
  function path(w, h, m = MARGIN) {
    const nx = Math.max(2, Math.round(w / BUMP));
    const ny = Math.max(1, Math.round(h / BUMP));
    // Radius a little over half the chord, so each arc bows out rather than
    // lying flat; sweep=1 keeps the bow on the outside going clockwise.
    const rx = (w / nx) * 0.64;
    const ry = (h / ny) * 0.64;
    const arc = (r, x, y) => ` A ${r.toFixed(2)} ${r.toFixed(2)} 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)}`;
    let d = `M ${m} ${m}`;
    for (let i = 1; i <= nx; i++) d += arc(rx, m + (w * i) / nx, m);
    for (let i = 1; i <= ny; i++) d += arc(ry, m + w, m + (h * i) / ny);
    for (let i = 1; i <= nx; i++) d += arc(rx, m + w - (w * i) / nx, m + h);
    for (let i = 1; i <= ny; i++) d += arc(ry, m, m + h - (h * i) / ny);
    return d + ' Z';
  }

  /**
   * Dress `el` (already laid out, holding its text) as a cloud. The SVG sits
   * behind the text, sized to the element plus the margin, plus room below for
   * the trail. `trail` says where the thinker is: an x within the element's own
   * box (default: a little in from the right), and whether they are 'below'
   * (the usual) or 'above'.
   */
  function decorate(el, { trail = {}, fill = '#fff', stroke = null } = {}) {
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    if (!w || !h) return null;
    const m = MARGIN;
    const trailH = 30;
    const side = trail.side === 'above' ? 'above' : 'below';
    const tx = Number.isFinite(trail.x) ? trail.x : w - 22;   // in element coords
    const W = w + 2 * m;
    const H = h + 2 * m + trailH;
    const ink = stroke || (getComputedStyle(el).getPropertyValue('--cloud-ink').trim() || '#2b241b');

    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'cloud');
    svg.setAttribute('width', W);
    svg.setAttribute('height', H);
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('aria-hidden', 'true');
    // The cloud body. Offset down by trailH when the thinker is above, so the
    // trail has room at the top instead.
    const oy = side === 'above' ? trailH : 0;
    const body = document.createElementNS(NS, 'path');
    body.setAttribute('d', path(w, h, m));
    body.setAttribute('transform', `translate(0 ${oy})`);
    body.setAttribute('fill', fill);
    body.setAttribute('stroke', ink);
    body.setAttribute('stroke-width', STROKE);
    body.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(body);
    // The trail: three circles, each smaller and further along toward the thinker.
    const cx0 = m + tx;
    const steps = [[0, 7.5], [1, 5], [2, 3.2]];
    for (const [i, r] of steps) {
      const c = document.createElementNS(NS, 'circle');
      const dy = 4 + i * 9;
      const cy = side === 'above' ? (oy + 0) - dy - r + 2 : (m + h + m) + dy + r - 4;
      c.setAttribute('cx', (cx0 + i * 5).toFixed(1));
      c.setAttribute('cy', cy.toFixed(1));
      c.setAttribute('r', r);
      c.setAttribute('fill', fill);
      c.setAttribute('stroke', ink);
      c.setAttribute('stroke-width', STROKE);
      svg.appendChild(c);
    }
    svg.style.position = 'absolute';
    svg.style.left = `-${m}px`;
    svg.style.top = `-${m + (side === 'above' ? trailH : 0)}px`;
    svg.style.pointerEvents = 'none';
    svg.style.zIndex = '0';
    el.style.position = 'relative';
    for (const child of [...el.children]) if (child.classList && child.classList.contains('cloud')) child.remove();
    el.insertBefore(svg, el.firstChild);
    return svg;
  }

  window.FrenCloud = { path, decorate, MARGIN, BUMP };
})();
