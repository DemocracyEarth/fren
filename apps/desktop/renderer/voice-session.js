'use strict';
/**
 * Conversation mode: fren on a live line.
 *
 * Hold the orb and it opens a session with fren's voice agent (ElevenLabs
 * Agents — docs/voice-agent.md): the agent does the ears, the mouth and the
 * turn-taking, so you can talk over it; fren stays the mind by filling the
 * agent's prompt at the start and answering its questions through the three
 * client tools here, each of which goes to main, where the memory and the
 * senses live. What comes back is spoken by the agent and lands in the chat as
 * ordinary bubbles, and the orb's mouth follows the agent's actual audio.
 *
 * A session only ever starts on purpose and always ends itself: on silence,
 * on a hard cap, on a click, or when the agent decides the conversation is
 * over. Audio leaves the machine only for the length of the session.
 */
const SILENCE_END_MS = 25_000;      // nobody said anything for this long: hang up
const MAX_SESSION_MS = 20 * 60_000; // and never run longer than this, whatever happens

export function createVoiceSession({ getFace, addBubble, setFace, heard = null, log = () => {}, onChange = () => {} } = {}) {
  let conv = null;
  let mode = 'listening';
  let startedAt = 0;
  let lastActivityAt = 0;
  let raf = null;
  let tick = null;
  let ending = false;

  const face = () => getFace();
  const asText = (v) => { const s = String(v || '').trim(); return s || 'Nothing available.'; };

  // The agent's three questions, answered in main. Return strings: that is
  // what the agent hears back.
  const clientTools = {
    look_around: async (p = {}) => asText(await window.fren.voice.lookAround(String(p.focus || ''))),
    recall: async (p = {}) => asText(await window.fren.voice.recall(String(p.question || ''))),
    remember: async (p = {}) => {
      const r = await window.fren.voice.remember(String(p.note || ''));
      return r && r.kept ? 'Kept.' : 'Noted, but not kept.';
    },
  };

  function stopLoops() {
    if (raf !== null) cancelAnimationFrame(raf);
    raf = null;
    if (tick) clearInterval(tick);
    tick = null;
  }

  function settle() {
    const f = face();
    if (f) {
      if (f.stopTalking) f.stopTalking();
      if (f.setSpeechLevel) f.setSpeechLevel(null);
      if (f.setAttending) f.setAttending(null);
    }
    document.body.dataset.voice = '0';
    if (window.fren.voice.state) window.fren.voice.state(false).catch(() => {});
    onChange(false);
  }

  /**
   * The mouth follows the agent's audio; the colour follows yours. While fren
   * listens the orb breathes from its own colour out to lime, further as you speak (setAttending —
   * the conversation's own state, not the local recording's red); while it
   * talks it turns back to its own colour, so the turn-taking is visible.
   */
  function loop() {
    if (!conv) return;
    const f = face();
    try {
      if (mode === 'speaking') {
        if (f && f.setSpeechLevel) f.setSpeechLevel(Math.min(1, conv.getOutputVolume() * 1.6));
      } else {
        const level = conv.getInputVolume();
        if (f && f.setAttending) f.setAttending(level);
        if (level > 0.08) lastActivityAt = Date.now();
      }
    } catch { /* a closing session has no meters */ }
    raf = requestAnimationFrame(loop);
  }

  async function start() {
    if (conv || ending) return true;
    if (!window.ElevenLabsClient || !window.ElevenLabsClient.Conversation) {
      log('[voice] client not loaded');
      return false;
    }
    const ticket = await window.fren.voice.session();
    if (!ticket || ticket.error || !ticket.signedUrl) {
      log(`[voice] no line: ${(ticket && ticket.error) || 'no ticket'}`);
      if (ticket && ticket.error && /not set/.test(ticket.error)) addBubble('fren', ticket.error);
      return false;
    }
    document.body.dataset.voice = '1';
    setFace('listening');
    onChange(true);
    try {
      conv = await window.ElevenLabsClient.Conversation.startSession({
        signedUrl: ticket.signedUrl,
        connectionType: 'websocket',
        dynamicVariables: ticket.dynamicVariables || {},
        clientTools,
        onConnect: () => { log('[voice] connected'); },
        onDisconnect: () => {
          // The agent hung up (end_call), or the line dropped. Either way, done.
          if (!conv) return;
          conv = null;
          stopLoops();
          settle();
          log('[voice] session ended (line closed)');
        },
        onError: (message) => { log(`[voice] ${String(message).slice(0, 160)}`); },
        onMessage: ({ message, source }) => {
          const text = String(message || '').trim();
          if (!text) return;
          lastActivityAt = Date.now();
          const role = source === 'user' ? 'user' : 'fren';
          addBubble(role, text);
          window.fren.voice.said(role, text).catch(() => {});
          // The agent cannot change fren. "Stop watching", said on the line, is
          // done by the chat window (which obeys only what makes fren see or
          // say less), and the agent is told what happened so it can say so.
          if (role === 'user' && heard) {
            Promise.resolve(heard(text)).then((done) => {
              if (done && conv && conv.sendContextualUpdate) conv.sendContextualUpdate(`fren has just done what they asked. Tell them so, briefly: ${done}`);
            }).catch(() => {});
          }
        },
        onModeChange: ({ mode: m }) => {
          mode = m;
          const f = face();
          if (m === 'speaking') {
            lastActivityAt = Date.now();
            if (f && f.setAttending) f.setAttending(null);   // its turn: back to its own colour
            if (f && f.startTalking) f.startTalking();
            setFace('talking');
          } else {
            if (f && f.stopTalking) f.stopTalking();
            if (f && f.setSpeechLevel) f.setSpeechLevel(null);
            setFace('listening');
          }
        },
      });
    } catch (err) {
      conv = null;
      settle();
      log(`[voice] could not start: ${(err && err.message) || err}`);
      return false;
    }
    startedAt = lastActivityAt = Date.now();
    if (window.fren.voice.state) window.fren.voice.state(true).catch(() => {});   // the wake word stands down
    raf = requestAnimationFrame(loop);
    tick = setInterval(() => {
      const now = Date.now();
      if (now - lastActivityAt > SILENCE_END_MS) end('silence');
      else if (now - startedAt > MAX_SESSION_MS) end('time cap');
    }, 1000);
    log('[voice] session started');
    return true;
  }

  async function end(reason = 'click') {
    if (!conv || ending) return;
    ending = true;
    const c = conv;
    conv = null;
    stopLoops();
    try { await c.endSession(); } catch { /* already gone */ }
    settle();
    ending = false;
    log(`[voice] session ended (${reason})`);
  }

  return { start, end, active: () => !!conv };
}
