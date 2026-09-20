'use strict';
/*
 * The settings window: which models fren runs on, and nothing else. Reads live
 * values from the gateway (through main) for the placeholders, saves overrides
 * on change, and echoes what was actually KEPT — a rejected value must look
 * rejected.
 */
const FIELDS = ['chatModel', 'voiceId', 'voiceModel', 'whisperModel', 'whisperLang'];
const el = (id) => document.getElementById(id);

/**
 * Ids people are actually likely to want, offered as suggestions.
 *
 * A suggestion list, never a closed set — the field takes anything that looks
 * like an id, because these change and a hard-coded dropdown would rot into a
 * list of models you can no longer pick. Each of these was checked against the
 * live API rather than remembered.
 */
const KNOWN_MODELS = {
  deepseek: [
    'deepseek-v4-pro',
    'deepseek-v4-flash',
    'deepseek-v4-flash-vision-exp',
    // Still accepted, and what older setups will have.
    'deepseek-chat',
    'deepseek-reasoner',
  ],
  anthropic: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'],
};
const KNOWN_VOICE_MODELS = ['eleven_flash_v2_5', 'eleven_turbo_v2_5', 'eleven_multilingual_v2'];
const KNOWN_LANGS = ['en', 'es', 'fr', 'de', 'it', 'pt'];

function suggest(listId, options) {
  const list = el(listId);
  list.textContent = '';
  for (const o of options) {
    const opt = document.createElement('option');
    opt.value = o;
    list.appendChild(opt);
  }
}

/** What is saved for each field, so leaving a field untouched writes nothing. */
const kept = {};

function paint(id, saved) {
  kept[id] = saved || '';
  el(id).value = kept[id];
  const s = el('s-' + id);
  s.textContent = saved ? 'yours' : 'default';
  s.className = 'state' + (saved ? ' on' : '');
  el('r-' + id).hidden = !saved;
}

/**
 * The placeholder is the LIVE default rather than invented text, so an empty
 * field reads as "whatever fren is already using" instead of "nothing". That
 * is the whole trick to making optional settings feel safe — you can always
 * see what you get by leaving it alone.
 */
function hint(id, inUse, otherwise) {
  el(id).placeholder = inUse ? `${inUse}  (in use now)` : otherwise;
}

/**
 * Read what is chosen and what is running. The fields themselves are painted
 * only on the first read: a refresh after a save lands while the person may
 * already be typing in the next field, and must not type over them.
 */
async function load({ fields = false } = {}) {
  let cfg = null;
  try { cfg = await window.fren.getProviders(); } catch { /* below */ }
  if (!cfg) return;
  const live = cfg.inEffect;
  const chosen = cfg.chosen || {};

  // "Running right now" means the choice where there is one, else the default.
  const model = live ? (chosen.chatModel || live.model) : null;
  el('live-chat').textContent = live
    ? `${live.provider} · ${model}`
    : 'the gateway is not answering — saved choices still apply when it is back';
  el('live-chat').classList.toggle('off', !live);
  suggest('chatModel-list', live && KNOWN_MODELS[live.provider]
    ? KNOWN_MODELS[live.provider]
    : [...KNOWN_MODELS.deepseek, ...KNOWN_MODELS.anthropic]);
  hint('chatModel', live && live.model, 'using the default');

  const hasVoice = !!(live && live.voice);
  el('live-voice').textContent = hasVoice
    ? `${live.voice} · ${chosen.voiceId || live.voiceId || '?'} · ${chosen.voiceModel || live.voiceModel || '?'}`
    : 'no voice configured';
  el('live-voice').classList.toggle('off', !hasVoice);
  hint('voiceId', live && live.voiceId, 'using the default');
  hint('voiceModel', live && live.voiceModel, 'using the default');

  const w = cfg.whisper || {};
  el('live-whisper').textContent = w.ready
    ? 'whisper is ready on this machine'
    : `whisper is not ready${w.reason ? ` — ${w.reason}` : ''}`;
  el('live-whisper').classList.toggle('off', !w.ready);
  hint('whisperModel', w.model, 'path to a ggml .bin model');

  if (fields) for (const f of FIELDS) paint(f, chosen[f]);
}

suggest('voiceModel-list', KNOWN_VOICE_MODELS);
suggest('whisperLang-list', KNOWN_LANGS);

for (const f of FIELDS) {
  // `change` and `blur` both fire when a typed value is left, and blur fires
  // on a field nobody touched; only a value that differs is worth a write.
  const save = async () => {
    const value = el(f).value.trim();
    if (value === (kept[f] || '')) return;
    try {
      // Show what was KEPT, not what was typed: a value fren rejected has to
      // look rejected, or you spend an evening wondering why nothing changed.
      const saved = await window.fren.setProviders({ [f]: value });
      paint(f, (saved || {})[f]);
      load();                          // refresh the "in effect" lines
    } catch { el('s-' + f).textContent = 'could not save'; }
  };
  el(f).addEventListener('change', save);
  el(f).addEventListener('blur', save);
  el('r-' + f).addEventListener('click', () => { el(f).value = ''; save(); });
}

load({ fields: true });
