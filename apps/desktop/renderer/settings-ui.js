'use strict';
/*
 * The settings window: which models fren runs on. Reads live values from the
 * gateway (through main) for the placeholders, saves overrides on change, and
 * echoes what was actually KEPT — a rejected value must look rejected.
 */
const FIELDS = ['chatModel', 'voiceId', 'voiceModel', 'whisperModel', 'whisperLang'];
const el = (id) => document.getElementById(id);

function paint(id, saved) {
  el(id).value = saved || '';
  const s = el('s-' + id);
  s.textContent = saved ? 'yours' : 'default';
  s.className = 'state' + (saved ? ' on' : '');
}

async function load() {
  let cfg = null;
  try { cfg = await window.fren.getProviders(); } catch { /* below */ }
  if (!cfg) return;
  const live = cfg.inEffect;
  el('live-chat').textContent = live
    ? `${live.provider} · ${live.model}`
    : 'the gateway is not answering — saved choices still apply when it is back';
  el('live-chat').classList.toggle('off', !live);
  el('live-voice').textContent = live && live.voice
    ? `${live.voice} · ${live.voiceId || '?'} · ${live.voiceModel || '?'}`
    : 'no voice configured';
  el('live-voice').classList.toggle('off', !(live && live.voice));
  const w = cfg.whisper || {};
  el('live-whisper').textContent = w.ready
    ? 'whisper is ready on this machine'
    : `whisper is not ready${w.reason ? ` — ${w.reason}` : ''}`;
  el('live-whisper').classList.toggle('off', !w.ready);
  for (const f of FIELDS) paint(f, (cfg.chosen || {})[f]);
}

for (const f of FIELDS) {
  const save = async () => {
    try {
      const saved = await window.fren.setProviders({ [f]: el(f).value.trim() });
      paint(f, (saved || {})[f]);
      load();                          // refresh the "in effect" lines
    } catch { el('s-' + f).textContent = 'could not save'; }
  };
  el(f).addEventListener('change', save);
  el(f).addEventListener('blur', save);
}

el('reveal').addEventListener('click', () => window.fren.revealEnv());
load();
