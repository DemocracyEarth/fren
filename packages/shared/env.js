const fs = require('fs');
const path = require('path');

let loaded = false;

// Minimal .env loader (KEY=VALUE lines, # comments). Real environment
// variables always win over .env values.
function loadEnv(file = path.resolve(__dirname, '..', '..', '.env')) {
  if (loaded) return;
  loaded = true;
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return; // no .env is fine — dev defaults apply
  }
  for (const line of text.split('\n')) {
    if (line.trim().startsWith('#')) continue;
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const [, key, raw] = m;
    if (process.env[key] === undefined || process.env[key] === '') {
      process.env[key] = raw.replace(/^["']|["']$/g, '');
    }
  }
}

module.exports = { loadEnv };
