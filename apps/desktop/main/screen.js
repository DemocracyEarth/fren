'use strict';
/**
 * One screenshot, taken because the user just asked for one.
 *
 * Deliberately separate from observer.js, which captures on a timer and writes
 * JPEGs to disk that never leave the machine. This is the opposite kind of
 * capture and the difference is the whole point:
 *
 *   observer.js   periodic, automatic, written to disk, NEVER transmitted
 *   screen.js     one frame, on an explicit press, transmitted once,
 *                 never written to disk and not kept afterwards
 *
 * Keeping them in separate files is not tidiness. It means the promise that
 * observed screenshots never leave the machine stays true and checkable, with
 * no shared code path that could quietly start sending them.
 */
const { desktopCapturer, systemPreferences } = require('electron');

// Smaller than the observer's stored captures: enough to read a UI, not enough
// to be an expensive way to ask a question.
const MAX_WIDTH = 1280;
const JPEG_QUALITY = 72;

/**
 * Grab the current screen as base64 JPEG. Returns null when the OS has not
 * granted screen access, so the caller can say so rather than send nothing.
 */
async function captureOnce() {
  if (process.platform === 'darwin' &&
      systemPreferences.getMediaAccessStatus('screen') !== 'granted') {
    return { error: 'screen recording permission has not been granted' };
  }

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: MAX_WIDTH, height: Math.round(MAX_WIDTH * 0.72) },
  });
  const thumbnail = sources && sources[0] && sources[0].thumbnail;
  if (!thumbnail || thumbnail.isEmpty()) {
    return { error: 'the system returned an empty screen capture' };
  }

  // Straight to base64 in memory. Never written down.
  return {
    image: thumbnail.toJPEG(JPEG_QUALITY).toString('base64'),
    mediaType: 'image/jpeg',
  };
}

module.exports = { captureOnce, MAX_WIDTH };
