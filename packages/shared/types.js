/**
 * Shared JSDoc typedefs — no runtime exports. This file exists so humans and
 * editors share one vocabulary across modules.
 *
 * @typedef {Object} Observation
 * @property {number} id
 * @property {number} ts              epoch ms
 * @property {string} activeApp
 * @property {string} [windowTitle]
 * @property {string} [screenshotPath] local file path; screenshots never leave the machine
 *
 * @typedef {Object} ActivitySummary
 * @property {string} activity        e.g. "debugging the auth flow in VS Code and Chrome"
 * @property {string[]} applications
 * @property {number} confidence      0..1
 *
 * @typedef {'sleeping'|'watching'|'thinking'|'idea'} MascotState
 *
 * @typedef {Object} AppState
 * @property {boolean} observing      MUST match actual capture state (privacy invariant)
 * @property {MascotState} mascot
 * @property {boolean} panelOpen
 * @property {boolean} gatewayOk
 */
module.exports = {};
