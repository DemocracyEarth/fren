'use strict';
/**
 * Text-to-speech via ElevenLabs. Like every provider it lives only in the
 * gateway, so the desktop app never holds the key.
 *
 * Note what crosses the network here: the reply TEXT fren is about to say.
 * Your microphone audio does not — that is transcribed locally by whisper.
 */
const DEFAULTS = {
  // Both are configurable because ElevenLabs revises model and voice IDs;
  // if one 404s, set the env var rather than editing code.
  model: 'eleven_flash_v2_5',
  voice: '21m00Tcm4TlvDq8ikWAM',
  baseUrl: 'https://api.elevenlabs.io',
};

function createElevenLabsProvider() {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error('ELEVENLABS_API_KEY is not set');
  const model = process.env.ELEVENLABS_MODEL || DEFAULTS.model;
  const voice = process.env.ELEVENLABS_VOICE_ID || DEFAULTS.voice;

  return {
    name: 'elevenlabs',
    model,
    voice,
    /** @returns {Promise<{audio: Buffer, contentType: string}>} */
    async speak(text, { timeoutMs = 30_000 } = {}) {
      const baseUrl = process.env.ELEVENLABS_BASE_URL || DEFAULTS.baseUrl;
      const res = await fetch(
        `${baseUrl}/v1/text-to-speech/${encodeURIComponent(voice)}/stream?optimize_streaming_latency=3`,
        {
          method: 'POST',
          headers: {
            'xi-api-key': apiKey,
            'content-type': 'application/json',
            accept: 'audio/mpeg',
          },
          body: JSON.stringify({
            text,
            model_id: model,
            voice_settings: { stability: 0.4, similarity_boost: 0.75 },
          }),
          signal: AbortSignal.timeout(timeoutMs),
        }
      );

      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`elevenlabs ${res.status}: ${detail.slice(0, 200)}`);
      }
      const audio = Buffer.from(await res.arrayBuffer());
      if (audio.length === 0) throw new Error('elevenlabs returned no audio');
      return { audio, contentType: res.headers.get('content-type') || 'audio/mpeg' };
    },
  };
}

module.exports = { createElevenLabsProvider, DEFAULTS };
