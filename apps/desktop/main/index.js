// Electron main process: creates the mascot window and wires the loop
// observe -> remember -> summarize -> chat. Owns the observation on/off state.
const path = require('path');
const { app, BrowserWindow, ipcMain, screen, protocol, net, shell } = require('electron');
const { pathToFileURL } = require('node:url');
const { config, loadEnv } = require('../../../packages/shared');
const { openMemory } = require('../../../packages/memory');
const state = require('./state');
const gateway = require('./gatewayClient');
const { createObserver } = require('./observer');
const { createSummarizer } = require('./summarizer');
const { createPatternWatcher } = require('./patterns');
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

const ORB_SIZE = { width: 150, height: 150 };
// Wider than it was: the old 344 left the conversation cramped against both
// edges, and the design this is built to wants room to breathe.
const PANEL_SIZE = { width: 384, height: 604 };
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
let automationTimer = null;

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
    ...ORB_SIZE,
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
  positionWindow(ORB_SIZE);
}

function orbCenter() {
  const b = win.getBounds();
  return { x: b.x + b.width - ORB_SIZE.width / 2, y: b.y + b.height - ORB_SIZE.height / 2 };
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
    if (!state.get().observing) return;
    let due = [];
    try {
      due = memory.getAutomations().filter((a) => {
        if (!a.schedule || !a.schedule.enabled || !a.verified) return false;
        return isDue({ ...a.schedule, enabled: true, lastRun: a.lastRun }, Date.now());
      });
    } catch { return; }
    for (const a of due) {
      const result = await runAutomation(a.id, 'scheduled');
      if (win && !win.isDestroyed()) {
        win.webContents.send('fren:automationRan', { name: a.name, status: result.status });
      }
    }
  }, 30 * 1000);
  if (automationTimer.unref) automationTimer.unref();

  createWindow();

  // On a first launch fren wakes up by itself and introduces itself. Every
  // later launch starts paused, as before.
  //
  // This is a real trade: being lit means fren IS watching, so capture starts
  // before anyone has agreed to it. It is defensible only because the very
  // first thing fren says is that its light is on, what that means, and how to
  // turn it off — and because the alternative, a dark ball that has to be
  // discovered, is how the last few sessions ended with the interview ignored.
  // If it were lit WITHOUT observing, the light would be a lie, which is worse.
  const firstLaunch = !memory.getSetting('profile');
  if (firstLaunch) {
    log('[setup] first launch — waking up to introduce myself');
    startObserving();
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
    const size = open ? PANEL_SIZE : ORB_SIZE;
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

  // What the user told fren about themselves during first-run setup. Stored
  // locally in the same SQLite file as everything else; it is sent to the model
  // as chat context and nowhere else.
  ipcMain.handle('fren:getProfile', () => memory.getSetting('profile'));
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

    const result = await executor.run({ script: a.script, language: a.language });
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

  ipcMain.handle('fren:quit', () => app.quit());

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

app.on('window-all-closed', () => app.quit());

app.on('before-quit', () => {
  if (gazeTimer) clearInterval(gazeTimer);
  if (drag) clearInterval(drag.timer);
  if (observer) observer.stop();
  if (summarizer) summarizer.stop();
  if (patterns) patterns.stop();
  if (routines) routines.stop();
  if (automationTimer) clearInterval(automationTimer);
  if (memory) memory.close();
});
