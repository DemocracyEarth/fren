require('./env').loadEnv();
const os = require('os');
const path = require('path');

/**
 * Where FREN keeps its files. The desktop's app data folder (productName
 * "fren"), which the gateway/Core process cannot ask Electron for, so both
 * derive it the same way and FREN_DATA_DIR overrides both.
 */
function defaultDataDir() {
  const home = os.homedir();
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'fren');
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'fren');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'fren');
}

// All tunables live here. Change in code, not in a settings UI (KISS).
module.exports = {
  REPO_ROOT: path.resolve(__dirname, '..', '..'),
  DATA_DIR: process.env.FREN_DATA_DIR || defaultDataDir(),

  // Observation sampling
  SAMPLE_INTERVAL_MS: 5_000,        // active app/window sample cadence
  SCREENSHOT_EVERY_N_SAMPLES: 3,    // screenshot every 3rd sample (~15s)
  SCREENSHOT_MAX_WIDTH: 1280,
  SCREENSHOT_JPEG_QUALITY: 60,

  // Semantic summarization
  SUMMARIZE_INTERVAL_MS: 120_000,   // how often raw observations become a memory
  SUMMARIZE_MIN_OBSERVATIONS: 4,    // skip summarizing tiny batches

  // Retention
  OBSERVATION_RETENTION_DAYS: 7,
  MAX_SCREENSHOTS_KEPT: 200,

  // Browser awareness (the extension <-> desktop loopback channel)
  BROWSER_SENSOR_PORT: 4526,
  BROWSER_CONTENT_MAX_CHARS: 24_000,
  BROWSER_SELECTION_MAX_CHARS: 2_000,
  BROWSER_HEARTBEAT_MS: 30_000,
  // The extension's Web Store page. Empty until published: first-run onboarding
  // then guides the developer load-unpacked path. Set it (or FREN_BROWSER_STORE_URL)
  // and onboarding flips to a one-click "Add to Chrome" with no other change.
  BROWSER_EXTENSION_STORE_URL: process.env.FREN_BROWSER_STORE_URL || '',
  BROWSER_STALE_MS: 75_000,         // no heartbeat for this long = disconnected

  // Gateway
  // FREN_GATEWAY_PORT lets a second copy run beside a live one (tests, smoke
  // checks); the URL the desktop dials follows it unless set explicitly.
  GATEWAY_PORT: Number(process.env.FREN_GATEWAY_PORT) || 4519,
  GATEWAY_URL: process.env.FREN_GATEWAY_URL || `http://127.0.0.1:${Number(process.env.FREN_GATEWAY_PORT) || 4519}`,
  GATEWAY_TOKEN: process.env.FREN_GATEWAY_TOKEN || 'dev-token',
  // Explicit override only — each provider falls back to its own default,
  // so switching providers doesn't require also changing the model.
  MODEL: process.env.FREN_MODEL || '',
  DEEPSEEK_BASE_URL: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
};
