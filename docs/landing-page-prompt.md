# Prompt: build the fren landing page

Hand this to a capable model with web tooling. It is written to be pasted whole.

---

## The brief

Build a single-page marketing site for **fren** — an open-source ambient AI
companion that lives on your desktop, watches what you do while its light is on,
and eventually notices the work you keep repeating.

Ship one self-contained `index.html` (inline CSS, inline JS, no build step, no
external dependencies except Google Fonts). It must be genuinely responsive,
respect `prefers-reduced-motion`, respect `prefers-color-scheme`, and score well
on Lighthouse without special pleading.

Repository: https://github.com/DemocracyEarth/fren — MIT, by Democracy Earth
Foundation.

## The one thing to get right

**The hero must be the orb, alive, and the visitor must be able to poke it.**

fren is a character. A screenshot of a character is a dead thing; the character
itself is the product demo. So the hero is a live WebGL sphere — the same one the
app ships — that follows the cursor, blinks, squashes when clicked, and cycles
slowly through expressions. Everything else on the page is subordinate to that.

If the interactive orb cannot be built well, build a looping video of it rather
than a still. Never a still.

The orb, precisely:

- A perfect sphere, glossy plastic, base colour `#FF8A00`. Ramp: highlight
  `#FFD08A`, light `#FFB14A`, base `#FF8A00`, shade `#E17200`, deep `#CC5A00`.
- Face: two **white circles** for eyes and one **small** mouth. No pupils, ever.
  Expression comes only from mouth shape, eye closure, and how the body deforms.
- The eyes and mouth are **light coming out of the sphere**, not paint on it —
  a blown-out white core falling off through amber into the orange around it.
- The mouth stays small relative to the eyes. That ratio is what makes it read
  as an assistant rather than a cartoon. Wide eyes plus a wide open mouth reads
  as stoned, not delighted.
- Eyes are always **symmetric**. An uneven pair reads as a smirk.
- A soft shadow hugging the silhouette, so it floats above the page.
- Mood shifts the body colour within one palette anchored on the orange:
  warmer and glossier when up, cooled when down, drained to neutral grey when
  asleep.

## Voice and tone

Plain, specific, unhurried, faintly warm. Short sentences. No exclamation marks,
no emoji, no "revolutionise", no "supercharge", no "AI-powered". Never call it
magic. It is a small program that watches a timeline of window titles.

Write like the product: it says what it actually noticed rather than what sounds
useful, and it would rather say "I don't know" than fill the silence.

Concretely — write `fren notices the work you keep redoing`, not
`Unlock your productivity with AI-powered workflow intelligence`.

## What the page must say

**Above the fold**

- The live orb.
- A one-line statement of what it is. Something in the register of
  "A small companion that lives on your desktop and notices the work you repeat."
- One sentence of substance underneath.
- Two buttons: `Get fren` (GitHub) and `See how it works` (scrolls down).
- One quiet line: *Open source. MIT. Runs on your machine.*

**The privacy section — give this real weight, above features**

This is the product's actual differentiator and it must not be a footnote.

- **The light is the truth.** When fren is lit it is watching. When it is dark
  it is not. That is one boolean in the main process, and every visual change is
  funnelled through a check on it — so it cannot look awake while paused, and it
  cannot capture while looking asleep.
- **Screenshots never leave the machine.** They are written locally, capped, and
  pruned. The model only ever sees text.
- **The microphone is only open between the click that starts it and the one
  that stops it, and a ring pulses the whole time it is open.** Not a wake word. Not
  always-on. Speech is transcribed by whisper.cpp on your own machine; the audio
  never leaves it.
- **Keystrokes are never captured at all.** There is no keylogger.
- **Your API key lives in a local gateway process**, never in the desktop app —
  the process that watches your screen never holds credentials.

Consider making this section interactive: a toggle that turns the orb dark and
lit, showing the two states, with the text changing to match. It demonstrates the
invariant instead of asserting it.

**How it works**

`OBSERVE → UNDERSTAND → REMEMBER → NOTICE → SUGGEST`

Four or five steps, one line each. Say plainly that it samples the active app and
window title, summarises them every couple of minutes, and looks across hours of
those summaries for a sequence you repeat. Do not overstate: it notices and
suggests, it does not act for you.

**It has a soul file**

A genuinely unusual thing worth a section. On first run fren interviews you — not
just your name, but how it should talk to you and whether it should speak up or
stay quiet. Those answers are written to `SOUL.md`, plain Markdown in your data
folder, as instructions it is told to follow. You can open that file, rewrite it,
and it takes effect on your next message.

Show a real excerpt of `SOUL.md` in a code block. That file *is* the pitch.

**Honest status**

Say where it actually is: a working proof of concept, v0.1, macOS/Windows/Linux,
requires your own API key. Do not imply a polished product or a waitlist.

Being straight here is on-brand and will read as more credible than the usual
launch copy.

## Design direction

- **Warm, quiet, generous whitespace.** Cream/paper background (`#F2EDE4`-ish) in
  light mode, near-black (`#0B0B0D`) in dark. The orange is the only saturated
  colour on the page — spend it carefully.
- **Type:** one geometric or rounded sans (Google Fonts). Large, confident hero
  type; comfortable body size (17–19px); generous line height.
- **Motion:** slow and few. Gentle fades on scroll, nothing bouncing or sliding
  in from the sides. All of it off under `prefers-reduced-motion`.
- Feel closer to a good hardware product page than a SaaS template. No gradient
  meshes, no glassmorphism, no floating UI screenshots at an angle, no logo
  cloud, no fake testimonials, no countdown.

## Hard requirements

1. One file, no build step, no framework. Three.js by CDN is acceptable for the
   orb; if it fails to load, fall back gracefully rather than leaving a hole.
2. Responsive from 320px up. The orb scales and stays interactive on touch.
3. Accessible: real landmarks, sensible heading order, visible focus states,
   AA contrast, the orb marked decorative for screen readers with the meaning
   carried in text.
4. `prefers-reduced-motion` genuinely honoured — the orb settles to a still
   pose rather than looping.
5. Fast: no blocking requests, fonts preconnected, no layout shift.
6. Open Graph and Twitter card tags, and a favicon.
7. No analytics, no cookie banner, no third-party scripts. A privacy-first
   product with a tracking pixel is an argument against itself.

## Before you finish

Look at the rendered page and judge it. Then check specifically:

- Is the orb the first thing the eye lands on, and does poking it feel good?
- Does the mouth read as small next to the eyes, at every viewport width?
- Does any sentence sound like marketing rather than like the product?
- Does the privacy section demonstrate the claim or merely assert it?
- Does it hold up at 320px, and in dark mode, and with motion reduced?

Fix what fails before showing it.
