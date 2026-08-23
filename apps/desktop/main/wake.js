'use strict';
/**
 * Whether fren is awake — and therefore capturing — when it launches.
 *
 * Its own module, and a pure function, because this is the one default in the
 * app that decides whether observation starts before anyone has interacted with
 * it. That deserves to be readable in one place and testable without booting
 * Electron.
 *
 * Absent means awake. That is the owner's chosen default and it applies to
 * anyone who completed setup before the question was asked. Note this is NOT a
 * fail-open default in the state store: `state.js` still initialises
 * `observing: false`, and the boot path has to decide, explicitly and out loud,
 * to wake. The lit-⇔-capturing invariant is untouched.
 *
 * Stored as its own top-level setting rather than a field on `profile`, because
 * `fren:setProfile` rewrites that blob wholesale — a re-run of setup would
 * silently reset a capture preference the user had set deliberately.
 */
function wakeOnLaunchFrom(setting) {
  if (setting === null || setting === undefined || setting === '') return true;
  return setting !== false && setting !== 0 && setting !== 'false';
}

module.exports = { wakeOnLaunchFrom };
