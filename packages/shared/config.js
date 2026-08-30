require('./env').loadEnv();
const path = require('path');

// All tunables live here. Change in code, not in a settings UI (KISS).
module.exports = {
  REPO_ROOT: path.resolve(__dirname, '..', '..'),

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
  BROWSER_STALE_MS: 75_000,         // no heartbeat for this long = disconnected

  // Gateway
  GATEWAY_PORT: 4519,
  GATEWAY_URL: process.env.FREN_GATEWAY_URL || 'http://127.0.0.1:4519',
  GATEWAY_TOKEN: process.env.FREN_GATEWAY_TOKEN || 'dev-token',
  // Explicit override only — each provider falls back to its own default,
  // so switching providers doesn't require also changing the model.
  MODEL: process.env.FREN_MODEL || '',
  DEEPSEEK_BASE_URL: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
};
