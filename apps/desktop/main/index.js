// Electron main process: creates the mascot window and wires the loop
// observe -> remember -> summarize -> chat. Owns the observation on/off state.
const path = require('path');
const { app, BrowserWindow, ipcMain, screen, protocol, net, shell, dialog, Menu, Notification } = require('electron');
const arrival = require('./arrival');
const { pathToFileURL } = require('node:url');
const { config, loadEnv } = require('../../../packages/shared');
const { openMemory } = require('../../../packages/memory');
const intelligence = require('../../../packages/intelligence');   // the voice digest
const state = require('./state');
const gateway = require('./gatewayClient');
const { reviveGateway, stopGateway } = require('./gateway-process');
const { createObserver } = require('./observer');
const { createBrowserSensor, EVENTS: BROWSER_EVENTS } = require('./browser-sensor');
const { createBrowserTransport } = require('./browser-transport');
const { createSummarizer } = require('./summarizer');
const { createPatternWatcher } = require('./patterns');
const { createCuriosityWatcher } = require('./curiosity');
const { createProactiveWatcher } = require('./proactive');
const { createNarrator } = require('./narrator');
const { createWakeListener } = require('./wake-word');
const wakeTruth = require('./wake-info');
const { wakeOnLaunchFrom } = require('./wake');
const {
  clampInto, offsetInWindow, windowFor, chooseSide,
  CHARACTER_BASE, STAGE_PAD, SHADOW_ROOM,
} = require('./place');
// The palette is a UMD module shared with both renderers; main uses it to
// sanitize the orb-look setting at its single point of entry.
const palette = require('../renderer/face/palette.js');
const providerSettings = require('./settings');
const { createRoutineRunner, nextRunAt } = require('./routines');
const whisper = require('./whisper');
const soul = require('./soul');
const { createOwnBusiness } = require('./own-business');
const screenCapture = require('./screen');
const audioOutput = require('./audio-output');

loadEnv();
// The desktop process must never hold provider credentials — only the gateway
// talks to the LLM provider. .env is shared with the gateway, so scrub here.
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_AUTH_TOKEN;
delete process.env.DEEPSEEK_API_KEY;
delete process.env.ELEVENLABS_API_KEY;
delete process.env.FREN_VISION_API_KEY;

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
/*
 * CHARACTER_BASE, STAGE_PAD and SHADOW_ROOM come from place.js, which is where
 * the arithmetic that uses them lives. They are the stylesheet's numbers, and
 * place.test.js reads styles.css to check they still are.
 */
// Which corner of the orb the panel grows from, and how big it is allowed to be
// there. Whichever corner it is, the ORB does not move — that is the whole
// point of tracking this rather than just clamping the window afterwards.
let panelHow = { side: 'left', drop: false };
/**
 * Where the character's centre WANTS to be, in screen coordinates.
 *
 * Not where it is. Parked in a corner and grown, the orb runs into the edge of
 * the screen and gets clamped inward — and if the next resize then measures
 * where it actually ended up, the clamped position becomes the new truth and
 * shrinking it again leaves it stranded in the middle. Zooming in and back out
 * walked the orb diagonally off its corner, a bit further every time.
 *
 * So this is written only by the things that genuinely move fren — a drag, the
 * first placement, being rescued back onto the screen — and resizing only ever
 * reads it. Growing against an edge is then exactly undone by shrinking again.
 */
let orbAnchor = null;

/** The character's centre right now, wherever it has ended up. */
function characterCentre() {
  const r = characterRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

/** fren has been moved on purpose: this is where it wants to be from now on. */
function anchorHere() {
  orbAnchor = characterCentre();
}
const SCALE_MIN = 0.65;
const SCALE_MAX = 2.0;
let orbScale = 1;

const clampScale = (s) => Math.min(SCALE_MAX, Math.max(SCALE_MIN, Number(s) || 1));
// The window is taller than the character by SHADOW_ROOM, which is empty
// transparent space beneath it for the shadow to fade out in.
const shadowRoom = () => Math.round(SHADOW_ROOM * orbScale);
/**
 * The window with nothing in it but the character.
 *
 * Exactly the stage's padding around the character's box, which makes
 * offsetInWindow come out at STAGE_PAD in EVERY corner: a closed orb sits in
 * the same place whichever way the panel was going to open. That is worth the
 * two pixels it costs, because it means closing the panel cannot move the orb
 * however the corner happens to be bookkept.
 *
 * It used to be the character plus the shadow's room and nothing else, which
 * was 2px short of what the stage needs — so the halo overflowed the window on
 * every closed frame, and the two corners disagreed by 2 * STAGE_PAD.
 */
const orbSize = () => {
  const n = Math.round(CHARACTER_BASE * orbScale) + 2 * STAGE_PAD + shadowRoom();
  return { width: n, height: n };
};
/** The character's own box, without the shadow's room. What must stay visible. */
const characterSize = () => {
  const n = Math.round(CHARACTER_BASE * orbScale);
  return { width: n, height: n };
};
// The orb sits under the panel in the same window, so a bigger orb needs a
// taller window — otherwise growing it would push the conversation off the top.
const panelSize = () => ({
  // The same transparent strip on the right, so the orb keeps its shadow room
  // with the panel open. The stage pads it back out, so the panel's own visible
  // width is unchanged.
  width: PANEL_BASE.width + shadowRoom(),
  height: PANEL_BASE.height + Math.round(CHARACTER_BASE * orbScale) + shadowRoom(),
  // The panel keeps its own width; only the orb's strip needs the extra.
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
let observer = null;
let browserSensor = null;
let browserTransport = null;
let browserStaleTimer = null;
let summarizer = null;
let patterns = null;
let routines = null;
let curiosity = null;
let proactive = null;
let narrator = null;
let heartbeat = null;
// When fren was last alive. Written on a heartbeat rather than on quit, because
// a crash, a force-quit or a logout all skip the tidy exit — and the greeting
// would then claim a gap of days that was really a gap of minutes.
let lastSeenAt = null;
// When the user last said something. Curiosity checks this so a question never
// lands in the middle of a conversation that is already going.
let lastChatAt = 0;
let coreEvents = null;      // the push channel from Core, closed on quit

const log = (...args) => console.log(...args);

/**
 * Keep the character on a screen.
 *
 * The window is mostly empty space — the orb sits in its bottom-right corner
 * and the panel grows up and to the left — so clamping the WINDOW into the
 * work area would stop you parking fren against an edge, which is exactly where
 * people put it. What has to stay visible is the character itself.
 *
 * Without this, dragging fren past the edge of the display left it there for
 * good: nothing ever brought it back, nothing persisted a position to correct,
 * and on a window with no title bar there is nothing to grab. Which is how it
 * got lost.
 */
function clampToScreen(bounds) {
  // The CHARACTER, not the window. The window carries a transparent strip for
  // the shadow, and may carry the panel above OR below — insisting all of that
  // stays on screen would stop fren being parked against an edge at all.
  const orb = characterSize();
  const off = characterOffset(bounds, panelHow);
  // Nearest to the ORB, not to the window: with the panel open the window's own
  // centre can be on a different display from the character.
  const { workArea } = screen.getDisplayNearestPoint({
    x: Math.round(bounds.x + off.x + orb.width / 2),
    y: Math.round(bounds.y + off.y + orb.height / 2),
  });
  // clampInto keeps the orb at the bottom-right of what it is given, so it is
  // given a box that ENDS at the character: same top-left as the real window,
  // sized so its bottom-right corner is the character's. The origin it returns
  // is the origin the real window wants, whichever side the panel is on.
  return clampInto(
    { x: bounds.x, y: bounds.y, width: off.x + orb.width, height: off.y + orb.height },
    orb, workArea
  );
}

/** Put fren somewhere it can be seen, wherever it has got to. */
function recenter() {
  if (!win || win.isDestroyed()) return;
  const b = win.getBounds();
  const at = clampToScreen(b);
  if (at.x !== b.x || at.y !== b.y) {
    win.setPosition(at.x, at.y);
    anchorHere();
    log(`[window] brought fren back on screen from ${b.x},${b.y}`);
  }
  win.showInactive();
}

function positionWindow(size) {
  // Anchor to the bottom-right corner of the primary display's work area.
  const { workArea } = screen.getPrimaryDisplay();
  // MARGIN is the gap from the CHARACTER to the screen edge, not from the
  // window — the window hangs past the orb by the shadow's room AND the stage's
  // padding, and measuring from its edge pushes fren up and left of where the
  // margin says. Said once, in windowFor, rather than derived again here: the
  // hand-written version forgot the padding and was 4px out in both axes.
  const ch = characterSize();
  const rect = {
    ...ch,
    x: workArea.x + workArea.width - MARGIN - ch.width,
    y: workArea.y + workArea.height - MARGIN - ch.height,
  };
  win.setBounds({
    ...windowFor(rect, size, ch, STAGE_PAD, shadowRoom(), panelHow),
    ...size,
  });
  anchorHere();
}

/**
 * Grow or shrink the window around the panel.
 *
 * The orb lives at the window's bottom-right, so the window grows up and to the
 * left: the character stays exactly where it was parked.
 */
/**
 * Where the character is drawn inside a window of this size.
 *
 * Everything about keeping the orb still comes back to this one function. The
 * character is always hard against the right, inset by the stage padding and
 * the strip left for its shadow. Vertically it depends on which side the panel
 * grows from: the orb is at the BOTTOM when the panel is above it, and at the
 * TOP when the panel is below.
 */
function characterOffset(size, how) {
  return offsetInWindow(size, characterSize(), STAGE_PAD, shadowRoom(), how);
}

/** The character's rectangle on screen, right now. */
function characterRect() {
  const b = win.getBounds();
  const off = characterOffset({ width: b.width, height: b.height }, panelHow);
  return { ...characterSize(), x: b.x + off.x, y: b.y + off.y };
}

/**
 * Open or close the panel WITHOUT moving the orb.
 *
 * The old version anchored the window's bottom-right and then clamped it into
 * the work area, which is fine until there is no room above — near the top of
 * the screen the taller window would have hung off it, so the clamp pushed the
 * whole thing down and took the character with it. The orb jumping when you
 * open the chat is the one thing this must not do.
 *
 * So the character's rectangle is measured first and treated as fixed, the
 * panel goes on whichever side has room for it, and the window is placed around
 * that. No clamp afterwards: clamping is for a character that has been dragged
 * somewhere silly, not for one that has not moved at all.
 */
/**
 * Build the window around a character that is not allowed to move.
 *
 * This is the one place the window's bounds are decided. Give it where the orb
 * is — or where you want it to be — and it picks the corner the panel has room
 * to open into, shrinks the panel if no corner has room for all of it, and puts
 * the window wherever that puts it. The orb ends up exactly at `rect`.
 *
 * There is no clamp afterwards. Clamping is for a character that has been
 * dragged somewhere silly; it is the caller's job to hand this a sensible rect,
 * and the window that comes back may well hang off the screen by the width of
 * the shadow's strip, which is exactly what it should do.
 */
function placeAround(rect, open) {
  const { workArea } = screen.getDisplayNearestPoint({
    x: Math.round(rect.x + rect.width / 2),
    y: Math.round(rect.y + rect.height / 2),
  });

  // Closed, there is nothing to find room for, so the corner is KEPT rather
  // than reset. Resetting it looks harmless — a lone orb sits in the same place
  // whichever corner it is nominally in — but it changes the offset main
  // measures from at the same moment the window changes size, and the renderer
  // only hears about the new corner an IPC hop later. That one frame of
  // disagreement is a visibly misplaced orb. Keeping it means closing changes
  // exactly one thing.
  const how = open
    ? chooseSide(rect, panelSize(), characterSize(), STAGE_PAD, shadowRoom(), workArea, panelHow)
    : { side: panelHow.side, drop: panelHow.drop, size: orbSize() };

  panelHow = how;
  const at = windowFor(rect, how.size, characterSize(), STAGE_PAD, shadowRoom(), how);
  const b = win.getBounds();
  // Guarded because this runs every frame of a drag, and setting a window to
  // the bounds it already has is not free.
  if (at.x !== b.x || at.y !== b.y ||
      how.size.width !== b.width || how.size.height !== b.height) {
    win.setBounds({ ...at, ...how.size });
  }
  return how;
}

/** Tell the renderer which corner it is laying out for, if that has changed. */
function syncCorner(how, extra = null) {
  const s = state.get();
  if (extra || s.panelBelow !== how.drop || s.panelSide !== how.side) {
    state.set({ ...extra, panelBelow: how.drop, panelSide: how.side });
  }
}

function setPanelOpen(open) {
  if (open) hideHint();            // the tooltip never overlaps the conversation
  const how = placeAround(characterRect(), open);
  syncCorner(how, { panelOpen: !!open });
  // Returned as well as pushed. The push is how every other window learns the
  // corner; the return is how the one that asked learns it without waiting a
  // second hop, which matters because it is about to reveal the panel.
  return { side: how.side, drop: how.drop };
}

/*
 * The orb's tooltip lives in its OWN window.
 *
 * The first version lived inside the orb's window and borrowed the chat
 * panel's grow-the-window dance — and a one-frame tear during that resize
 * could show the orb somewhere it was not. A separate window never touches
 * the orb's bounds, so the tear is not rare now, it is impossible. It is also
 * simply less machinery: no corner to face, no size to negotiate, no state to
 * sync — a card, placed near the orb, shown and hidden.
 *
 * Click-through and unfocusable, so it can never steal the hover it explains,
 * and recreated per show: the query string is how it learns what to say, and
 * a tooltip appears far too rarely for creation to be worth caching.
 */
const HINT_WIN = { width: 380, height: 84 };
let hintWin = null;

// What may truthfully be said about the wake word right now (wake-info.js).
// Main owns every fact behind it AND the hover card, so the card asks here
// instead of having the renderer carry the answer back. Until the wake word is
// set up it claims nothing.
let wakeInfo = () => wakeTruth.wakeInfo();

function hideHint() {
  if (hintWin && !hintWin.isDestroyed()) hintWin.destroy();
  hintWin = null;
}

function showHint(info) {
  hideHint();
  const orb = characterRect();
  const { workArea } = screen.getDisplayNearestPoint({
    x: Math.round(orb.x + orb.width / 2),
    y: Math.round(orb.y + orb.height / 2),
  });

  // Above the orb, unless the orb is against the top of the screen.
  const below = orb.y - HINT_WIN.height - 2 < workArea.y;
  const y = below ? orb.y + orb.height - 6 : orb.y - HINT_WIN.height + 6;
  const cx = orb.x + orb.width / 2;
  const x = Math.round(Math.min(
    Math.max(cx - HINT_WIN.width / 2, workArea.x),
    workArea.x + workArea.width - HINT_WIN.width));

  const q = new URLSearchParams();
  if (info.voice) q.set('v', '1');
  if (info.note) q.set('n', String(info.note).slice(0, 200));
  // The voice row: "say hey fren" only while that would really open a line.
  const row = wakeTruth.hintVoiceRow(wakeInfo());
  if (row) q.set('w', row.kind);
  if (row && row.phrase) q.set('p', row.phrase);
  if (below) q.set('b', '1');
  q.set('tx', String(Math.round(cx - x)));    // where the tail finds the orb

  hintWin = new BrowserWindow({
    x, y, ...HINT_WIN,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    hasShadow: false,
    skipTaskbar: true,
    focusable: false,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  hintWin.setIgnoreMouseEvents(true);
  hintWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  hintWin.loadURL(`${SCHEME}://app/hint.html?${q}`);
  hintWin.once('ready-to-show', () => {
    if (hintWin && !hintWin.isDestroyed()) hintWin.showInactive();
  });
}

/**
 * The models pane, in its own small window, opened from the chat's header.
 *
 * Everything else about fren answers to conversation; the machinery it runs ON
 * gets a real pane, because a mistyped model id with no feedback is a silent
 * outage. One window, reused: pressing the button twice brings it forward.
 */
let settingsWin = null;
function openSettingsWin() {
  if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.show(); return; }
  settingsWin = new BrowserWindow({
    // The page's own size, not the frame's: the three cards measure 720 px
    // tall at this width with every line at its longest, and a settings pane
    // that scrolls by a few pixels looks broken rather than long.
    useContentSize: true,
    width: 460,
    height: 732,
    resizable: false,
    title: 'fren — models & voice',
    backgroundColor: '#FBF6EC',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  settingsWin.loadURL(`${SCHEME}://app/settings.html`);
  settingsWin.on('closed', () => { settingsWin = null; });
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
  // Wherever the orb's window goes, the tooltip beside it is now pointing at
  // nothing — so any move at all dismisses it. This is the one hook that
  // covers every way the window moves: a drag by the halo (which never
  // reaches the renderer at all), a drag by the character, the panel opening,
  // a rescue back onto the screen.
  win.on('move', () => hideHint());
  win.loadURL(`${SCHEME}://app/index.html`);
  positionWindow(orbSize());
  const b = win.getBounds();
  const { workArea, bounds: full, scaleFactor } = screen.getPrimaryDisplay();
  log(`[window] orb ${b.x},${b.y} ${b.width}x${b.height} | work ${workArea.x},${workArea.y} ` +
      `${workArea.width}x${workArea.height} | display ${full.width}x${full.height} @${scaleFactor}x`);
}

function orbCenter() {
  // The CHARACTER's centre, wherever in the window it currently sits, so the
  // gaze tracks the pointer relative to the face rather than to a window that
  // may extend well past it in either direction.
  const r = characterRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
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
  syncBrowserPolicy();
}

function stopObserving() {
  observer.stop();
  stopGaze();
  state.set({ observing: false });
  // The light going off closes EVERY eye, the browser's included. The
  // extension learns on its next heartbeat; the sensor stops listening now.
  syncBrowserPolicy();
}

/**
 * The browser sensor's policy is settings AND the light: browser awareness
 * only sees while fren is observing, exactly like the window observer. This
 * is the one function that composes the two, so they cannot drift.
 */
function syncBrowserPolicy() {
  if (!browserSensor) return;
  browserSensor.configure({
    enabled: state.get().observing && memory.getSetting('browserAwareness') !== 'off',
    readPage: memory.getSetting('browserReadPage') !== 'off',
    readSelection: memory.getSetting('browserReadSelection') !== 'off',
    exclusions: safeParse(memory.getSetting('browserExclusions'), []),
  });
}

function safeParse(s, fallback) {
  try { const v = JSON.parse(s || 'null'); return v === null ? fallback : v; }
  catch { return fallback; }
}

/** To the orb's window: the hover card and the models pane listen to nothing. */
function sendToOrb(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

/**
 * Answer a browser-read request from Core: the one page the person is on, with
 * its content, but only when the light is on and the page is not private. The
 * content leaves this process only here, and only because they approved it.
 */
function respondBrowserRead(id) {
  let page = null;
  try {
    const ctx = currentBrowserContext();
    if (ctx && ctx.tab && ctx.tab.url && ctx.page && !ctx.page.excluded && ctx.page.content) {
      page = { title: ctx.tab.title || '', url: ctx.tab.url || '', domain: ctx.tab.domain || '', content: ctx.page.content || '' };
    }
  } catch { /* treat as not available */ }
  gateway.browserRead({ id, page }).catch(() => {});
}

/**
 * First run: offer to set up browser awareness — once. Skipped if the
 * extension has ever paired, or if the person already waved the offer off.
 */
function maybeOfferBrowserSetup() {
  if (!win || win.isDestroyed()) return;
  if (browserTransport && browserTransport.hasPairs()) return;
  const state = memory.getSetting('browserOnboarding');
  if (state === 'skipped' || state === 'done') return;
  log('[browser] first-run: offering to set up browser awareness');
  win.webContents.send('fren:browserSetup', { storeUrl: config.BROWSER_EXTENSION_STORE_URL || '' });
}

/** A native OS notification from fren; clicking it brings fren forward. */
function showOsNotification({ title, body }) {
  try {
    if (!Notification || !Notification.isSupported()) return;
    const n = new Notification({ title: title.slice(0, 120), body: (body || '').slice(0, 400), silent: false });
    n.on('click', () => { try { recenter(); setPanelOpen(true); } catch { /* window gone */ } });
    n.show();
  } catch (err) {
    log(`[notify] could not show: ${err.message}`);
  }
}

/**
 * What the rest of fren asks for. Normalized context, no browser-specific
 * details — the agent consumes this, never the extension's wire format.
 */
function currentBrowserContext() {
  return browserSensor ? browserSensor.getContext() : null;
}

app.whenReady().then(() => {
  serveRenderer();
  // The gateway (FREN Core) must be up. The dev runner starts it, so we find it
  // live and leave it; a packaged app has no runner, so we start it ourselves.
  // Fire-and-forget: the health checks and the event stream below wait for it.
  // If the one we find is a previous life's, about to exit with its parent, the
  // first failed health check below starts ours (reviveGateway) — and a look
  // five seconds in catches that case without waiting for the 30 s beat.
  reviveGateway({ health: gateway.health, log }).then((how) => {
    if (how === 'existing') setTimeout(() => checkHealth(), 5000);
  });

  memory = openMemory(path.join(app.getPath('userData'), 'fren.db'));

  // What the desktop notices also reaches Core, where an automation may be
  // waiting for it ("whenever I open Figma"). Only changes travel, never every
  // tick; Core keeps them in memory for a day and sends nothing on.
  let lastNoticed = '';
  function notice(source, type, payload) {
    const key = `${source}:${type}:${JSON.stringify(payload)}`;
    if (key === lastNoticed) return;
    lastNoticed = key;
    gateway.observe([{ timestamp: Date.now(), source, type, payload }]).catch(() => {});
  }
  observer = createObserver({
    onObservation: (obs) => {
      memory.addObservation(obs);
      if (obs && obs.activeApp) {
        notice('os', 'active-window', { app: String(obs.activeApp), title: String(obs.windowTitle || '').slice(0, 200) });
        if (narrator) narrator.note({ kind: 'app', app: String(obs.activeApp), title: String(obs.windowTitle || '').slice(0, 200) });
      }
      // The login window in front means they are away; anything else after it
      // means they are back. This sees a return the power monitor can miss.
      if (obs && obs.activeApp === 'loginwindow') away('login window');
      else if (obs && obs.activeApp && awayAt) back('return').catch((err) => log(`[greeting] return: ${err.message}`));
    },
    log,
  });

  // The browser sense: pure sensor + loopback transport, per
  // docs/browser-awareness.md. Pairing goes through a native consent dialog;
  // granted pairs persist in settings (token hashes only).
  browserSensor = createBrowserSensor({
    onEvent: (type, detail) => {
      // A browsing signal for the thinking stream — read fresh from the sensor,
      // never for an excluded page, so a thought can be about the actual page or
      // the text they just highlighted. The narrator keys off the URL, so moving
      // around one site keeps producing thoughts while a re-render of the same
      // page does not, and it holds its own floor so none of this becomes noise.
      const noteBrowsing = (kind) => {
        if (!narrator) return;
        const ctx = currentBrowserContext();
        if (!ctx || !ctx.tab || (ctx.page && ctx.page.excluded)) return;
        const tab = ctx.tab;
        const sel = ctx.selection && ctx.selection.text ? String(ctx.selection.text) : '';
        narrator.note({
          kind,
          url: String(tab.url || '').slice(0, 500),
          domain: String(tab.domain || ''),
          pageTitle: String(tab.title || '').slice(0, 200),
          selection: sel.slice(0, 300),
        });
      };

      // Development visibility, without page contents.
      if (type === BROWSER_EVENTS.CONNECTED) log(`[browser] connected: ${detail.browser}`);
      else if (type === BROWSER_EVENTS.DISCONNECTED) log(`[browser] disconnected (${detail.reason})`);
      else if (type === BROWSER_EVENTS.TAB_CHANGED) log(`[browser] tab changed: ${detail.domain || '(opaque)'}`);
      else if (type === BROWSER_EVENTS.PAGE_OPENED) {
        log(`[browser] page opened: ${detail.excluded ? '(excluded domain)' : detail.domain}`);
        // The reading trail (deep-reading moments) counts distinct pages, so only
        // a freshly opened page feeds it — not every re-render below.
        if (proactive && !detail.excluded) proactive.noteBrowser(currentBrowserContext());
        if (!detail.excluded) {
          const ctx = currentBrowserContext();
          const tab = ctx && ctx.tab ? ctx.tab : {};
          notice('browser', 'page', { url: String(tab.url || '').slice(0, 500), domain: String(tab.domain || detail.domain || ''), title: String(tab.title || '').slice(0, 200) });
        }
        noteBrowsing('browser');
      }
      else if (type === BROWSER_EVENTS.PAGE_UPDATED) { log('[browser] page context updated'); noteBrowsing('browser'); }
      else if (type === BROWSER_EVENTS.SELECTION_CHANGED) { log(`[browser] selection changed (${detail.chars} chars)`); noteBrowsing('selection'); }
      else if (type === BROWSER_EVENTS.BROWSER_FOCUSED) { log('[browser] focused'); noteBrowsing('browser'); }
      else if (type === BROWSER_EVENTS.BROWSER_BLURRED) log('[browser] blurred');
      else if (type === BROWSER_EVENTS.PAGE_CLOSED) log('[browser] page closed');
    },
  });
  browserTransport = createBrowserTransport({
    port: config.BROWSER_SENSOR_PORT,
    onMessage: (msg) => browserSensor.ingest(msg),
    getPolicy: () => browserSensor.policy(),
    approve: async ({ browser, name, origin }) => {
      const { response } = await dialog.showMessageBox({
        type: 'question',
        buttons: ['Allow', 'Deny'],
        defaultId: 0,
        cancelId: 1,
        message: `Let ${browser} become one of fren's senses?`,
        detail: `"${name}" (${origin}) wants to tell fren what you are reading in the ` +
                'browser. It only ever talks to fren on this machine, only sees the ' +
                'active tab, and only while fren\'s light is on.',
      });
      return response === 0;
    },
    loadPairs: () => safeParse(memory.getSetting('browserPairs'), []),
    savePairs: (pairs) => {
      memory.setSetting('browserPairs', JSON.stringify(pairs));
      // The extension just paired: onboarding is done, and fren says hello to it.
      if (Array.isArray(pairs) && pairs.length && memory.getSetting('browserOnboarding') !== 'done') {
        memory.setSetting('browserOnboarding', 'done');
        if (win && !win.isDestroyed()) win.webContents.send('fren:browserConnected');
      }
    },
    log,
  });
  browserTransport.start().catch((err) => {
    // The port being taken must not take fren down with it; the sense is
    // simply unavailable.
    log(`[browser] sensor port unavailable: ${err.message}`);
    browserTransport = null;
  });
  browserStaleTimer = setInterval(() => browserSensor.checkStale(), 15_000);
  if (browserStaleTimer.unref) browserStaleTimer.unref();
  syncBrowserPolicy();
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

  // Moments: the third proactive watcher. Patterns notices repeated work,
  // curiosity asks to know you — this one watches for the TIMES a companion
  // naturally speaks first: you sit back down, you have been deep in one
  // topic, or enough has simply happened. It reuses the same suggestion
  // channel, so the orb-side behaviour (the beckoning bounce, right-click to
  // hear it) is one mechanism whoever noticed.
  proactive = createProactiveWatcher({
    memory,
    gateway,
    state,
    log,
    idleSeconds: () => {
      try { return require('electron').powerMonitor.getSystemIdleTime(); }
      catch { return 0; }
    },
    getBrowser: () => currentBrowserContext(),
    soulFor: () => soul.readContext(app.getPath('userData')).soul,
    profileFor: () => memory.getSetting('profile'),
    canSpeak: () => Date.now() - lastChatAt > 4 * 60 * 1000,
    onSuggestion: ({ message, moment }) => {
      if (win && !win.isDestroyed()) {
        win.webContents.send('fren:suggestion', { message, moment });
      }
    },
  });
  proactive.start();

  // Thinking out loud — the ordinary sign of life, the opposite of the rare
  // suggestion. When the active app or the open site changes, and no more often
  // than a gentle floor, fren has one short thought, and it shows as a thought
  // bubble so its owner can see it is paying attention. It thinks only while the
  // light is on, and it is fed from the same change signals fren already senses.
  narrator = createNarrator({
    gateway,
    state,
    getBrowser: () => currentBrowserContext(),
    soulFor: () => soul.readContext(app.getPath('userData')).soul,
    log,
    onThought: ({ text, kind, at }) => {
      if (win && !win.isDestroyed()) win.webContents.send('fren:narration', { text, kind, at });
    },
  });

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
  // reversed — at setup, by saying so, or by tapping the orb.
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

  // A beat after the greeting has had its moment, offer to set up the browser
  // sense — once, and never again once it's paired or waved off.
  setTimeout(maybeOfferBrowserSetup, 12_000);

  /**
   * Screens come and go, and fren must not go with them.
   *
   * Clamping on drag only covers fren moving. A display can move instead:
   * unplug the monitor fren was parked on, change the arrangement, or alter
   * the scale, and a window that was perfectly placed is suddenly nowhere —
   * with no title bar to drag it back by. macOS usually rehomes ordinary
   * windows; an always-on-top frameless one is not reliably ordinary.
   */
  for (const ev of ['display-removed', 'display-added', 'display-metrics-changed']) {
    screen.on(ev, () => {
      // After the layout settles, not during it.
      setTimeout(() => {
        if (!win || win.isDestroyed()) return;
        const before = win.getBounds();
        recenter();
        const after = win.getBounds();
        if (before.x !== after.x || before.y !== after.y) log(`[window] ${ev}: moved fren back`);
      }, 400);
    });
  }

  // Every window, not just the orb: the models pane shows what is running too.
  state.subscribe((s) => sendToOrb('fren:stateChanged', s));

  // Whether the gateway has a voice agent to open a line to (/health), and the
  // push that tells the renderer what it may say about the wake word. The real
  // push is assigned where the wake word is set up, further down.
  let voiceAgent = false;
  let pushWakeStatus = () => {};
  const checkHealth = async () => {
    try {
      const health = await gateway.health();
      // Before gatewayOk flips, so the one push that follows carries both.
      voiceAgent = !!(health && health.voiceAgent);
      if (!state.get().gatewayOk) state.set({ gatewayOk: true });
      // Whether the screen-looking button can be offered at all depends on a
      // model that can actually see; DeepSeek's chat models cannot.
      const canSee = !!(health && health.vision);
      if (state.get().canSeeScreen !== canSee) state.set({ canSeeScreen: canSee });
      noteRuntime(health && health.runtime);
      // The agent behind typed chat takes the chosen model from the gateway's
      // memory, which a gateway restart empties. Say it again whenever the
      // gateway has not heard it: at launch, and after any restart.
      if (providerSettings.runtimeModelStale(health, providerSettings.read(memory))) tellRuntimeModel();
      // A cold gateway answers its first health check late; whether "say hey
      // fren" may be promised changes right here, not on any wake event.
      pushWakeStatus();
    } catch {
      if (state.get().gatewayOk) state.set({ gatewayOk: false });
      noteRuntime(null);
      // Nobody is answering: start ours if nobody's is running (one attempt
      // at a time; the next beat asks again if this one did not take).
      reviveGateway({ health: gateway.health, log }).then((how) => { if (how === 'started') checkHealth(); });
    }
  };
  function tellRuntimeModel() {
    return gateway.setRuntimeModel(providerSettings.read(memory).chatModel)
      // Not fatal and not retried here: the next health check sees the gateway
      // still has not heard, and says it again.
      .catch((err) => log(`[settings] the chosen model did not reach the gateway (${err.message})`));
  }
  /** The environment's state, only when it changed — this fires every 30 s. */
  function noteRuntime(status) {
    const runtime = status && status.state ? status.state : 'unavailable';
    const runtimeHint = status ? (status.hint || status.reason || '') : '';
    const s = state.get();
    if (s.runtime !== runtime || s.runtimeHint !== runtimeHint) state.set({ runtime, runtimeHint });
  }
  checkHealth();
  setInterval(checkHealth, 30_000);

  // Core's push channel. Runs, automations and permission requests arrive
  // here as they happen; main keeps the orb's busy face and the transcript in
  // step, then hands every event to every window.
  const workingRuns = new Set();
  function handleCoreEvent(e) {
    if (!e || typeof e !== 'object') return;
    if (e.type === 'runtime.status' && e.status) {
      noteRuntime(e.status);
    } else if (e.type === 'agent.working' && e.runId && e.kind === 'chat') {
      // Only a reply to the person shows on the face; an automation working in
      // the background is not fren thinking about what you said. Balanced per
      // run, so a lost 'off' cannot leave fren thinking forever.
      if (e.on && !workingRuns.has(e.runId)) { workingRuns.add(e.runId); state.beginReply(); }
      if (!e.on && workingRuns.has(e.runId)) { workingRuns.delete(e.runId); state.endReply(); }
    } else if (/^run\.(completed|failed|cancelled|interrupted)$/.test(e.type) && workingRuns.has(e.runId)) {
      workingRuns.delete(e.runId);
      state.endReply();
    } else if (e.type === 'agent.message' && e.kind === 'chat' && e.message && e.message.text) {
      // What the agent said in the conversation belongs in the transcript, the
      // same as a reply from the fast lane.
      remember('fren', e.message.text);
    } else if (e.type === 'notify' && e.title) {
      // The agent asked to reach the person; fren already got their go-ahead.
      showOsNotification({ title: String(e.title), body: String(e.body || '') });
    } else if (e.type === 'browser.read.request' && e.id) {
      // Core (with the person's go-ahead) wants the page they are on. The
      // content lives only here; hand back this one page, or an absence.
      respondBrowserRead(e.id);
    }
    sendToOrb('fren:coreEvent', e);
  }
  coreEvents = gateway.openEvents({
    since: 'latest',
    onEvent: handleCoreEvent,
    onStatus: (status, detail) => { if (status === 'disconnected') log(`[core] events ${status}${detail ? `: ${detail}` : ''}`); },
  });

  // Automations that run an agent: FREN's model, kept by Core. Every call is
  // a thin pass-through with the error turned into a value the renderer can
  // show, the same convention the script automations use.
  const passthrough = (fn) => async (_e, ...args) => {
    try { return await fn(...args); } catch (err) { return { error: err.message }; }
  };
  ipcMain.handle('fren:automationIntent', passthrough((text) => gateway.automationIntent(String(text ?? '').trim().slice(0, 2000))));
  ipcMain.handle('fren:createAgentAutomation', passthrough(async (spec) => (await gateway.createAgentAutomation(spec && typeof spec === 'object' ? spec : {})).automation));
  ipcMain.handle('fren:patchAgentAutomation', passthrough(async (id, patch) => (await gateway.patchAgentAutomation(String(id), patch && typeof patch === 'object' ? patch : {})).automation));
  ipcMain.handle('fren:deleteAgentAutomation', passthrough((id) => gateway.deleteAgentAutomation(String(id))));
  ipcMain.handle('fren:runAgentAutomation', passthrough((id) => gateway.runAgentAutomation(String(id))));
  ipcMain.handle('fren:permissionRequests', passthrough(async (status) => (await gateway.permissionRequests(status ? String(status) : '')).requests));
  ipcMain.handle('fren:decidePermission', passthrough(async (id, decision, opts) => (await gateway.decidePermission(String(id), {
    decision: decision === 'approve' ? 'approve' : 'deny',
    reason: opts && typeof opts.reason === 'string' ? opts.reason.slice(0, 200) : '',
    remember: opts && ['session', 'always', 'once'].includes(opts.remember) ? opts.remember : 'once',
  })).request));

  /**
   * Ask fren through the secure execution environment. Accepted or refused
   * right away; what it says arrives as fren:coreEvent messages for the run.
   * Refusal is an answer too: the caller falls back to the fast lane.
   */
  ipcMain.handle('fren:run', async (_e, text) => {
    const question = String(text ?? '').trim().slice(0, 4000);
    if (!question) return { error: 'nothing to say' };
    if (state.get().runtime !== 'ready') return { error: 'the secure execution environment is not ready' };
    const character = soul.readContext(app.getPath('userData'));
    try {
      const { run } = await gateway.startRun({ text: question, persona: character.soul });
      lastChatAt = Date.now();
      remember('you', question);
      return { runId: run.id };
    } catch (err) {
      log(`[run] refused: ${err.message}`);
      return { error: err.message };
    }
  });

  ipcMain.handle('fren:getState', () => state.get());

  ipcMain.handle('fren:toggleObservation', () => {
    if (state.get().observing) stopObserving();
    else startObserving();
    return state.get();
  });

  // The orb lives at the window's bottom-right, so the window grows up and to
  // the left: the character stays exactly where the user parked it.
  ipcMain.handle('fren:setPanelOpen', (_e, open) => setPanelOpen(open));

  // Asked before opening, so the stage can be laid out for the corner the panel
  // is about to use while the window is still orb-sized. Doing it afterwards
  // instead leaves one frame where the window is already panel-sized and the
  // renderer still has the old corner, which puts the orb a long way from where
  // main just placed it. This only reads geometry; nothing moves.
  ipcMain.handle('fren:aimPanel', () => {
    const rect = characterRect();
    const { workArea } = screen.getDisplayNearestPoint({
      x: Math.round(rect.x + rect.width / 2),
      y: Math.round(rect.y + rect.height / 2),
    });
    const how = chooseSide(rect, panelSize(), characterSize(), STAGE_PAD, shadowRoom(), workArea, panelHow);
    return { side: how.side, drop: how.drop };
  });

  // A function rather than a handler body: saying "don't read this site" in
  // the chat has to mean exactly what flipping the switch meant.
  function applyBrowserSettings(patch) {
    const p = patch || {};
    if (typeof p.awareness === 'boolean') memory.setSetting('browserAwareness', p.awareness ? 'on' : 'off');
    if (typeof p.readPage === 'boolean') memory.setSetting('browserReadPage', p.readPage ? 'on' : 'off');
    if (typeof p.readSelection === 'boolean') memory.setSetting('browserReadSelection', p.readSelection ? 'on' : 'off');
    if (p.exclusions !== undefined) {
      const { sanitizeExclusions } = require('./browser-sensor');
      memory.setSetting('browserExclusions', JSON.stringify(sanitizeExclusions(p.exclusions)));
    }
    syncBrowserPolicy();
    return safeParse(memory.getSetting('browserExclusions'), []);
  }
  // "Enable" / "Add to Chrome": once the extension is on the Web Store this
  // opens its listing (one click); until then it opens the unpacked folder so
  // the developer path can load it. One flag decides which.
  ipcMain.handle('fren:openBrowserExtension', () => {
    const storeUrl = config.BROWSER_EXTENSION_STORE_URL;
    if (storeUrl) return void shell.openExternal(storeUrl);
    shell.openPath(path.join(__dirname, '..', '..', 'browser-extension'));
  });
  // First-run: fren stops offering to set up browser awareness.
  ipcMain.handle('fren:dismissBrowserSetup', () => {
    memory.setSetting('browserOnboarding', 'skipped');
  });

  ipcMain.handle('fren:getOrbLook', () => {
    try { return palette.sanitizeLook(JSON.parse(memory.getSetting('orbLook') || 'null')); }
    catch { return null; }
  });
  // The governor's food: the renderer says how each held suggestion ended,
  // and fren's forwardness drifts to match. See paceFor in proactive.js.
  ipcMain.handle('fren:suggestionOutcome', (_e, kind) => {
    if (proactive && proactive.noteOutcome) proactive.noteOutcome(kind);
  });

  ipcMain.handle('fren:setHint', (_e, open, info) => {
    if (!open) { hideHint(); return true; }
    if (state.get().panelOpen) return null;
    showHint(info || {});
    return true;
  });

  /**
   * A way in that does not depend on the right mouse button.
   *
   * The chat panel is opened by right-clicking the orb now, which is fine until
   * it is not: a mouse with one button, an input device that cannot send it, or
   * a drag region quietly swallowing the event, and the panel is unreachable —
   * on a window with no title bar, no close button and no menu of its own.
   *
   * macOS gives every app a dock icon unless it asks not to, so there is
   * already a menu there. This puts the two doors into it. Windows and Linux
   * have no equivalent, and would want a tray icon; that is not built.
   */
  if (process.platform === 'darwin' && app.dock) {
    app.dock.setMenu(Menu.buildFromTemplate([
      { label: 'Bring fren back', click: () => recenter() },
      { label: 'Open the chat', click: () => { setPanelOpen(true); recenter(); } },
    ]));
  }

  // Dragged by the CHARACTER, not by the window. The window is a different size
  // and in a different place depending on which corner the panel is in, so
  // holding the cursor at a fixed offset from its origin meant the orb slid out
  // from under the pointer whenever that changed. Holding it at a fixed offset
  // from the orb is also what makes it safe for the panel to flip mid-drag: the
  // window can move and resize underneath and the orb still tracks the cursor.
  ipcMain.handle('fren:dragStart', () => {
    const cursor = screen.getCursorScreenPoint();
    const from = characterRect();
    drag = { dx: cursor.x - from.x, dy: cursor.y - from.y, from, moved: false, timer: null };
    drag.timer = setInterval(() => {
      if (!drag || !win || win.isDestroyed()) return;
      const c = screen.getCursorScreenPoint();
      const ch = characterSize();
      const want = { ...ch, x: c.x - drag.dx, y: c.y - drag.dy };
      if (Math.abs(want.x - drag.from.x) > 2 || Math.abs(want.y - drag.from.y) > 2) {
        drag.moved = true;
      }
      // Clamped, so fren can be parked against any edge but never carried off
      // one. There is no title bar to grab it back by.
      const { workArea } = screen.getDisplayNearestPoint({
        x: Math.round(want.x + ch.width / 2),
        y: Math.round(want.y + ch.height / 2),
      });
      // With the chat open this re-chooses the corner every frame, so dragging
      // fren into the top-left flips the panel down and to the right as it
      // goes rather than sliding it off the screen.
      syncCorner(placeAround({ ...ch, ...clampInto(want, ch, workArea) },
        state.get().panelOpen));
      // Dragging is fren being moved on purpose, so this is where it wants to
      // be now — including if the drag ends with it pressed against an edge.
      anchorHere();
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

  // Conversation mode — fren talking over a live line (docs/voice-agent.md).
  // The renderer runs the session; main is where fren's memory and senses are,
  // so the agent's questions come here. Everything the agent learns about the
  // past and the present passes through these four handlers, and nothing else.
  const userDataDir = () => app.getPath('userData');
  const profileName = () => {
    const raw = memory.getSetting('profile');
    const prof = typeof raw === 'string' ? safeParse(raw, {}) : (raw || {});
    return String((prof && prof.name) || '').trim().slice(0, 60);
  };

  /** The ticket and the character: a signed URL plus what fills the prompt. */
  ipcMain.handle('fren:voice.session', async () => {
    let signedUrl;
    try {
      ({ signedUrl } = await gateway.voiceSession());
    } catch (err) {
      return { error: (err && err.message) || 'could not open the line' };
    }
    const character = soul.readContext(userDataDir());
    const digest = intelligence.voiceDigest({
      memories: memory.getRecentMemories({ sinceMs: Date.now() - 5 * 60 * 60 * 1000, limit: 8 }),
      observation: state.get().observing ? memory.getRecentObservations({ limit: 1 })[0] : null,
      browser: state.get().observing ? currentBrowserContext() : null,
    });
    log('[voice] session opened');                   // PRIVACY: that, never what
    return {
      signedUrl,
      dynamicVariables: {
        user_name: profileName() || 'there',
        soul: String(character.soul || '').slice(0, 4000),
        recent_context: digest.recent_context,
        local_time: digest.local_time,
      },
    };
  });

  /** look_around: what is in front of them right now, in words. */
  ipcMain.handle('fren:voice.lookAround', async () => {
    if (!state.get().observing) return 'The light is off: fren is not looking at anything right now.';
    const parts = [];
    const obs = memory.getRecentObservations({ limit: 1 })[0];
    if (obs && obs.activeApp) {
      const title = String(obs.windowTitle || '').trim().slice(0, 120);
      parts.push(`In front of them: ${obs.activeApp}${title ? ` — "${title}"` : ''}.`);
    }
    const ctx = currentBrowserContext();
    if (ctx && ctx.tab && ctx.tab.url && !(ctx.page && ctx.page.excluded)) {
      parts.push(`In the browser (${ctx.active ? 'focused' : 'in the background'}): "${String(ctx.tab.title || '(untitled)').slice(0, 120)}" — ${String(ctx.tab.url).slice(0, 300)}`);
      if (ctx.page && ctx.page.description) parts.push(`Page description: ${String(ctx.page.description).slice(0, 300)}`);
      if (ctx.selection && ctx.selection.text) parts.push(`They have selected this text: "${String(ctx.selection.text).slice(0, 500)}"`);
      if (ctx.page && ctx.page.content) parts.push(`Readable page excerpt: ${String(ctx.page.content).slice(0, 1500)}`);
    }
    return parts.length ? parts.join('\n') : 'Nothing on screen that fren can see right now.';
  });

  /** recall: what fren noticed earlier, and the notes it keeps — nothing else. */
  ipcMain.handle('fren:voice.recall', async (_e, question) => {
    const q = String(question || '').toLowerCase();
    const words = q.split(/[^a-z0-9]+/).filter((w) => w.length >= 4);
    const lines = [];
    const memories = memory.getRecentMemories({ sinceMs: Date.now() - 8 * 60 * 60 * 1000, limit: 10 });
    if (memories.length) {
      lines.push('Recent activity, earliest first:');
      for (const m of memories) {
        const activity = String(m.activity || '').trim();
        if (activity) lines.push(`- ${activity.slice(0, 200)}`);
      }
    } else {
      lines.push('No recent activity noted (the light may have been off).');
    }
    const facts = soul.readFacts(userDataDir());
    const matching = words.length ? facts.filter((f) => words.some((w) => f.toLowerCase().includes(w))) : [];
    if (matching.length) lines.push('', 'Notes that seem relevant:', ...matching.slice(-8));
    else if (facts.length) lines.push('', `No notes match that (fren keeps ${facts.length} notes about them).`);
    return lines.join('\n');
  });

  /**
   * remember: something they said, weighed the same way a curiosity answer is.
   * One function for the spoken line and for a typed "remember that …", so a
   * note lands in the same place however it was said.
   */
  async function rememberNote(note, tag) {
    const said = String(note || '').trim().slice(0, 500);
    if (!said) return { kept: false };
    let fact = '';
    try {
      const weighed = await gateway.learn({ question: 'Something they said in conversation', answer: said });
      if (weighed.worthKeeping) fact = weighed.fact || '';
    } catch (err) {
      log(`[${tag}] could not weigh that: ${err.message}`);
    }
    // A typed or dictated "remember that …" is an instruction from the owner,
    // so the model only gets to tidy the wording: if it declines, or cannot be
    // reached, their own words are kept. The voice agent's tool is a model
    // deciding what to file, and stays behind the judgement.
    if (!fact && tag === 'chat') fact = said;
    if (!fact) return { kept: false };
    const kept = soul.rememberFact(userDataDir(), fact);
    if (kept) log(`[${tag}] kept one thing from the conversation`);   // PRIVACY: that, never what
    return { kept };
  }
  ipcMain.handle('fren:voice.remember', (_e, note) => rememberNote(note, 'voice'));

  /** A turn of the conversation, into the same transcript as typed chat. */
  ipcMain.handle('fren:voice.said', async (_e, role, text) => {
    const line = String(text || '').trim().slice(0, 4000);
    if (!line) return;
    remember(role === 'user' ? 'you' : 'fren', line);
    lastChatAt = Date.now();                        // the watchers hold while we talk
  });

  // The line from anywhere: one key, wherever the cursor is. A toggle, not a
  // hold — a global shortcut fires on key-down only, so "hold to talk" cannot
  // be done system-wide — press to open, press again to close (it closes on
  // silence regardless). The default stays off Spotlight (Cmd+Space) and
  // Alfred (Option+Space); FREN_TALK_KEY overrides it. A key already taken by
  // another app simply fails to register, and the log says so.
  const talkKey = String(process.env.FREN_TALK_KEY || 'CommandOrControl+Shift+Space');
  let hotkeyOk = false;            // only a key that really registered is ever named to the owner
  try {
    const { globalShortcut } = require('electron');
    const ok = globalShortcut.register(talkKey, () => {
      if (win && !win.isDestroyed()) win.webContents.send('fren:voice.toggle');
    });
    hotkeyOk = !!ok;
    log(ok ? `[voice] hotkey ${talkKey}` : `[voice] hotkey ${talkKey} is taken by another app; set FREN_TALK_KEY to use a different one`);
    app.on('will-quit', () => { try { globalShortcut.unregisterAll(); } catch { /* going anyway */ } });
  } catch (err) {
    log(`[voice] no hotkey: ${err.message}`);
  }

  // The wake word: "hey fren", spoken, opens the line (wake-word.js). On-device
  // — openWakeWord, no account, no key — and it can be switched off outright
  // with FREN_WAKE_WORD=off. It follows the light — armed only while fren is
  // watching — it stands down for the length of a conversation, when the
  // agent has the microphone, and it stands down while the Mac sleeps or is
  // locked, when nobody is there. The phrase it listens for is "hey fren" — as
  // text, by keyword spotting, no training — unless a trained model of your
  // own has been placed, or FREN_WAKE_KEYWORD says otherwise (a phrase, a
  // pretrained openWakeWord name, or an .onnx path; docs/voice-agent.md §9).
  // Nothing in here may take the app's boot down with it: a listener that
  // cannot be set up is a line in the log, and holding the orb still works.
  const wakeOn = String(process.env.FREN_WAKE_WORD || 'on').toLowerCase() !== 'off';
  const WAKE_SETTLE_MS = 2000;       // after waking or unlocking, before the microphone is opened again
  const WAKE_HEARTBEAT_MS = 30000;   // how often a backed-off listener gets another look
  let voiceLineOpen = false;
  let wakeWord = null;
  let syncWakeWord = () => {};
  ipcMain.handle('fren:voice.state', (_e, open) => { voiceLineOpen = !!open; syncWakeWord(); pushWakeStatus(); });
  // The keyword the listener gets and the phrase a person can be told to say
  // come from one derivation, so the interface can never quote a phrase the
  // engine is not listening for.
  const spoken = wakeTruth.wakePhrase(process.env.FREN_WAKE_KEYWORD, path.join(app.getPath('userData'), 'wake', 'hey-fren.onnx'));
  const hotkey = wakeTruth.hotkeyLabel({ custom: process.env.FREN_TALK_KEY, registered: hotkeyOk });
  wakeInfo = () => wakeTruth.wakeInfo({
    status: wakeWord ? wakeWord.status() : null,
    observing: state.get().observing,
    gatewayOk: state.get().gatewayOk,
    voiceAgent,
    phrase: spoken.phrase,
    alias: spoken.alias,
    hotkey,
  });
  let lastWakeStatus = '';
  pushWakeStatus = () => {
    const info = wakeInfo();
    const json = JSON.stringify(info);
    if (json === lastWakeStatus) return;          // asked often, said only when it changed
    lastWakeStatus = json;
    if (win && !win.isDestroyed()) win.webContents.send('fren:voice.wakeStatus', info);
  };
  ipcMain.handle('fren:voice.wakeStatus', () => wakeInfo());
  // The one explanation of "hey fren", once, for new and existing owners alike
  // (wake-info.js has the words). The renderer asks when it sees the wake word
  // really listening and is free to say something; it gets the text exactly
  // once, and only while every sentence in it is true. Asking IS the telling —
  // it is written to the transcript and marked here, in one step — so nothing
  // the renderer does afterwards can make fren explain itself twice.
  ipcMain.handle('fren:voice.intro', () => {
    const info = wakeInfo();
    if (!info.armed || !info.canConverse) return null;
    if (!memory.getSetting('profile') || memory.getSetting('voiceIntro')) return null;
    const text = wakeTruth.voiceIntroCopy(info);
    remember('fren', text);
    memory.setSetting('voiceIntro', 'done');
    log('[wake] explained the wake word, once');
    return text;
  });
  // The light going on or off, and the gateway coming or going, change what is
  // true even when the wake word is switched off (holding the orb still works).
  state.subscribe(() => pushWakeStatus());
  if (wakeOn) {
    try {
      wakeWord = createWakeListener({
        keyword: spoken.keyword,
        sensitivity: process.env.FREN_WAKE_SENSITIVITY,
        modelsDir: path.join(app.getPath('userData'), 'wake', 'models'),
        engineOptions: { onsetRestart: String(process.env.FREN_WAKE_ONSET_RESTART || 'on').toLowerCase() !== 'off' },
        // Ask macOS for the microphone here, asynchronously, so the recorder is
        // never constructed while the permission prompt is still unanswered.
        micAccess: async () => {
          const { systemPreferences } = require('electron');
          if (!systemPreferences || typeof systemPreferences.getMediaAccessStatus !== 'function') return 'unknown';
          const status = systemPreferences.getMediaAccessStatus('microphone');
          if (status !== 'not-determined') return status;
          return (await systemPreferences.askForMediaAccess('microphone')) ? 'granted' : 'denied';
        },
        log,
        onWake: () => { if (win && !win.isDestroyed()) win.webContents.send('fren:voice.wake'); },
        onChange: () => pushWakeStatus(),
      });
      // It listens only while somebody is there (wake-info.js, wantWake): the
      // light is on, no conversation has the microphone, and the Mac is neither
      // asleep nor locked. `fresh` is owed by an unlock — the one moment somebody
      // is known to be there — and spent by the next arm, whenever that is: it
      // forgets a failing microphone's backoff (wake-word.js). Merely waking
      // earns none: a Mac also wakes by itself, with nobody there.
      const { powerMonitor } = require('electron');
      let asleep = false;
      let locked = false;
      let fresh = false;
      let settleTimer = null;
      // The lock events are only what fren witnessed — it may have started behind
      // a lock screen, and one posted around sleep can come late or never — so
      // macOS is asked too: now, after every settle, and on the heartbeat.
      const askLocked = () => {
        try { locked = wakeTruth.screenLocked(powerMonitor.getSystemIdleState(1), locked); } catch { /* the events stand */ }
      };
      askLocked();
      syncWakeWord = () => {
        const want = wakeTruth.wantWake({ observing: state.get().observing, lineOpen: voiceLineOpen, asleep, locked, settling: !!settleTimer });
        if (want && !wakeWord.armed()) { wakeWord.arm({ fresh }); fresh = false; }
        else if (!want && wakeWord.armed()) wakeWord.disarm();
      };
      // Going: the microphone is let go HERE, in the handler, before the
      // machine sleeps — not on some later tick it may never get.
      const standDown = (why) => {
        if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
        fresh = false;
        if (wakeWord.armed()) log(`[wake] standing down — the Mac ${why}`);
        wakeWord.disarm();
      };
      // Coming back: audio devices return late, so wait a moment, then look
      // again. Woken but still locked stays unheard until the unlock, and a
      // listener that is already armed has nothing to settle for.
      const comeBack = () => {
        if (settleTimer) clearTimeout(settleTimer);
        settleTimer = null;
        if (asleep || locked || wakeWord.armed()) return;
        settleTimer = setTimeout(() => { settleTimer = null; askLocked(); syncWakeWord(); }, WAKE_SETTLE_MS);
      };
      powerMonitor.on('suspend', () => { asleep = true; standDown('is going to sleep'); });
      powerMonitor.on('lock-screen', () => { locked = true; standDown('is locked'); });
      powerMonitor.on('resume', () => { asleep = false; comeBack(); });
      powerMonitor.on('unlock-screen', () => { locked = false; fresh = true; comeBack(); });
      state.subscribe(() => syncWakeWord());
      syncWakeWord();
      // One slow heartbeat, so a microphone that failed is tried again when its
      // backoff has passed, without waiting for some unrelated change of state —
      // and so a lock or unlock whose event never came is noticed all the same.
      // When nothing needs doing it does nothing.
      const wakeHeartbeat = setInterval(() => { askLocked(); syncWakeWord(); }, WAKE_HEARTBEAT_MS);
      app.on('will-quit', () => {
        clearInterval(wakeHeartbeat);
        if (settleTimer) clearTimeout(settleTimer);
        try { wakeWord.disarm(); } catch { /* going anyway */ }
      });
    } catch (err) {
      log(`[wake] setup failed — wake word off: ${err.message}`);
      wakeWord = null;
      syncWakeWord = () => {};
    }
  } else {
    log('[wake] off (FREN_WAKE_WORD=off)');
  }

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
  const GREET_AFTER_MS = 30 * 60 * 1000;   // a gap shorter than this is not an arrival (a relaunch)
  const RETURN_AFTER_MS = 10 * 60 * 1000;  // away shorter than this is not a return (a coffee)
  const RECENT_GREETINGS = 'recentGreetings';
  let lastGreetAt = 0;
  // When they went away, kept in settings so a restart while the screen is
  // locked does not forget it and skip the hello on their return.
  let awayAt = Number(memory.getSetting('awayAt')) || null;

  /**
   * The hello itself, from what fren wrote down before: the last thing noted,
   * the facts it keeps, what it does for them and asks them. Different each
   * time, because the last few are named so the shape is not reused, and
   * with one gentle thing to pick up when the notes give one.
   */
  async function composeGreeting(gapMs) {
    // The introduction IS the greeting on a first launch, and it is a better one.
    if (!memory.getSetting('profile')) return { text: null, why: 'first launch' };
    let recent = [];
    try { recent = JSON.parse(memory.getSetting(RECENT_GREETINGS) || '[]'); } catch { recent = []; }
    // Only what was written down before. Nothing here is live.
    let lastActivity = '';
    try {
      const [latest] = memory.getRecentMemories({ sinceMs: Date.now() - 7 * 24 * 3600 * 1000, limit: 1 });
      if (latest) lastActivity = latest.activity || '';
    } catch { /* nothing observed yet */ }
    let facts = '';
    try {
      const mem = soul.readAll(app.getPath('userData')).files.find((f) => f.name === 'MEMORY.md');
      facts = (mem ? mem.text : '').split('## Days')[0].split('\n')
        .filter((l) => l.startsWith('- ')).slice(-6).join('\n');
    } catch { /* no facts yet */ }
    let automations = [];
    try {
      const res = await gateway.agentAutomations();
      const list = Array.isArray(res) ? res : (res && res.automations) || [];
      automations = list.filter((a) => a.enabled).slice(0, 8).map((a) => `${a.name} (${a.describe})`);
    } catch { /* none to speak of */ }
    let routines = [];
    try { routines = memory.getRoutines().slice(0, 6).map((r) => r.name); } catch { /* none */ }
    try {
      const { text } = await gateway.greet({
        profile: memory.getSetting('profile'),
        lastSeenMs: gapMs === null ? null : Date.now() - gapMs,
        lastActivity,
        facts,
        avoid: recent,
        automations,
        routines,
      });
      if (!text) return { text: null, why: 'nothing came back' };
      try {
        memory.setSetting(RECENT_GREETINGS, JSON.stringify([...recent, text].slice(-4)));
      } catch { /* the greeting still stands */ }
      lastGreetAt = Date.now();
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
  }

  ipcMain.handle('fren:greeting', async () => {
    const gap = lastSeenAt ? Date.now() - lastSeenAt : null;
    if (gap !== null && gap < GREET_AFTER_MS) return { text: null, why: 'just restarted' };
    return composeGreeting(gap);
  });

  // A return: the machine waking or the screen unlocking after a while away.
  // The renderer says it when fren is free, so it never lands over a reply.
  const { powerMonitor } = require('electron');
  const away = (why) => {
    if (awayAt) return;   // the first sign of leaving is the one that counts
    awayAt = Date.now();
    try { memory.setSetting('awayAt', awayAt); } catch { /* the in-memory mark still stands */ }
    log(`[greeting] away (${why})`);
  };
  const back = async (why) => {
    const awayMs = awayAt ? Date.now() - awayAt : 0;
    awayAt = null;
    try { memory.setSetting('awayAt', ''); } catch { /* fine */ }
    const verdict = arrival.shouldGreetOnReturn({ awayMs, lastGreetAt, now: Date.now(), minAwayMs: RETURN_AFTER_MS });
    if (!verdict.greet) { log(`[greeting] ${why}: ${verdict.why}`); return; }
    const { text } = await composeGreeting(awayMs);
    if (text) sendToOrb('fren:greet', { text, why });
  };
  powerMonitor.on('suspend', () => away('sleep'));
  powerMonitor.on('lock-screen', () => away('lock'));
  powerMonitor.on('resume', () => { back('wake').catch((err) => log(`[greeting] wake: ${err.message}`)); });
  powerMonitor.on('unlock-screen', () => { back('unlock').catch((err) => log(`[greeting] unlock: ${err.message}`)); });

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
    // The remembered anchor, NOT where the orb currently is. Those differ
    // exactly when the orb has been clamped by a screen edge, which is the case
    // this has to get right: measuring the clamped position here is what made
    // zooming in and back out leave fren somewhere else.
    //
    // Measured BEFORE the scale changes either way, because characterRect() is
    // computed from it, and reading it afterwards would describe where the orb
    // is about to be rather than where it is.
    if (!orbAnchor) anchorHere();
    const centre = orbAnchor;

    const wasScale = orbScale;
    orbScale = clampScale(next);

    // Re-chosen rather than kept: a bigger orb needs a bigger window, and the
    // corner that had room for the old one may not have room for this one.
    const ch = characterSize();
    const want = {
      ...ch,
      x: Math.round(centre.x - ch.width / 2),
      y: Math.round(centre.y - ch.height / 2),
    };
    const { workArea } = screen.getDisplayNearestPoint({
      x: Math.round(centre.x), y: Math.round(centre.y),
    });
    syncCorner(placeAround({ ...ch, ...clampInto(want, ch, workArea) },
      state.get().panelOpen));
    const size = win.getBounds();
    // Written every time rather than on a debounce: this is one small integer,
    // and the alternative is losing the size to a crash or a force-quit right
    // after someone has just set it.
    if (orbScale !== wasScale) {
      try { memory.setSetting('orbScale', orbScale); } catch { /* size still applied */ }
      log(`[orb] resized to ${orbScale.toFixed(2)}x (${size.width}px)`);
    }
    return {
      scale: orbScale, min: SCALE_MIN, max: SCALE_MAX,
      // What the window is NOW, so the renderer can tell whether a resize
      // event is coming at all — a clamped notch changes nothing, and waiting
      // for an event that will never fire is a stall per notch.
      size: { width: size.width, height: size.height },
    };
  });

  ipcMain.handle('fren:getOrbScale', () => ({ scale: orbScale, min: SCALE_MIN, max: SCALE_MAX }));

  ipcMain.handle('fren:openSettings', () => openSettingsWin());

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
        // What the agent behind typed chat is answering with right now —
        // only while there IS such an agent: with the environment not ready,
        // typed chat is answered by the model above.
        runtimeModel: live.runtimeModel && live.runtime && live.runtime.state === 'ready'
          ? live.runtimeModel.inEffect : null,
      } : null,
      whisper: whisper.detect(),
    };
  });

  ipcMain.handle('fren:setProviders', async (_e, patch) => {
    const before = providerSettings.read(memory).chatModel;
    const saved = providerSettings.write(memory, patch);
    gateway.setOverrides(saved);
    // The fast lane has it from the line above. The agent that answers typed
    // chat runs inside the gateway and has to be told — waited for, so the
    // pane's next read of "what is running" already shows it.
    if (saved.chatModel !== before) await tellRuntimeModel();
    whisper.setPreferences(saved);
    // PRIVACY: which fields changed, never their values.
    log(`[settings] providers updated (${Object.keys(patch || {}).join(', ') || 'nothing'})`);
    // Echo what was actually kept, so a rejected value shows as rejected.
    return saved;
  });

  /**
   * What colour fren is.
   *
   * Stored as a plain integer and sent to the orb, because the colour is
   * changed HERE (by asking for it — see own-business.js) while the orb is
   * drawn in the window. Without the message the choice would only take effect
   * at the next launch, which for a colour — the one setting whose whole point
   * is that you can see it — would feel broken rather than deferred.
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

  function setOrbColour(hex) {
    const n = Number(hex);
    const value = Number.isFinite(n) && n >= 0 && n <= 0xffffff ? Math.round(n) : null;
    if (value === null) return { colour: null };
    memory.setSetting('orbColour', value);
    // "Go back to orange" means all the way back: a look tuned in the old
    // window has no other way off, now that the window is gone.
    if (value === palette.DEFAULT_HEX) memory.setSetting('orbLook', '');
    if (win && !win.isDestroyed()) win.webContents.send('fren:orbColour', value);
    log(`[orb] colour set to #${value.toString(16).padStart(6, '0')}`);
    return { colour: value };
  }
  function setWakeOnLaunch(on) {
    memory.setSetting('wakeOnLaunch', !!on);
    log(`[state] launches ${on ? 'awake' : 'paused'} from now on`);
    return { wakeOnLaunch: !!on };
  }
  ipcMain.handle('fren:setWakeOnLaunch', (_e, on) => setWakeOnLaunch(on));

  ipcMain.handle('fren:getProfile', () => memory.getSetting('profile'));

  /**
   * The one switch that decides whether fren may interrupt you.
   *
   * Set from the setup interview, and changeable afterwards by saying so
   * ("stop interrupting me") — because an answer given once to a question you
   * barely remember is not consent you can withdraw, and this is the setting
   * people will want to withdraw. Merged rather than replaced, so flipping it
   * cannot lose the rest of the profile.
   */
  function setVolunteer(on) {
    const current = memory.getSetting('profile');
    if (!current || typeof current !== 'object') return { volunteer: false };
    const next = { ...current, volunteer: !!on };
    memory.setSetting('profile', next);
    log(`[setup] interruptions ${next.volunteer ? 'allowed' : 'turned off'}`);
    return { volunteer: next.volunteer };
  }
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

  ipcMain.handle('fren:openDataFolder', async () => {
    const err = await shell.openPath(app.getPath('userData'));
    return { ok: !err, error: err || null };
  });

  /**
   * Look at the screen, once, because the user pressed the button.
   *
   * There is no standing permission here on purpose. Every capture is a
   * separate deliberate act, the image is held in memory for the length of one
   * request, and it is never written to disk. It is the only picture of the
   * screen fren takes: the observer no longer keeps any.
   *
   * It also refuses while paused. Looking at the screen with the light off
   * would be exactly the thing the light exists to rule out.
   */
  ipcMain.handle('fren:lookAtScreen', async (_e, text) => {
    if (!state.get().observing) {
      return { error: "I'm paused — my light is off, so I'm not looking at anything." };
    }
    const question = String(text ?? '').trim().slice(0, 800) || 'What am I looking at?';
    state.beginReply();
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
      state.endReply();
    }
  });

  // Speaking with the panel shut only works if anything comes out of the
  // speakers. Unknown counts as audible: opening a panel nobody needed is a
  // smaller sin than opening one over someone's work every time fren talks.
  ipcMain.handle('fren:audioSilenced', () => audioOutput.isSilenced());

  ipcMain.handle('fren:dismissSuggestion', (_e, id) => {
    memory.setSuggestionStatus(Number(id), 'dismissed');
    return true;
  });

  /**
   * Write one line of the conversation down.
   *
   * Everything persisted goes through here, so "what is stored" is one function
   * rather than a grep — and a failure to write never fails the conversation
   * itself.
   */
  function remember(role, text) {
    try {
      memory.addMessage({ role, text });
    } catch (err) {
      log(`[chat] could not write the transcript: ${err.message}`);
    }
  }

  ipcMain.handle('fren:messages', () => {
    try { return memory.getMessages({ limit: 300 }); } catch { return []; }
  });

  ipcMain.handle('fren:clearMessages', () => {
    try {
      const n = memory.clearMessages();
      log(`[chat] transcript cleared (${n} messages)`);
      return { cleared: n };
    } catch (err) {
      return { cleared: 0, error: err.message };
    }
  });

  // ---- routines ----------------------------------------------------------
  function listRoutines() {
    try {
      return memory.getRoutines().map((r) => ({ ...r, nextRun: nextRunAt(r) }));
    } catch { return []; }
  }

  /**
   * fren's own business: what the owner told fren to do about itself, already
   * recognised from their own words by the chat window (renderer/own-business.js)
   * — never from anything a model wrote. Every deed is one of the functions the
   * handlers around here run; this only hands them over. See main/own-business.js.
   *
   * `heard` is the owner's sentence when there was one, '' for a chip, and
   * absent for the chat window's own housekeeping (redrawing a card), which
   * is not conversation and is not written down.
   */
  const ownBusiness = createOwnBusiness({
    watching: () => state.get().observing,
    setWatching: (on) => (on ? startObserving() : stopObserving()),
    routines: listRoutines,
    automations: async () => (await gateway.agentAutomations()).automations,
    browser: () => ({
      exclusions: safeParse(memory.getSetting('browserExclusions'), []),
      awareness: memory.getSetting('browserAwareness') !== 'off',
      readPage: memory.getSetting('browserReadPage') !== 'off',
      readSelection: memory.getSetting('browserReadSelection') !== 'off',
    }),
    setBrowser: applyBrowserSettings,
    currentDomain: () => { const b = currentBrowserContext(); return (b && b.tab && b.tab.domain) || ''; },
    setColour: setOrbColour,
    setWakeOnLaunch,
    setVolunteer,
    remember: (note) => rememberNote(note, 'chat'),
    facts: () => soul.readFacts(userDataDir()),
    forgetFact: (fact) => soul.forgetFact(userDataDir(), fact),
    patterns: () => { try { return memory.getSuggestions(); } catch { return []; } },
  });
  ipcMain.handle('fren:ownBusiness', async (_e, verb, args, heard) => {
    const spoken = typeof heard === 'string';
    if (spoken && heard.trim()) {
      lastChatAt = Date.now();
      remember('you', heard.trim().slice(0, 2000));
    }
    const res = await ownBusiness.apply(String(verb || ''), args);
    if (spoken && res.say) remember('fren', res.say);
    if (spoken) log(`[own] ${String(verb || '').slice(0, 24)}`);  // PRIVACY: which deed, never the words
    return res;
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

  // The chat's red light. It asks: quitting stops fren watching and forgets
  // nothing, but it is still the kind of decision a 12px dot should not make
  // on a slipped click.
  ipcMain.handle('fren:quit', () => {
    const response = dialog.showMessageBoxSync(win, {
      type: 'question',
      buttons: ['Quit fren', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: 'Quit fren?',
      detail: 'fren stops watching and everything closes. What it remembers is kept.',
    });
    if (response === 0) app.quit();
  });

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
      browser: currentBrowserContext(),
    });
    return reply;
  }

  ipcMain.handle('fren:chat', async (_e, text) => {
    const question = String(text ?? '').trim().slice(0, 2000);
    if (!question) return { reply: '…' };
    lastChatAt = Date.now();
    // BEFORE the model is asked, not after. What you said happened whether or
    // not the gateway answers, and both writes used to sit past the await — so
    // an outage threw to the catch and silently dropped the question from the
    // transcript, which is the one failure a transcript exists to prevent.
    remember('you', question);
    state.beginReply();
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
        // What is on screen in the browser right now, normalized by the
        // sensor. The agent consumes fren context, never the extension wire.
        browser: currentBrowserContext(),
      });
      remember('fren', reply);
      return { reply };
    } catch (err) {
      log(`[chat] failed: ${err.message}`);
      return {
        reply:
          "I can't reach my thinking half (the local gateway). Is it running? Try: npm run gateway",
      };
    } finally {
      state.endReply();
    }
  });
});

// NOT app.quit(). The orb window is the app: it is frameless with no close
// button, so "all windows closed" can only mean the orb is being rebuilt —
// quitting there would take fren down with it. Quitting is decided in two
// places and nowhere else: the chat's red light (fren:quit, which asks) and
// the system's own Quit (Cmd+Q, the Dock), which both arrive at before-quit.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') return;      // and even then, stay up
});

app.on('before-quit', () => {
  // No window here may veto a quit with a close handler of its own: by the
  // time one could ask, the timers below are stopped and the database is
  // closed, and "Cancel" would leave fren running on nothing.
  stopGateway();                                  // only if we started it
  if (gazeTimer) clearInterval(gazeTimer);
  if (drag) clearInterval(drag.timer);
  if (observer) observer.stop();
  if (summarizer) summarizer.stop();
  if (heartbeat) clearInterval(heartbeat);
  if (patterns) patterns.stop();
  if (curiosity) curiosity.stop();
  if (routines) routines.stop();
  if (coreEvents) coreEvents.close();
  if (memory) memory.close();
});
