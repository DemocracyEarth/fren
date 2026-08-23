// Electron main process: creates the mascot window and wires the loop
// observe -> remember -> summarize -> chat. Owns the observation on/off state.
const path = require('path');
const { app, BrowserWindow, ipcMain, screen, protocol, net, shell, dialog } = require('electron');
const { pathToFileURL } = require('node:url');
const { config, loadEnv } = require('../../../packages/shared');
const { openMemory } = require('../../../packages/memory');
const state = require('./state');
const gateway = require('./gatewayClient');
const { createObserver } = require('./observer');
const { createSummarizer } = require('./summarizer');
const { createPatternWatcher } = require('./patterns');
const { createCuriosityWatcher } = require('./curiosity');
const { wakeOnLaunchFrom } = require('./wake');
const providerSettings = require('./settings');
const { createRoutineRunner, nextRunAt, isDue } = require('./routines');
const executor = require('./executor');
const whisper = require('./whisper');
const soul = require('./soul');
const screenCapture = require('./screen');
const audioOutput = require('./audio-output');

loadEnv();
// The desktop process must never hold provider credentials — only the gateway
// talks to the LLM provider. .env is shared with the gateway, so scrub here.
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_AUTH_TOKEN;
delete process.env.DEEPSEEK_API_KEY;
delete process.env.ELEVENLABS_API_KEY;

// The renderer is served over a custom scheme rather than loaded from disk.
// ES modules are blocked over file:// as cross-origin, so the 3D face -- which
// is a module, and imports three.js as one -- would silently never load and the
// app would quietly fall back to the SVG renderer. A standard scheme also gives
// the page a real origin, so the existing `script-src 'self'` CSP still applies.
const SCHEME = 'fren';
const RENDERER_DIR = path.join(__dirname, '..', 'renderer');

protocol.registerSchemesAsPrivileged([{
  scheme: SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true },
}]);

function serveRenderer() {
  protocol.handle(SCHEME, async (request) => {
    const url = new URL(request.url);
    const pathname = decodeURIComponent(url.pathname);

    // fren://shot/<path> serves a stored screenshot to the dashboard.
    //
    // This reads a file from a path that arrives in a URL, so it is confined
    // twice: only under the screenshots directory, and only files whose exact
    // path the database recorded. A traversal or a guessed path gets nothing,
    // and no other part of the disk is reachable through this scheme.
    if (url.hostname === 'shot') {
      const shotDir = path.join(app.getPath('userData'), 'screenshots');
      const file = path.resolve(pathname.replace(/^\//, ''));
      if (path.relative(shotDir, file).startsWith('..') || !path.isAbsolute(file)) {
        return new Response('forbidden', { status: 403 });
      }
      return net.fetch(pathToFileURL(file).toString());
    }

    const file = path.resolve(RENDERER_DIR, '.' + pathname);
    // Never serve anything outside the renderer directory.
    if (path.relative(RENDERER_DIR, file).startsWith('..')) {
      return new Response('forbidden', { status: 403 });
    }
    return net.fetch(pathToFileURL(file).toString());
  });
}

/**
 * How big fren is.
 *
 * The orb can be scrolled bigger or smaller and stays that way, so none of
 * these are constants any more — they are the size at scale 1. Everything that
 * used a constant now asks orbSize(), because a stale copy of the old size
 * means a window that no longer matches the character inside it.
 *
 * The bounds are a judgement about what fren still IS at either end. Below
 * about two thirds the eyes stop being readable and the expression — the whole
 * point of the character — is lost. Above double it stops being a thing in the
 * corner of your screen and becomes something you have to work around.
 */
const ORB_BASE = 150;
const ORB_ZONE_BASE = 144;      // the drag halo, from styles.css
const SCALE_MIN = 0.65;
const SCALE_MAX = 2.0;
let orbScale = 1;

const clampScale = (s) => Math.min(SCALE_MAX, Math.max(SCALE_MIN, Number(s) || 1));
const orbSize = () => {
  const n = Math.round(ORB_BASE * orbScale);
  return { width: n, height: n };
};
// The orb sits under the panel in the same window, so a bigger orb needs a
// taller window — otherwise growing it would push the conversation off the top.
const panelSize = () => ({
  width: PANEL_BASE.width,
  height: PANEL_BASE.height + Math.round(ORB_ZONE_BASE * orbScale),
});

// Wider than it was: the old 344 left the conversation cramped against both
// edges, and the design this is built to wants room to breathe.
// Height EXCLUDING the orb zone: 604 at scale 1, less the 144px halo.
const PANEL_BASE = { width: 384, height: 460 };
const MARGIN = 24;

let win = null;
let memory = null;
let gazeTimer = null;
let drag = null;
let dash = null;
let observer = null;
let summarizer = null;
let patterns = null;
let routines = null;
let curiosity = null;
let heartbeat = null;
// Set once the user has actually chosen to quit, so the dashboard's close
// handler does not ask again while app.quit() is closing that same window.
let quitting = false;
const bootAt = Date.now();
// When fren was last alive. Written on a heartbeat rather than on quit, because
// a crash, a force-quit or a logout all skip the tidy exit — and the greeting
// would then claim a gap of days that was really a gap of minutes.
let lastSeenAt = null;
// When the user last said something. Curiosity checks this so a question never
// lands in the middle of a conversation that is already going.
let lastChatAt = 0;
let automationTimer = null;
let automationTickBusy = false;

const log = (...args) => console.log(...args);

function positionWindow(size) {
  // Anchor to the bottom-right corner of the primary display's work area.
  const { workArea } = screen.getPrimaryDisplay();
  win.setBounds({
    x: workArea.x + workArea.width - size.width - MARGIN,
    y: workArea.y + workArea.height - size.height - MARGIN,
    ...size,
  });
}

function createWindow() {
  win = new BrowserWindow({
    ...orbSize(),
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    hasShadow: false,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // Forward the renderer's voice tracing into the run log, so a hold-to-talk
  // failure can be read afterwards rather than reproduced.
  win.webContents.on('console-message', (...args) => {
    const msg = typeof args[0] === 'object' && args[0] && args[0].message ? args[0].message : args[2];
    if (msg && String(msg).startsWith('[voice]')) log(String(msg));
  });
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadURL(`${SCHEME}://app/index.html`);
  positionWindow(orbSize());
}

function orbCenter() {
  const b = win.getBounds();
  const { width, height } = orbSize();
  return { x: b.x + b.width - width / 2, y: b.y + b.height - height / 2 };
}

/**
 * Let fren glance at the pointer, so it reads as paying attention to your
 * work. The cursor position is used for gaze only — never stored, never
 * summarized, never sent anywhere — and it is only sampled while observing,
 * because closed eyes have nothing to follow.
 */
function startGaze() {
  if (gazeTimer) return;
  const FALLOFF = 420;   // px at which the eyes are fully deflected
  let lastX = 0;
  let lastY = 0;
  gazeTimer = setInterval(() => {
    if (!win || win.isDestroyed() || drag) return;
    const c = screen.getCursorScreenPoint();
    const o = orbCenter();
    const nx = Math.max(-1, Math.min(1, (c.x - o.x) / FALLOFF));
    const ny = Math.max(-1, Math.min(1, (c.y - o.y) / FALLOFF));
    if (Math.abs(nx - lastX) < 0.02 && Math.abs(ny - lastY) < 0.02) return;
    lastX = nx;
    lastY = ny;
    win.webContents.send('fren:cursor', { x: nx, y: ny });
  }, 70);
}

function stopGaze() {
  if (gazeTimer) clearInterval(gazeTimer);
  gazeTimer = null;
  if (win && !win.isDestroyed()) win.webContents.send('fren:cursor', null);
}

function startObserving() {
  observer.start();
  startGaze();
  state.set({ observing: true }); // mascot is computed from this
}

function stopObserving() {
  observer.stop();
  stopGaze();
  state.set({ observing: false });
}

app.whenReady().then(() => {
  serveRenderer();
  memory = openMemory(path.join(app.getPath('userData'), 'fren.db'));

  observer = createObserver({
    onObservation: (obs) => memory.addObservation(obs),
    log,
  });
  summarizer = createSummarizer({
    memory,
    log,
    // Every summary also lands in memory/YYYY-MM-DD.md, so a day fren spent
    // with you can be read as a document rather than queried out of SQLite.
    onSummary: (activity, ts) => soul.appendDailyLog(app.getPath('userData'), activity, ts),
  });
  summarizer.start();

  // The whole point of the product: notice a repeated workflow nobody
  // mentioned, and say something about it. It only ever looks while observing,
  // and it tells the renderer rather than deciding for itself whether to
  // interrupt — how forward to be is the user's call, recorded in SOUL.md.
  patterns = createPatternWatcher({
    memory,
    gateway,
    state,
    log,
    onSuggestion: ({ message, pattern }) => {
      if (win && !win.isDestroyed()) {
        win.webContents.send('fren:suggestion', { message, pattern });
      }
    },
  });
  patterns.start();

  // Curiosity. Patterns exist to be useful; this exists to know you. It asks a
  // question rather than making a suggestion, and what comes back is written
  // into MEMORY.md — the first-run interview, continued slowly over months.
  //
  // Every gate below fails toward silence, and `canAsk` is the one that keeps
  // it from talking over a conversation already in progress.
  curiosity = createCuriosityWatcher({
    memory,
    gateway,
    state,
    log,
    soulFor: () => soul.readContext(app.getPath('userData')).soul,
    profileFor: () => memory.getSetting('profile'),
    canAsk: () => Date.now() - lastChatAt > 4 * 60 * 1000,
    onQuestion: ({ question, about }) => {
      if (win && !win.isDestroyed()) {
        win.webContents.send('fren:curious', { question, about });
      }
    },
  });
  curiosity.start();

  // Routines: the same questions, at times the user chose. The runner refuses
  // to fire while paused, and a missed one expires rather than arriving hours
  // late — see routines.js.
  routines = createRoutineRunner({
    memory,
    state,
    log,
    run: async (routine) => {
      const reply = await answer(routine.prompt);
      if (win && !win.isDestroyed()) {
        win.webContents.send('fren:routineRan', { name: routine.name, text: reply });
      }
      return reply;
    },
  });
  routines.start();

  // Scheduled execution rides the same clock and the same rules as routines:
  // nothing fires while fren is paused, and a missed run expires rather than
  // arriving hours late. Crucially it still goes through runAutomation, so the
  // approval hash is re-checked against the current script at the moment of
  // running — a schedule is permission to run a SPECIFIC script, not a standing
  // permission to run whatever now sits under that name.
  automationTimer = setInterval(async () => {
    // The tick is async and nothing awaits it, so without this the next tick
    // starts while this one is still inside a running script.
    if (automationTickBusy) return;
    if (!state.get().observing) return;
    // fren now starts awake, and `observing` is what gates scheduled runs — so
    // without this, "runs while I have fren watching" quietly became "runs on
    // every launch", and a slot missed while the machine was off would fire
    // during the first seconds of the next boot. The grace is small on purpose:
    // enough to notice and pause, no change at all for a fren left running.
    if (Date.now() - bootAt < 2 * 60 * 1000) return;

    let due = [];
    try {
      due = memory.getAutomations().filter((a) => {
        if (!a.schedule || !a.schedule.enabled || !a.verified) return false;
        return isDue({ ...a.schedule, enabled: true, lastRun: a.lastRun }, Date.now());
      });
    } catch (err) {
      log(`[automation] could not read the schedule: ${err.message}`);
      return;
    }
    if (!due.length) return;

    automationTickBusy = true;
    try {
      for (const a of due) {
        // Re-checked per item, not just at the top: pausing partway through a
        // batch should stop the rest of it.
        if (!state.get().observing) break;
        const result = await runAutomation(a.id, 'scheduled');
        if (win && !win.isDestroyed()) {
          win.webContents.send('fren:automationRan', { name: a.name, status: result.status });
        }
      }
    } catch (err) {
      // An escaping error here would kill the interval and silently end all
      // future scheduled runs.
      log(`[automation] scheduled run failed: ${err.message}`);
    } finally {
      automationTickBusy = false;
    }
  }, 30 * 1000);
  if (automationTimer.unref) automationTimer.unref();

  // Read BEFORE the first beat overwrites it: this is how long fren was gone,
  // and it is the one thing the greeting is built from.
  // Read before the window exists: restoring afterwards would show fren at the
  // default size for a frame and then snap, which is exactly the kind of jump
  // that makes a persisted preference feel unreliable.
  orbScale = clampScale(memory.getSetting('orbScale'));
  if (orbScale !== 1) log(`[orb] restored at ${orbScale.toFixed(2)}x (${orbSize().width}px)`);

  // Apply the user's model/voice/hearing choices before anything can use them.
  // Empty fields mean "whatever the gateway was started with", so a fresh
  // install goes straight to the defaults with nothing configured.
  const applyProviderSettings = () => {
    const s = providerSettings.read(memory);
    gateway.setOverrides(s);
    whisper.setPreferences(s);
    return s;
  };
  applyProviderSettings();

  lastSeenAt = Number(memory.getSetting('lastSeenAt')) || null;
  const beat = () => { try { memory.setSetting('lastSeenAt', Date.now()); } catch { /* not worth failing over */ } };
  beat();
  heartbeat = setInterval(beat, 60 * 1000);
  if (heartbeat.unref) heartbeat.unref();

  createWindow();

  // fren wakes up when it launches. This is the owner's decision, and it can be
  // reversed — at setup, from the Memory pane, or by tapping the orb.
  //
  // It is a real trade, and worth naming: being lit means fren IS watching, so
  // capture begins before anyone has said anything this session. Two things
  // make it defensible rather than sly. The light is not decoration — the whole
  // state model computes it from `observing`, so an awake face is never on
  // while capture is off (see state.js: a lit orb that was not watching would
  // be the actually dishonest arrangement). And on the very first launch, the
  // first thing fren says is that its light is on, what that means, and how to
  // stop it.
  //
  // Anyone who prefers the old behaviour sets it once and it sticks.
  const firstLaunch = !memory.getSetting('profile');
  // Absent means never chosen: awake, including for people who completed setup
  // before this setting existed. See wake.js for why it is resolved there.
  if (wakeOnLaunchFrom(memory.getSetting('wakeOnLaunch'))) {
    log(firstLaunch ? '[setup] first launch — waking up to introduce myself' : '[state] awake on launch');
    startObserving();
  } else {
    log('[state] starting paused, as set');
  }

  state.subscribe((s) => {
    if (win && !win.isDestroyed()) win.webContents.send('fren:stateChanged', s);
  });

  const checkHealth = async () => {
    try {
      const health = await gateway.health();
      if (!state.get().gatewayOk) state.set({ gatewayOk: true });
      // Whether the screen-looking button can be offered at all depends on a
      // model that can actually see; DeepSeek's chat models cannot.
      const canSee = !!(health && health.vision);
      if (state.get().canSeeScreen !== canSee) state.set({ canSeeScreen: canSee });
    } catch {
      if (state.get().gatewayOk) state.set({ gatewayOk: false });
    }
  };
  checkHealth();
  setInterval(checkHealth, 30_000);

  ipcMain.handle('fren:getState', () => state.get());

  ipcMain.handle('fren:toggleObservation', () => {
    if (state.get().observing) stopObserving();
    else startObserving();
    return state.get();
  });

  // The orb lives at the window's bottom-right, so the window grows up and to
  // the left: the character stays exactly where the user parked it.
  ipcMain.handle('fren:setPanelOpen', (_e, open) => {
    const cur = win.getBounds();
    const size = open ? panelSize() : orbSize();
    const anchorRight = cur.x + cur.width;
    const anchorBottom = cur.y + cur.height;
    const { workArea } = screen.getDisplayMatching(cur);
    const x = Math.min(
      Math.max(anchorRight - size.width, workArea.x),
      workArea.x + workArea.width - size.width
    );
    const y = Math.min(
      Math.max(anchorBottom - size.height, workArea.y),
      workArea.y + workArea.height - size.height
    );
    win.setBounds({ x, y, ...size });
    state.set({ panelOpen: !!open });
  });

  ipcMain.handle('fren:dragStart', () => {
    const cursor = screen.getCursorScreenPoint();
    const b = win.getBounds();
    drag = { dx: cursor.x - b.x, dy: cursor.y - b.y, moved: false, timer: null };
    drag.timer = setInterval(() => {
      if (!drag || !win || win.isDestroyed()) return;
      const c = screen.getCursorScreenPoint();
      const x = c.x - drag.dx;
      const y = c.y - drag.dy;
      const cur = win.getBounds();
      if (Math.abs(x - cur.x) > 2 || Math.abs(y - cur.y) > 2) drag.moved = true;
      win.setPosition(x, y);
    }, 16);
  });

  ipcMain.handle('fren:dragEnd', () => {
    if (!drag) return { moved: false };
    clearInterval(drag.timer);
    const moved = drag.moved;
    drag = null;
    return { moved };
  });

  // Voice. Transcription runs locally: the audio is written to a temp file,
  // handed to whisper.cpp, and deleted. It never touches the network.
  ipcMain.handle('fren:voiceStatus', () => {
    const w = whisper.detect();
    return { stt: w.ready, reason: w.reason || null };
  });

  ipcMain.handle('fren:transcribe', async (_e, bytes) => {
    try {
      const text = await whisper.transcribe(Buffer.from(bytes));
      log(`[voice] transcribed ${bytes.byteLength} bytes -> ${text.length} chars`);
      return { text };
    } catch (err) {
      log(`[voice] transcription failed: ${err.message}`);
      return { error: err.message };
    }
  });

  ipcMain.handle('fren:speak', async (_e, text) => {
    try {
      const audio = await gateway.speak(String(text ?? '').slice(0, 2000));
      return { audio: audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength) };
    } catch (err) {
      log(`[voice] speech failed: ${err.message}`);
      return { error: err.message };
    }
  });

  /**
   * Keep what an answer taught, if it taught anything.
   *
   * Called after the user replies to a question fren asked. Most answers are
   * true for an hour and worth nothing next month; the model decides which is
   * which, and only the durable ones reach MEMORY.md. Failing here is silent
   * on purpose — this runs behind an ordinary reply, and nothing about it is
   * worth interrupting that reply for.
   *
   * The question comes from the caller rather than from a copy kept here. Main
   * knows a question was SENT; only the renderer knows it was actually asked,
   * since it drops one that would land mid-conversation. Keeping a second copy
   * here means the next thing the user says gets weighed as an answer to a
   * question they never heard.
   */
  ipcMain.handle('fren:learn', async (_e, asked, answer) => {
    const said = String(answer ?? '').trim().slice(0, 1000);
    const question = String(asked ?? '').trim().slice(0, 300);
    if (!said || !question) return { kept: false };
    try {
      const { worthKeeping, fact } = await gateway.learn({ question, answer: said });
      if (!worthKeeping || !fact) return { kept: false };
      const kept = soul.rememberFact(app.getPath('userData'), fact);
      // PRIVACY: that something was learned, never what.
      if (kept) log('[curiosity] kept one thing from that answer');
      return { kept };
    } catch (err) {
      log(`[curiosity] could not weigh that answer: ${err.message}`);
      return { kept: false };
    }
  });

  // What the user told fren about themselves during first-run setup. Stored
  // locally in the same SQLite file as everything else; it is sent to the model
  // as chat context and nowhere else.
  /**
   * Hello, once per arrival.
   *
   * The greeting is the most repeated thing fren will ever say, so the question
   * that matters is not how to write one but when to stay quiet. Restarting the
   * app four times in ten minutes — which is most of a working day if you are
   * building it — must not produce four hellos, both because it would be
   * maddening and because each one is a paid speech call.
   *
   * So: greet on an ARRIVAL, not on a launch. A relaunch inside the quiet
   * window is the same visit continuing.
   */
  const GREET_AFTER_MS = 30 * 60 * 1000;   // a gap shorter than this is not an arrival
  const RECENT_GREETINGS = 'recentGreetings';

  ipcMain.handle('fren:greeting', async () => {
    // The introduction IS the greeting on a first launch, and it is a better
    // one. Without this the call is still paid for and then thrown away,
    // because the renderer drops a hello that lands during setup.
    if (!memory.getSetting('profile')) return { text: null, why: 'first launch' };
    const gap = lastSeenAt ? Date.now() - lastSeenAt : null;
    if (gap !== null && gap < GREET_AFTER_MS) return { text: null, why: 'just restarted' };

    let recent = [];
    try { recent = JSON.parse(memory.getSetting(RECENT_GREETINGS) || '[]'); } catch { recent = []; }

    // Only what was written down before fren closed. Nothing here is live.
    let lastActivity = '';
    try {
      // Newest N, then re-sorted ascending — so limit 1 is the latest row.
      const [latest] = memory.getRecentMemories({ sinceMs: Date.now() - 7 * 24 * 3600 * 1000, limit: 1 });
      if (latest) lastActivity = latest.activity || '';
    } catch { /* nothing observed yet */ }

    let facts = '';
    try {
      const mem = soul.readAll(app.getPath('userData')).files.find((f) => f.name === 'MEMORY.md');
      facts = (mem ? mem.text : '').split('## Days')[0].split('\n')
        .filter((l) => l.startsWith('- ')).slice(-6).join('\n');
    } catch { /* no facts yet */ }

    try {
      const { text } = await gateway.greet({
        profile: memory.getSetting('profile'),
        lastSeenMs: lastSeenAt,
        lastActivity,
        facts,
        avoid: recent,
      });
      if (!text) return { text: null, why: 'nothing came back' };
      try {
        memory.setSetting(RECENT_GREETINGS, JSON.stringify([...recent, text].slice(-4)));
      } catch { /* the greeting still stands */ }
      // PRIVACY: that fren said hello, never what it said — the text is built
      // from window titles.
      log('[greeting] said hello');
      return { text };
    } catch (err) {
      // No hello is a fine outcome. A late or failed one must never hold up the
      // app or surface an error at the very first moment of a session.
      log(`[greeting] skipped: ${err.message}`);
      return { text: null, why: 'gateway unavailable' };
    }
  });

  /**
   * Whether fren is awake when it launches.
   *
   * Stored apart from the profile because it is not a fact about the user, it
   * is a standing instruction about capture — the kind of thing that should be
   * one obvious value someone can find, flip, and trust.
   */
  /**
   * Scroll on the orb to make fren bigger or smaller.
   *
   * The renderer owns the gesture and the animation; this owns the window,
   * because the canvas cannot draw outside its own bounds — the window has to
   * grow first or a growing orb is simply clipped.
   *
   * Anchored bottom-right, like every other resize here, so fren grows up and
   * to the left and stays exactly where it was parked instead of drifting
   * across the screen as it changes size.
   */
  ipcMain.handle('fren:setOrbScale', (_e, next) => {
    const before = orbScale;
    orbScale = clampScale(next);
    const cur = win.getBounds();
    const size = state.get().panelOpen ? panelSize() : orbSize();
    const anchorRight = cur.x + cur.width;
    const anchorBottom = cur.y + cur.height;
    const { workArea } = screen.getDisplayMatching(cur);
    win.setBounds({
      x: Math.min(Math.max(anchorRight - size.width, workArea.x),
                  workArea.x + workArea.width - size.width),
      y: Math.min(Math.max(anchorBottom - size.height, workArea.y),
                  workArea.y + workArea.height - size.height),
      ...size,
    });
    // Written every time rather than on a debounce: this is one small integer,
    // and the alternative is losing the size to a crash or a force-quit right
    // after someone has just set it.
    if (orbScale !== before) {
      try { memory.setSetting('orbScale', orbScale); } catch { /* size still applied */ }
      log(`[orb] resized to ${orbScale.toFixed(2)}x (${size.width}px)`);
    }
    return { scale: orbScale, min: SCALE_MIN, max: SCALE_MAX };
  });

  ipcMain.handle('fren:getOrbScale', () => ({ scale: orbScale, min: SCALE_MIN, max: SCALE_MAX }));

  /**
   * The model, the voice and the ear.
   *
   * Returns what is chosen alongside what is actually in effect, because "empty
   * means default" is only useful if you can see what the default IS. The
   * defaults come from the gateway's own /health, which is the only thing that
   * knows — the desktop deliberately holds no provider configuration.
   */
  ipcMain.handle('fren:getProviders', async () => {
    let live = null;
    try { live = await gateway.health(); } catch { /* gateway down; show chosen only */ }
    return {
      chosen: providerSettings.read(memory),
      // PRIVACY: names and ids only. There is no key anywhere in this payload,
      // and there is no code path that could put one here — this process
      // deleted them from its own environment at startup.
      inEffect: live ? {
        provider: live.provider, model: live.model, voice: live.voice,
        voiceId: live.voiceId, voiceModel: live.voiceModel,
      } : null,
      whisper: whisper.detect(),
    };
  });

  ipcMain.handle('fren:setProviders', (_e, patch) => {
    const saved = providerSettings.write(memory, patch);
    gateway.setOverrides(saved);
    whisper.setPreferences(saved);
    // PRIVACY: which fields changed, never their values.
    log(`[settings] providers updated (${Object.keys(patch || {}).join(', ') || 'nothing'})`);
    // Echo what was actually kept, so a rejected value shows as rejected.
    return saved;
  });

  /**
   * What colour fren is.
   *
   * Stored as a plain integer and broadcast, because the setting is changed in
   * the DASHBOARD window while the orb lives in the PANEL window. Without the
   * broadcast the choice would only take effect at the next launch, which for
   * a colour — the one setting whose whole point is that you can see it — would
   * feel broken rather than deferred.
   *
   * The renderer clamps too (palette.js), but the value is clamped here as
   * well: this is what gets written to disk and read at boot, and a hand-edited
   * database should not be able to produce an orb that cannot be told from a
   * sleeping one.
   */
  ipcMain.handle('fren:getOrbColour', () => {
    const stored = Number(memory.getSetting('orbColour'));
    const colour = Number.isFinite(stored) && stored > 0 ? stored : null;  // null == default
    if (colour) log(`[orb] wearing #${colour.toString(16).padStart(6, '0')}`);
    return colour;
  });

  ipcMain.handle('fren:setOrbColour', (_e, hex) => {
    const n = Number(hex);
    const value = Number.isFinite(n) && n >= 0 && n <= 0xffffff ? Math.round(n) : null;
    if (value === null) return { colour: null };
    memory.setSetting('orbColour', value);
    if (win && !win.isDestroyed()) win.webContents.send('fren:orbColour', value);
    log(`[orb] colour set to #${value.toString(16).padStart(6, '0')}`);
    return { colour: value };
  });

  ipcMain.handle('fren:getWakeOnLaunch', () => wakeOnLaunchFrom(memory.getSetting('wakeOnLaunch')));
  ipcMain.handle('fren:setWakeOnLaunch', (_e, on) => {
    memory.setSetting('wakeOnLaunch', !!on);
    log(`[state] launches ${on ? 'awake' : 'paused'} from now on`);
    return { wakeOnLaunch: !!on };
  });

  ipcMain.handle('fren:getProfile', () => memory.getSetting('profile'));

  /**
   * The one switch that decides whether fren may interrupt you.
   *
   * Set from the setup interview, and changeable afterwards from the Memory
   * pane — because an answer given once to a question you barely remember is
   * not consent you can withdraw, and this is the setting people will want to
   * withdraw. Merged rather than replaced, so flipping it cannot lose the rest
   * of the profile.
   */
  ipcMain.handle('fren:setVolunteer', (_e, on) => {
    const current = memory.getSetting('profile');
    if (!current || typeof current !== 'object') return { volunteer: false };
    const next = { ...current, volunteer: !!on };
    memory.setSetting('profile', next);
    log(`[setup] interruptions ${next.volunteer ? 'allowed' : 'turned off'}`);
    return { volunteer: next.volunteer };
  });
  ipcMain.handle('fren:setProfile', (_e, profile) => {
    const clean = profile && typeof profile === 'object' ? profile : null;
    memory.setSetting('profile', clean);
    // The interview also becomes fren's character, as Markdown the user can
    // read and edit. Skipping writes nothing: there is no character to define.
    if (clean && clean.name && !clean.skipped) {
      try {
        const p = soul.writeSoul(app.getPath('userData'), clean);
        log(`[setup] wrote ${path.basename(p.soul)} and ${path.basename(p.user)}`);
      } catch (err) {
        log(`[setup] could not write the soul files: ${err.message}`);
      }
    }
    log(`[setup] profile saved (${clean ? Object.keys(clean).join(', ') : 'cleared'})`);
    return memory.getSetting('profile');
  });

  // Spoken answers arrive as sentences. Pull the actual value out, and fall
  // back to the raw text if anything goes wrong.
  ipcMain.handle('fren:extractSetup', async (_e, payload) => {
    const answer = String((payload && payload.answer) || '').slice(0, 800);
    if (!answer.trim()) return { value: '' };
    try {
      const out = await gateway.extract({
        field: String((payload && payload.field) || ''),
        question: String((payload && payload.question) || '').slice(0, 400),
        answer,
        asked: (payload && payload.asked) || {},
      });
      return { ...out, value: out.value || (out.kind === 'question' ? '' : answer) };
    } catch (err) {
      log(`[setup] extraction failed, keeping the raw answer: ${err.message}`);
      return { value: answer };
    }
  });

  // What fren holds about you, as the actual files. Nothing is summarised or
  // paraphrased on the way out: the point is to show the bytes.
  ipcMain.handle('fren:readSoul', () => soul.readAll(app.getPath('userData')));
  ipcMain.handle('fren:readLog', (_e, name) => soul.readLog(app.getPath('userData'), name));
  // And a way out to the folder itself, so the files can be edited in a real
  // editor rather than only read here.
  ipcMain.handle('fren:openDataFolder', async () => {
    const err = await shell.openPath(app.getPath('userData'));
    return { ok: !err, error: err || null };
  });

  /**
   * Look at the screen, once, because the user pressed the button.
   *
   * There is no standing permission here on purpose. Every capture is a
   * separate deliberate act, the image is held in memory for the length of one
   * request, and it is never written to disk — which keeps the promise that
   * OBSERVED screenshots never leave the machine intact and separate.
   *
   * It also refuses while paused. Looking at the screen with the light off
   * would be exactly the thing the light exists to rule out.
   */
  ipcMain.handle('fren:lookAtScreen', async (_e, text) => {
    if (!state.get().observing) {
      return { error: "I'm paused — my light is off, so I'm not looking at anything." };
    }
    const question = String(text ?? '').trim().slice(0, 800) || 'What am I looking at?';
    state.beginWork();
    try {
      const shot = await screenCapture.captureOnce();
      if (shot.error) return { error: shot.error };
      const character = soul.readContext(app.getPath('userData'));
      const { reply } = await gateway.vision({
        question,
        image: shot.image,
        mediaType: shot.mediaType,
        soul: character.soul,
        userDoc: character.user,
      });
      // PRIVACY: never log the question, the reply, or anything about the image.
      log('[screen] looked once, on request');
      return { reply };
    } catch (err) {
      log(`[screen] look failed: ${err.message}`);
      return { error: err.message };
    } finally {
      state.endWork();
    }
  });

  // Speaking with the panel shut only works if anything comes out of the
  // speakers. Unknown counts as audible: opening a panel nobody needed is a
  // smaller sin than opening one over someone's work every time fren talks.
  ipcMain.handle('fren:audioSilenced', () => audioOutput.isSilenced());

  // What fren has noticed, newest first, for the Patterns view.
  ipcMain.handle('fren:getSuggestions', () => {
    try { return memory.getSuggestions().slice().reverse(); } catch { return []; }
  });

  /**
   * Draft an automation for something fren noticed.
   *
   * The draft is stored and shown. It is never run — fren proposes, the person
   * decides, and there is deliberately no code path here that executes what
   * comes back.
   */
  ipcMain.handle('fren:automate', async (_e, id) => {
    const all = memory.getSuggestions();
    const s = all.find((x) => x.id === Number(id));
    if (!s) return { error: 'that suggestion is gone' };
    if (s.draft) return { draft: s.draft };          // drafted once is enough
    state.beginWork();
    try {
      const memories = memory.getRecentMemories({ sinceMs: Date.now() - 24 * 60 * 60 * 1000 });
      const draft = await gateway.automate({
        pattern: s.pattern,
        message: s.message,
        memories,
        platform: process.platform === 'win32' ? 'Windows'
          : process.platform === 'linux' ? 'Linux' : 'macOS',
      });
      memory.setSuggestionDraft(s.id, draft);
      log(`[automate] drafted for suggestion ${s.id} (feasible=${draft.feasible})`);
      return { draft };
    } catch (err) {
      log(`[automate] failed: ${err.message}`);
      return { error: err.message };
    } finally {
      state.endWork();
    }
  });

  ipcMain.handle('fren:dismissSuggestion', (_e, id) => {
    memory.setSuggestionStatus(Number(id), 'dismissed');
    return true;
  });

  /**
   * The dashboard: a normal, resizable window for reading back days and
   * patterns properly.
   *
   * Separate from the companion panel on purpose. The panel is glanceable and
   * lives beside the orb; this is something you open occasionally and browse.
   * Trying to fold a sidebar and a day timeline into 384px would have made both
   * worse.
   */
  ipcMain.handle('fren:openDashboard', () => {
    if (dash && !dash.isDestroyed()) { dash.show(); dash.focus(); return true; }
    dash = new BrowserWindow({
      width: 1040,
      height: 720,
      minWidth: 720,
      minHeight: 520,
      title: 'fren',
      backgroundColor: '#F2EDE4',
      titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    dash.loadURL(`${SCHEME}://app/dashboard.html`);

    /**
     * Closing the dashboard asks whether that means closing fren.
     *
     * The orb has no title bar, no close button and no menu — so once the
     * chat's × stops quitting, this window is the only place the question can
     * be asked. Getting it wrong in the quiet direction leaves fren running
     * with no window to reach it by; getting it wrong in the loud direction
     * kills the app when someone tidied a window away.
     *
     * `quitting` guards the re-entry: app.quit() closes this window too, which
     * would fire this handler again and ask a second time.
     */
    dash.on('close', (e) => {
      if (quitting) return;
      e.preventDefault();
      const response = dialog.showMessageBoxSync(dash, {
        type: 'question',
        buttons: ['Close this window', 'Quit fren', 'Cancel'],
        defaultId: 0,
        cancelId: 2,
        message: 'Close the dashboard, or quit fren?',
        detail: 'fren keeps running in the corner of your screen unless you quit it. ' +
                'Quitting stops it watching and closes everything.',
      });
      if (response === 2) return;                 // cancel: leave it open
      if (response === 1) { quitting = true; app.quit(); return; }
      dash.destroy();                             // just this window
    });

    dash.on('closed', () => { dash = null; });
    return true;
  });

  ipcMain.handle('fren:days', () => {
    try { return memory.getActiveDays(60); } catch { return []; }
  });

  /** One day, as the dashboard needs it: what was done, and any stills of it. */
  ipcMain.handle('fren:day', (_e, day) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day || ''))) return { memories: [], shots: [] };
    const [y, m, d] = String(day).split('-').map(Number);
    const from = new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
    const to = new Date(y, m - 1, d + 1, 0, 0, 0, 0).getTime();
    try {
      const memories = memory.getMemoriesBetween({ fromMs: from, toMs: to });
      // Screenshots are already on disk and have never been transmitted.
      // Showing them in a local window changes nothing about that; it only
      // lets the person see what was stored about them.
      const shots = memory.getScreenshotsBetween({ fromMs: from, toMs: to, limit: 60 })
        .map((s) => ({ ...s, url: `${SCHEME}://shot/${encodeURIComponent(s.screenshotPath)}` }));
      return { memories, shots };
    } catch {
      return { memories: [], shots: [] };
    }
  });

  // ---- routines ----------------------------------------------------------
  ipcMain.handle('fren:routines', () => {
    try {
      return memory.getRoutines().map((r) => ({ ...r, nextRun: nextRunAt(r) }));
    } catch { return []; }
  });

  /** Is this a routine request? If so, create it and say what was created. */
  ipcMain.handle('fren:maybeRoutine', async (_e, text) => {
    const said = String(text ?? '').trim().slice(0, 600);
    if (!said) return { isRoutine: false };
    try {
      const parsed = await gateway.routine({ text: said });
      if (!parsed.isRoutine || !parsed.prompt) return { isRoutine: false };
      const id = memory.addRoutine({
        name: parsed.name || 'routine',
        prompt: parsed.prompt,
        hour: parsed.hour,
        minute: parsed.minute,
        days: parsed.days,
      });
      const created = memory.getRoutines().find((r) => r.id === id);
      log(`[routines] created "${created.name}" for ${created.hour}:${String(created.minute).padStart(2, '0')}`);
      return { isRoutine: true, routine: { ...created, nextRun: nextRunAt(created) } };
    } catch (err) {
      log(`[routines] could not parse a routine: ${err.message}`);
      return { isRoutine: false };
    }
  });

  ipcMain.handle('fren:setRoutineEnabled', (_e, id, enabled) => {
    memory.setRoutineEnabled(Number(id), !!enabled);
    return true;
  });

  ipcMain.handle('fren:deleteRoutine', (_e, id) => {
    memory.deleteRoutine(Number(id));
    return true;
  });

  // ---- automations: running what fren drafted ----------------------------
  //
  // Every path to execution goes through runAutomation, and it re-checks the
  // approval hash against the CURRENT script text every single time. Approval
  // is not a flag that gets set once; it is a claim about a specific script,
  // and it is verified at the moment of running rather than trusted from
  // whenever it was granted.
  // Automations currently executing, so one cannot be started twice over.
  const running = new Set();

  async function runAutomation(id, trigger) {
    const a = memory.getAutomations().find((x) => x.id === Number(id));
    if (!a) return { error: 'that automation is gone' };

    const hash = executor.hashScript(a.script);
    if (!a.approvedHash || a.approvedHash !== hash) {
      const out = a.approvedHash
        ? 'the script changed since you approved it, so the approval no longer applies'
        : 'this has not been approved yet';
      memory.recordRun({ automationId: a.id, trigger, status: 'blocked', output: out });
      return { status: 'blocked', output: out };
    }
    if (trigger === 'scheduled' && !a.verified) {
      const out = 'not run by hand yet — a schedule only starts after one successful manual run';
      memory.recordRun({ automationId: a.id, trigger, status: 'blocked', output: out });
      return { status: 'blocked', output: out };
    }
    // The pause check belongs HERE, not only in the scheduling loop, so every
    // path to execution carries it. A loop that has already dispatched its work
    // would otherwise keep running scripts after the light went out.
    if (trigger === 'scheduled' && !state.get().observing) {
      return { status: 'blocked', output: 'fren was paused before this could run' };
    }
    // One at a time. Without this a script that outlives the 30s tick is
    // started again by the next tick, and a single approval for a single 09:00
    // slot executes two or three overlapping copies.
    if (running.has(a.id)) {
      return { status: 'blocked', output: 'this automation is already running' };
    }
    running.add(a.id);

    // Claim the slot BEFORE the work, so a long or crashing run cannot be
    // re-fired every thirty seconds for the rest of its grace window. The real
    // outcome overwrites this a moment later.
    memory.recordRun({ automationId: a.id, trigger, status: 'started', output: null });

    let result;
    try {
      result = await executor.run({ script: a.script, language: a.language });
    } finally {
      running.delete(a.id);
    }
    memory.recordRun({ automationId: a.id, trigger, status: result.status, output: result.output });
    // A successful MANUAL run is what earns the right to be scheduled.
    if (result.status === 'ok' && trigger === 'manual') memory.markAutomationVerified(a.id);
    // PRIVACY: name and status only. Output can contain anything the script saw.
    log(`[automation] "${a.name}" ${trigger} -> ${result.status}`);
    return result;
  }

  ipcMain.handle('fren:automations', () => {
    try {
      return memory.getAutomations().map((a) => ({
        ...a,
        currentHash: executor.hashScript(a.script),
        scan: executor.scan(a.script),
        nextRun: a.schedule && a.schedule.enabled
          ? nextRunAt({ ...a.schedule, enabled: true })
          : null,
        runs: memory.getRuns(a.id, 8),
      }));
    } catch { return []; }
  });

  /** Keep a drafted script as an automation, so it can be reviewed. */
  ipcMain.handle('fren:keepAutomation', (_e, suggestionId) => {
    const s = memory.getSuggestions().find((x) => x.id === Number(suggestionId));
    if (!s || !s.draft || !s.draft.script) return { error: 'no script to keep' };
    const id = memory.addAutomation({
      suggestionId: s.id,
      name: s.pattern || 'automation',
      language: s.draft.language,
      script: s.draft.script,
    });
    return { id };
  });

  ipcMain.handle('fren:approveAutomation', (_e, id, hash) => {
    const a = memory.getAutomations().find((x) => x.id === Number(id));
    if (!a) return { error: 'that automation is gone' };
    // The hash must be the one the reviewer was looking at. If the script has
    // changed since it was rendered, the approval is for a different thing.
    const current = executor.hashScript(a.script);
    if (String(hash) !== current) return { error: 'the script changed while you were reading it' };
    memory.approveAutomation(a.id, current);
    log(`[automation] "${a.name}" approved`);
    return { ok: true };
  });

  ipcMain.handle('fren:revokeAutomation', (_e, id) => {
    memory.revokeAutomation(Number(id));
    log('[automation] approval revoked');
    return true;
  });

  ipcMain.handle('fren:runAutomation', (_e, id) => runAutomation(id, 'manual'));

  ipcMain.handle('fren:scheduleAutomation', (_e, id, schedule) => {
    const a = memory.getAutomations().find((x) => x.id === Number(id));
    if (!a) return { error: 'that automation is gone' };
    if (schedule.enabled && !a.verified) {
      return { error: 'run it by hand successfully first — a schedule starts from something known to work' };
    }
    memory.setAutomationSchedule(a.id, schedule);
    return { ok: true };
  });

  ipcMain.handle('fren:deleteAutomation', (_e, id) => {
    memory.deleteAutomation(Number(id));
    return true;
  });

  ipcMain.handle('fren:quit', () => { quitting = true; app.quit(); });

  /**
   * Answer a question from fren's own memory.
   *
   * Shared by the chat handler and by routines, so a routine can never do
   * anything you could not have asked for yourself — it is the same call, at a
   * time you chose.
   */
  async function answer(question) {
    const eightHoursAgo = Date.now() - 8 * 60 * 60 * 1000;
    const memories = memory.getRecentMemories({ sinceMs: eightHoursAgo });
    const observations = memory
      .getRecentObservations({ limit: 50 })
      .map(({ ts, activeApp, windowTitle }) => ({ ts, activeApp, windowTitle }));
    const profile = memory.getSetting('profile');
    const character = soul.readContext(app.getPath('userData'));
    const { reply } = await gateway.chat({
      question, memories, observations, profile,
      soul: character.soul, userDoc: character.user,
    });
    return reply;
  }

  ipcMain.handle('fren:chat', async (_e, text) => {
    const question = String(text ?? '').trim().slice(0, 2000);
    if (!question) return { reply: '…' };
    lastChatAt = Date.now();
    state.beginWork();
    try {
      const eightHoursAgo = Date.now() - 8 * 60 * 60 * 1000;
      const memories = memory.getRecentMemories({ sinceMs: eightHoursAgo });
      const observations = memory
        .getRecentObservations({ limit: 50 })
        .map(({ ts, activeApp, windowTitle }) => ({ ts, activeApp, windowTitle }));
      const profile = memory.getSetting('profile');
      // Read from disk every time, so editing SOUL.md takes effect on the next
      // message rather than the next launch.
      const character = soul.readContext(app.getPath('userData'));
      const { reply } = await gateway.chat({
        question, memories, observations, profile,
        soul: character.soul, userDoc: character.user,
      });
      return { reply };
    } catch (err) {
      log(`[chat] failed: ${err.message}`);
      return {
        reply:
          "I can't reach my thinking half (the local gateway). Is it running? Try: npm run gateway",
      };
    } finally {
      state.endWork();
    }
  });
});

// NOT app.quit(). The orb window is the app: it is frameless with no close
// button, so "all windows closed" can only mean the dashboard was closed and
// the orb is being rebuilt — quitting there would take fren down with it.
// Quitting is a decision made in one place, the dashboard's close dialog.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') return;      // and even then, stay up
});

app.on('before-quit', () => {
  if (gazeTimer) clearInterval(gazeTimer);
  if (drag) clearInterval(drag.timer);
  if (observer) observer.stop();
  if (summarizer) summarizer.stop();
  if (heartbeat) clearInterval(heartbeat);
  if (patterns) patterns.stop();
  if (curiosity) curiosity.stop();
  if (routines) routines.stop();
  if (automationTimer) clearInterval(automationTimer);
  if (memory) memory.close();
});
