'use strict';
/**
 * Can the person actually HEAR fren right now?
 *
 * fren answers out loud and keeps the chat panel shut, which is the right
 * default — until the machine is muted, at which point a closed panel and a
 * silent orb is nothing at all. So before speaking it asks the system whether
 * anything would come out.
 *
 * There is no portable way to ask, so each platform gets its own answer and an
 * unknown result means ASSUME AUDIBLE. Being wrong in that direction shows a
 * panel nobody needed; being wrong the other way opens a panel over someone's
 * work every time fren speaks, which is far more annoying than the problem it
 * solves.
 */
const { execFile } = require('node:child_process');

const TIMEOUT_MS = 900;

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: TIMEOUT_MS, windowsHide: true }, (err, stdout) => {
      if (err) reject(err);
      else resolve(String(stdout).trim());
    });
  });
}

const readers = {
  async darwin() {
    // `output muted of (get volume settings)` -> "true" / "false"
    const out = await run('/usr/bin/osascript', [
      '-e', 'set v to (get volume settings)',
      '-e', 'return (output muted of v as text) & "," & (output volume of v as text)',
    ]);
    const [muted, volume] = out.split(',');
    return { muted: muted.trim() === 'true', volume: Number(volume) };
  },

  async win32() {
    // No shell-level mute query without extra tooling, so read the endpoint
    // through the audio API surface Windows exposes to scripting.
    const script = `
      $ErrorActionPreference='Stop'
      Add-Type -TypeDefinition @"
      using System.Runtime.InteropServices;
      [Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
      interface IAudioEndpointVolume {
        int f(); int g(); int h(); int i();
        int SetMasterVolumeLevelScalar(float a, System.Guid b);
        int j(); int GetMasterVolumeLevelScalar(out float a);
        int k(); int l(); int m(); int n();
        int SetMute([MarshalAs(UnmanagedType.Bool)] bool a, System.Guid b);
        int GetMute(out bool a);
      }
      [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
      interface IMMDevice { int Activate(ref System.Guid id, int ctx, int act, out IAudioEndpointVolume o); }
      [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
      interface IMMDeviceEnumerator { int f(); int GetDefaultAudioEndpoint(int flow, int role, out IMMDevice ep); }
      [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorComObject { }
      public class Audio {
        public static bool Muted() {
          IMMDeviceEnumerator e = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
          IMMDevice dev; e.GetDefaultAudioEndpoint(0, 1, out dev);
          System.Guid g = typeof(IAudioEndpointVolume).GUID;
          IAudioEndpointVolume v; dev.Activate(ref g, 23, 0, out v);
          bool m; v.GetMute(out m); return m;
        }
        public static float Level() {
          IMMDeviceEnumerator e = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
          IMMDevice dev; e.GetDefaultAudioEndpoint(0, 1, out dev);
          System.Guid g = typeof(IAudioEndpointVolume).GUID;
          IAudioEndpointVolume v; dev.Activate(ref g, 23, 0, out v);
          float l; v.GetMasterVolumeLevelScalar(out l); return l;
        }
      }
"@
      Write-Output ("{0},{1}" -f [Audio]::Muted(), [int]([Audio]::Level() * 100))
    `;
    const out = await run('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script]);
    const [muted, volume] = out.split(',');
    return { muted: /true/i.test(muted), volume: Number(volume) };
  },

  async linux() {
    // pactl is present on anything running PipeWire or PulseAudio, which is
    // most desktops. Anything else falls through to "unknown".
    const out = await run('pactl', ['get-sink-mute', '@DEFAULT_SINK@']);
    const muted = /yes/i.test(out);
    let volume = 100;
    try {
      const v = await run('pactl', ['get-sink-volume', '@DEFAULT_SINK@']);
      const m = v.match(/(\d+)%/);
      if (m) volume = Number(m[1]);
    } catch { /* mute alone is enough */ }
    return { muted, volume };
  },
};

/**
 * @returns {Promise<{muted: boolean, volume: number}|null>} null when the
 * platform cannot be asked — treat that as audible.
 */
async function outputState(platform = process.platform) {
  const read = readers[platform];
  if (!read) return null;
  try {
    const state = await read();
    if (typeof state.muted !== 'boolean') return null;
    return { muted: state.muted, volume: Number.isFinite(state.volume) ? state.volume : 100 };
  } catch {
    return null;
  }
}

/** True only when we KNOW nothing would be heard. Unknown means audible. */
async function isSilenced(platform = process.platform) {
  const state = await outputState(platform);
  if (!state) return false;
  return state.muted || state.volume <= 0;
}

module.exports = { outputState, isSilenced, readers };
