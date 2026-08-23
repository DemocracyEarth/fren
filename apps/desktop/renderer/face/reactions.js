'use strict';
/**
 * fren's temperament.
 *
 * The same nudge should not always get the same face. This picks reactions
 * stochastically, from pools that shift with an energy level that rises when
 * you interact and decays when you leave it alone — so fren has moods, warms
 * up when you play with it, and goes quiet when ignored.
 *
 * Pure logic, no DOM: the randomness is injectable so it can be tested.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FrenReactions = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  // [emotion, weight]. Pools overlap deliberately — the boundaries between
  // moods should be soft, not a gear change.
  const POOLS = {
    hover: {
      bright: [['playful', 3], ['excited', 3], ['cheeky', 3], ['happy', 2], ['joyful', 2], ['surprised', 1], ['blushing', 1]],
      neutral: [['curious', 4], ['happy', 3], ['playful', 2], ['content', 2], ['hopeful', 2], ['surprised', 1], ['shy', 1]],
      low: [['curious', 3], ['content', 3], ['calm', 2], ['hopeful', 1], ['tired', 1], ['shy', 1]],
    },
    click: {
      bright: [['excited', 3], ['joyful', 3], ['laughing', 2], ['playful', 2], ['overjoyed', 1]],
      neutral: [['happy', 4], ['joyful', 2], ['playful', 2], ['curious', 2], ['proud', 1]],
      low: [['content', 3], ['happy', 2], ['calm', 2], ['hopeful', 1]],
    },
    // After answering a question.
    reply: {
      bright: [['joyful', 3], ['proud', 2], ['happy', 3], ['playful', 1], ['excited', 1]],
      neutral: [['happy', 4], ['content', 3], ['proud', 2], ['hopeful', 1]],
      low: [['content', 3], ['calm', 3], ['happy', 1]],
    },
    // Unprompted flickers while nobody is doing anything.
    idle: {
      bright: [['hopeful', 2], ['playful', 2], ['content', 2], ['curious', 1]],
      neutral: [['content', 3], ['curious', 2], ['calm', 2], ['thinking', 1], ['hopeful', 1]],
      low: [['calm', 3], ['tired', 2], ['resting', 2], ['content', 1], ['peaceful', 1]],
    },
  };

  const HOLD = {          // how long the reaction lingers, in ms
    hover: [900, 2200],
    click: [700, 1500],
    reply: [800, 1800],
    idle: [1200, 2600],
  };

  function createReactions(opts = {}) {
    const random = opts.random || Math.random;
    let energy = opts.energy === undefined ? 0.45 : opts.energy;
    let last = null;            // avoid repeating the previous face
    let streak = 0;             // rapid repeat interactions build excitement
    let lastPokeAt = -Infinity;

    const moodOf = (e) => (e > 0.68 ? 'bright' : e < 0.3 ? 'low' : 'neutral');

    /** Weighted choice that never returns `avoid` unless there's no option. */
    function choose(pool, avoid) {
      const usable = pool.filter(([name]) => name !== avoid);
      const list = usable.length ? usable : pool;
      const total = list.reduce((sum, [, w]) => sum + w, 0);
      let r = random() * total;
      for (const [name, w] of list) {
        r -= w;
        if (r <= 0) return name;
      }
      return list[list.length - 1][0];
    }

    return {
      /**
       * Pick a reaction for a trigger.
       * @returns {{emotion: string, hold: number}}
       */
      pick(trigger, nowMs) {
        const now = nowMs === undefined ? Date.now() : nowMs;
        const pools = POOLS[trigger] || POOLS.idle;

        if (trigger === 'hover' || trigger === 'click') {
          // Poking it repeatedly winds it up.
          streak = now - lastPokeAt < 4000 ? Math.min(streak + 1, 5) : 0;
          lastPokeAt = now;
          energy = Math.min(1, energy + 0.07 + streak * 0.03);
        }

        const mood = moodOf(Math.min(1, energy + streak * 0.06));
        const emotion = choose(pools[mood], last);
        last = emotion;

        const [lo, hi] = HOLD[trigger] || HOLD.idle;
        return { emotion, hold: Math.round(lo + random() * (hi - lo)) };
      },

      /** Feed in something that happened; shifts the mood. */
      note(event) {
        if (event === 'chat') energy = Math.min(1, energy + 0.2);
        else if (event === 'idea') energy = Math.min(1, energy + 0.3);
        else if (event === 'error') energy = Math.max(0, energy - 0.15);
        else if (event === 'wake') energy = Math.min(1, energy + 0.12);
      },

      /** Energy bleeds away when nothing is happening. */
      decay(dtMs) {
        energy = Math.max(0, energy - (dtMs / 1000) * 0.012);
        if (Date.now() - lastPokeAt > 6000) streak = 0;
      },

      mood() { return moodOf(energy); },
      energy() { return energy; },
    };
  }

  return { createReactions, POOLS };
});
