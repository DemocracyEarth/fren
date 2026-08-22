'use strict';
/**
 * Which application is in front, and what its window is called — on macOS,
 * Windows and Linux.
 *
 * There is no portable way to ask this, so each platform gets its own answer
 * and they all degrade the same way: the app name is best-effort and returns
 * "unknown" rather than throwing, while the window title THROWS when it cannot
 * be read. The caller relies on that distinction to tell "no title" apart from
 * "not permitted", and to back off instead of pestering the user.
 *
 * Everything here shells out to programs already on the system. Nothing is
 * bundled, nothing is downloaded, and nothing touches the network.
 */
const { execFile } = require('node:child_process');

const APP_TIMEOUT_MS = 1000;
const TITLE_TIMEOUT_MS = 1500;

function run(cmd, args, timeout) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, windowsHide: true }, (err, stdout) => {
      if (err) reject(err);
      else resolve(String(stdout));
    });
  });
}

// ---------------------------------------------------------------- macOS ----
// lsappinfo needs no permissions. The title comes from System Events, which
// requires Accessibility — hence the throw-on-failure contract.
const MAC_TITLE_SCRIPT =
  'tell application "System Events" to get title of front window of ' +
  '(first application process whose frontmost is true)';

const darwin = {
  async app() {
    try {
      const asn = (await run('/usr/bin/lsappinfo', ['front'], APP_TIMEOUT_MS)).trim();
      if (!asn) return 'unknown';
      const out = await run('/usr/bin/lsappinfo', ['info', '-only', 'name', asn], APP_TIMEOUT_MS);
      // lsappinfo answers with `"LSDisplayName"="Safari"`, NOT `"name"=...`.
      // Matching only the latter is why every observation fren ever recorded
      // had activeApp "unknown": the lookup succeeded and the parse silently
      // dropped the answer.
      const m = out.match(/"(?:LSDisplayName|name)"\s*=\s*"([^"]+)"/);
      return m ? m[1] : 'unknown';
    } catch {
      return 'unknown';
    }
  },
  async title() {
    return (await run('/usr/bin/osascript', ['-e', MAC_TITLE_SCRIPT], TITLE_TIMEOUT_MS)).trim();
  },
  permissionHint: 'Grant Accessibility to this app in System Settings > Privacy & Security',
};

// -------------------------------------------------------------- Windows ----
// One PowerShell call gets both, because starting PowerShell twice a tick would
// cost more than everything else fren does put together. Windows needs no
// special permission for this, so a failure here is a real failure.
const WIN_SCRIPT = `
$ErrorActionPreference='Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class FrenWin {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
}
"@
$h = [FrenWin]::GetForegroundWindow()
$sb = New-Object System.Text.StringBuilder 1024
[void][FrenWin]::GetWindowTextW($h, $sb, $sb.Capacity)
$procId = 0
[void][FrenWin]::GetWindowThreadProcessId($h, [ref]$procId)
$name = 'unknown'
try { $name = (Get-Process -Id $procId).ProcessName } catch {}
Write-Output ("{0}\`t{1}" -f $name, $sb.ToString())
`;

let winCache = { at: 0, app: 'unknown', title: '' };

async function winSample() {
  // Both values come from one call; cache briefly so app() and title() in the
  // same tick do not start PowerShell twice.
  if (Date.now() - winCache.at < 400) return winCache;
  const out = await run(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WIN_SCRIPT],
    TITLE_TIMEOUT_MS
  );
  const [app, ...rest] = out.trim().split('\t');
  winCache = { at: Date.now(), app: (app || 'unknown').trim(), title: rest.join('\t').trim() };
  return winCache;
}

const win32 = {
  async app() {
    try { return (await winSample()).app || 'unknown'; } catch { return 'unknown'; }
  },
  async title() {
    return (await winSample()).title;
  },
  permissionHint: 'No permission is needed for window titles on Windows',
};

// ---------------------------------------------------------------- Linux ----
// X11 only. Under Wayland there is no portable way for an unprivileged process
// to read the focused window, which is a deliberate design of the protocol
// rather than an oversight — so fren degrades to app names and says so.
const linux = {
  async app() {
    try {
      const id = (await run('xdotool', ['getactivewindow'], APP_TIMEOUT_MS)).trim();
      const cls = await run('xprop', ['-id', id, 'WM_CLASS'], APP_TIMEOUT_MS);
      // WM_CLASS(STRING) = "code", "Code"  -> prefer the second, prettier name
      const names = [...cls.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
      return names[names.length - 1] || 'unknown';
    } catch {
      return 'unknown';
    }
  },
  async title() {
    const id = (await run('xdotool', ['getactivewindow'], APP_TIMEOUT_MS)).trim();
    return (await run('xdotool', ['getwindowname', id], TITLE_TIMEOUT_MS)).trim();
  },
  permissionHint:
    'Install xdotool and xprop. On Wayland the focused window cannot be read by ' +
    'an unprivileged process, so only application names are available',
};

const IMPLS = { darwin, win32, linux };

/** The unsupported case behaves like a platform where everything is denied. */
const unsupported = {
  async app() { return 'unknown'; },
  async title() { throw new Error(`window titles are not supported on ${process.platform}`); },
  permissionHint: `${process.platform} is not supported; fren will record nothing`,
};

function implFor(platform = process.platform) {
  return IMPLS[platform] || unsupported;
}

/**
 * Sample the front window. `titleFailed` lets the caller distinguish "this
 * window has no title" from "the title could not be read", which is what drives
 * the permission back-off.
 */
async function getActiveWindowInfo({ skipTitle = false, platform = process.platform } = {}) {
  const impl = implFor(platform);
  const activeApp = await impl.app();
  if (skipTitle) return { activeApp, windowTitle: undefined, titleFailed: false };
  try {
    const title = await impl.title();
    return { activeApp, windowTitle: title || undefined, titleFailed: false };
  } catch {
    return { activeApp, windowTitle: undefined, titleFailed: true };
  }
}

const permissionHint = (platform = process.platform) => implFor(platform).permissionHint;
const isSupported = (platform = process.platform) => Object.hasOwn(IMPLS, platform);

module.exports = { getActiveWindowInfo, implFor, permissionHint, isSupported };
