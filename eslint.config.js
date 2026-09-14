'use strict';
/**
 * Correctness only. This is not a style guide: it exists because a
 * ReferenceError in a rarely-run handler once reached a live conversation,
 * and `no-undef` would have caught it at the desk. Main-process and gateway
 * code is CommonJS under Node; the renderer is browser ES modules.
 */
const globals = require('globals');

module.exports = [
  {
    ignores: ['node_modules/**', 'vendor/**', 'dist-app/**', 'packaging/**', 'apps/desktop/renderer/vendor/**', '**/*.min.js'],
  },
  {
    files: ['**/*.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'commonjs', globals: { ...globals.node, ...globals.es2024 } },
    rules: {
      'no-undef': 'error',
      'no-dupe-keys': 'error',
      'no-dupe-args': 'error',
      'no-duplicate-case': 'error',
      'no-unreachable': 'error',
      'no-redeclare': ['error', { builtinGlobals: false }],   // the extension re-binds `chrome` on purpose
      'no-const-assign': 'error',
      'no-func-assign': 'error',
      'no-import-assign': 'error',
      'no-self-assign': 'error',
      'no-unsafe-negation': 'error',
      'use-isnan': 'error',
      'valid-typeof': 'error',
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['apps/desktop/renderer/**/*.js', 'dev/orb3d/**/*.js'],
    languageOptions: { sourceType: 'module', globals: { ...globals.browser, ...globals.es2024 } },
  },
  {
    // Service worker + content scripts: importScripts brings FrenExtract in.
    files: ['apps/browser-extension/**/*.js'],
    languageOptions: { sourceType: 'script', globals: { ...globals.browser, ...globals.serviceworker, ...globals.webextensions, ...globals.es2024, FrenExtract: 'readonly' } },
  },
  {
    // Benches run in a browser or against a DOM shim; they see both worlds.
    files: ['dev/bench/**/*.js'],
    languageOptions: { globals: { ...globals.node, ...globals.browser, ...globals.es2024 } },
  },
  {
    files: ['apps/desktop/preload.js'],
    languageOptions: { sourceType: 'commonjs', globals: { ...globals.node, ...globals.browser } },
  },
];
