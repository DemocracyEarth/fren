'use strict';
/**
 * Observations: the input abstraction for everything FREN notices.
 *
 * Producers (later: the active-window observer, the browser extension, the
 * clipboard, file activity, the user) publish; consumers (later: a context
 * selector that picks what an agent may see, an event trigger that fires an
 * automation) subscribe. Nothing is sent to a model by publishing here.
 *
 * Today the bus is the abstraction only. It validates, keeps a bounded
 * in-memory ring for consumers that arrive late, and forwards. Privacy is
 * the default: an observation that nobody selected goes nowhere, and the
 * ring forgets on its own.
 *
 * @typedef {{ timestamp: number, source: 'browser'|'os'|'app'|'user', type: string, payload: unknown }} Observation
 */
const SOURCES = new Set(['browser', 'os', 'app', 'user']);

function isObservation(o) {
  return !!o && typeof o === 'object'
    && typeof o.timestamp === 'number' && Number.isFinite(o.timestamp)
    && SOURCES.has(o.source)
    && typeof o.type === 'string' && o.type.length > 0 && o.type.length <= 80;
}

function createObservationBus({ maxItems = 5000, maxAgeMs = 24 * 3600 * 1000, now = Date.now } = {}) {
  const ring = [];
  const subscribers = new Set();

  function forget() {
    const cutoff = now() - maxAgeMs;
    while (ring.length && ring[0].timestamp < cutoff) ring.shift();
    while (ring.length > maxItems) ring.shift();
  }

  function matches(filter, obs) {
    if (!filter) return true;
    if (filter.source && filter.source !== obs.source) return false;
    if (filter.type && filter.type !== obs.type) return false;
    return true;
  }

  return {
    /** Returns false (and drops it) when the shape is wrong. */
    publish(obs) {
      if (!isObservation(obs)) return false;
      const clean = { timestamp: obs.timestamp, source: obs.source, type: obs.type, payload: obs.payload };
      ring.push(clean);
      forget();
      for (const s of [...subscribers]) {
        if (matches(s.filter, clean)) {
          try { s.fn(clean); } catch { /* a consumer's bug stays its own */ }
        }
      }
      return true;
    },
    subscribe(filter, fn) {
      const sub = { filter: filter || null, fn };
      subscribers.add(sub);
      return () => subscribers.delete(sub);
    },
    recent({ source, type, limit = 100 } = {}) {
      forget();
      const out = [];
      for (let i = ring.length - 1; i >= 0 && out.length < limit; i -= 1) {
        if (matches({ source, type }, ring[i])) out.push(ring[i]);
      }
      return out;
    },
    size: () => ring.length,
  };
}

module.exports = { createObservationBus, isObservation, SOURCES };
