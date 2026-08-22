import * as THREE from '/vendor/three.module.js';
import { drawFace } from './face-texture.js';

/**
 * A 3D fren, to answer one question: does real geometry buy anything the
 * painted SVG can't fake?
 *
 * Three things here are impossible in the 2D version:
 *   1. The specular highlight MOVES as the orb turns. In SVG it is painted on
 *      and sits still no matter how the body leans.
 *   2. The face is an EMISSIVE MAP, so the eyes and mouth are literally light
 *      coming out of the material rather than white shapes drawn on top.
 *   3. Deformation happens per-vertex, so the surface bulges like something
 *      soft instead of being scaled like a sticker.
 */

// The reference ramp, unchanged: #FF8A00 base, #CC5A00 shade, #FFB14A light.
const BASE = 0xff8a00;

const canvas = document.getElementById('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(2, devicePixelRatio));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
// No filmic tone mapping: it desaturates #FF8A00 away from the brand ramp.
renderer.toneMapping = THREE.NoToneMapping;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(28, 1, 0.1, 100);
camera.position.set(0, 0, 8.4);

// A cheap studio environment: bright above, warm bounce below. This is what
// gives the clearcoat something to reflect.
function studioEnv() {
  const c = document.createElement('canvas');
  c.width = 32;
  c.height = 128;
  const g = c.getContext('2d').createLinearGradient(0, 0, 0, 128);
  g.addColorStop(0.0, '#ffffff');
  g.addColorStop(0.42, '#c9cfd8');
  g.addColorStop(0.62, '#4a4038');
  g.addColorStop(1.0, '#2a1d12');
  const ctx = c.getContext('2d');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 32, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
scene.environment = studioEnv();

// ---- the face, drawn to an equirectangular emissive map --------------------
const faceCanvas = document.createElement('canvas');   // the 200-unit face box
faceCanvas.width = faceCanvas.height = 1024;
const equirect = document.createElement('canvas');
equirect.width = 2048;
equirect.height = 1024;
const eqCtx = equirect.getContext('2d');

const faceTex = new THREE.CanvasTexture(equirect);
faceTex.colorSpace = THREE.SRGBColorSpace;
faceTex.wrapS = THREE.RepeatWrapping;
faceTex.offset.x = 0.25;     // bring the face round to the front

function paintFace(p) {
  drawFace(faceCanvas, p);
  // Black everywhere the face is not: no alpha, so no emission.
  eqCtx.fillStyle = '#000';
  eqCtx.fillRect(0, 0, equirect.width, equirect.height);
  // The face occupies roughly 60 deg across and 50 deg down, centred on the
  // equator — little enough that equirect stretch stays invisible.
  const w = equirect.width * (96 / 360);
  const h = equirect.height * (86 / 180);
  eqCtx.drawImage(faceCanvas, equirect.width / 2 - w / 2, equirect.height / 2 - h / 2, w, h);
  faceTex.needsUpdate = true;
}

// ---- the body --------------------------------------------------------------
const material = new THREE.MeshPhysicalMaterial({
  color: BASE,
  roughness: 0.34,
  metalness: 0,
  clearcoat: 1,
  clearcoatRoughness: 0.06,
  sheen: 0.4,
  sheenColor: new THREE.Color(0xffc06a),
  emissive: new THREE.Color(0xffffff),
  emissiveMap: faceTex,
  emissiveIntensity: 1.45,
});

// Jelly: displace vertices along their normals so the surface actually bulges.
const wobble = { time: { value: 0 }, amount: { value: 0 }, squash: { value: 0 } };
material.onBeforeCompile = (shader) => {
  shader.uniforms.uTime = wobble.time;
  shader.uniforms.uAmount = wobble.amount;
  shader.uniforms.uSquash = wobble.squash;
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>
      uniform float uTime; uniform float uAmount; uniform float uSquash;`)
    .replace('#include <begin_vertex>', `#include <begin_vertex>
      // Two travelling waves so the wobble never looks like a pulse.
      float w = sin(position.y * 4.2 + uTime * 9.0) * 0.6
              + sin(position.x * 3.1 - uTime * 7.3) * 0.4;
      transformed += normal * w * uAmount;
      transformed.xz *= 1.0 + uSquash;
      transformed.y  *= 1.0 - uSquash;`);
};

const LIT_HUE = new THREE.Color(BASE);
const DARK_HUE = new THREE.Color(0x46464a);

const orb = new THREE.Mesh(new THREE.SphereGeometry(1, 160, 160), material);
orb.castShadow = true;
scene.add(orb);

// ---- light -----------------------------------------------------------------
scene.add(new THREE.AmbientLight(0xffffff, 0.35));
const key = new THREE.DirectionalLight(0xfff1dc, 3.1);
key.position.set(-2.2, 4.2, 3.0);
key.castShadow = true;
key.shadow.mapSize.set(1024, 1024);
key.shadow.radius = 6;
key.shadow.camera.near = 1;
key.shadow.camera.far = 14;
scene.add(key);
const rim = new THREE.DirectionalLight(0xffb14a, 1.5);
rim.position.set(2.8, -1.4, -2.2);
scene.add(rim);

// A real cast shadow on a floor the orb hovers above.
const floor = new THREE.Mesh(new THREE.PlaneGeometry(24, 24), new THREE.ShadowMaterial({ opacity: 0.42 }));
floor.rotation.x = -Math.PI / 2;
floor.position.y = -1.55;
floor.receiveShadow = true;
scene.add(floor);

// ---- expressions -----------------------------------------------------------
// Deliberately a narrow range. This thing sits on a desk all day, so the top
// of its register is "pleased", not "delighted" -- an assistant that beams at
// you constantly reads as unhinged rather than friendly. Legibility comes from
// the difference between neighbouring states, not from the size of any one.
// One palette, anchored on the brand orange. Mood shifts HUE within a family
// that still reads as the same object -- warmer and brighter when up, cooler
// when down, red when cross, and drained of colour entirely when asleep. The
// orange is home; everything else is a departure you can feel without having
// to name it.
const TONE = {
  base:    { color: 0xff8a00, rough: 0.34, sheen: 0.40 },
  warm:    { color: 0xffa51f, rough: 0.28, sheen: 0.55 },   // up, a bit brighter
  excited: { color: 0xffb92e, rough: 0.20, sheen: 0.75 },   // glossier: it catches more light
  blue:    { color: 0x7a8798, rough: 0.42, sheen: 0.26 },   // down, cooled off
  red:     { color: 0xe04a24, rough: 0.30, sheen: 0.45 },   // cross
  grey:    { color: 0x6d6d73, rough: 0.54, sheen: 0.08 },   // asleep, no colour left
};

const EXPRESSIONS = {
  calm:      { tone: 'base',    lidTop: 0.00, eyeAsym: 0,    mouthW: 1.00, mouthOpen: 0.00, mouthCurve: 0.65 },
  attentive: { tone: 'base',    lidTop: 0.00, eyeAsym: 0,    mouthW: 0.88, mouthOpen: 0.00, mouthCurve: 0.45 },
  pleased:   { tone: 'warm',    lidTop: 0.32, eyeAsym: 0,    mouthW: 1.02, mouthOpen: 0.00, mouthCurve: 1.00 },
  happy:     { tone: 'warm',    lidTop: 0.05, eyeAsym: 0,    mouthW: 1.10, mouthOpen: 0.26, mouthCurve: 0.90 },
  excited:   { tone: 'excited', lidTop: 0.00, eyeAsym: 0,    mouthW: 1.14, mouthOpen: 0.38, mouthCurve: 0.85 },
  listening: { tone: 'base',    lidTop: 0.00, eyeAsym: 0,    mouthW: 0.52, mouthOpen: 0.40, mouthCurve: 0.10 },
  thinking:  { tone: 'base',    lidTop: 0.24, eyeAsym: 0.16, mouthW: 0.70, mouthOpen: 0.00, mouthCurve: -0.12 },
  working:   { tone: 'base',    lidTop: 0.12, eyeAsym: 0,    mouthW: 0.76, mouthOpen: 0.12, mouthCurve: 0.32 },
  sad:       { tone: 'blue',    lidTop: 0.34, eyeAsym: 0,    mouthW: 0.82, mouthOpen: 0.00, mouthCurve: -0.62 },
  cross:     { tone: 'red',     lidTop: 0.40, eyeAsym: 0,    mouthW: 0.78, mouthOpen: 0.00, mouthCurve: -0.40 },
  sleepy:    { tone: 'base',    lidTop: 0.60, eyeAsym: 0,    mouthW: 0.80, mouthOpen: 0.00, mouthCurve: 0.30 },
  asleep:    { tone: 'grey',    lidTop: 0.95, eyeAsym: 0,    mouthW: 0.74, mouthOpen: 0.00, mouthCurve: 0.30, lit: 0.20 },
};

// ---- state -----------------------------------------------------------------
const params = { lit: 1, lidTop: 0, blink: 0, eyeAsym: 0,
                 mouthW: 1, mouthOpen: 0, mouthCurve: 0.65, mouthWave: 0 };
const target = { ...params };
let current = 'calm';

// Body colour is eased separately from the face, in colour space.
const toneNow = new THREE.Color(TONE.base.color);
const toneTo = new THREE.Color(TONE.base.color);
const matNow = { rough: TONE.base.rough, sheen: TONE.base.sheen };
const matTo = { ...matNow };

let talking = false;
let talkT = 0;
const aim = { x: 0, y: 0 };      // where it is looking, -1..1
const look = { x: 0, y: 0 };
let nextBlink = 2;

export function setParams(next) {
  Object.assign(target, next);
}

export function setExpression(name) {
  const e = EXPRESSIONS[name];
  if (!e) return;
  current = name;
  target.lit = e.lit ?? 1;
  for (const k of ['lidTop', 'eyeAsym', 'mouthW', 'mouthOpen', 'mouthCurve']) {
    target[k] = e[k] ?? 0;
  }
  const tone = TONE[e.tone] || TONE.base;
  toneTo.setHex(tone.color);
  matTo.rough = tone.rough;
  matTo.sheen = tone.sheen;
  document.querySelectorAll('#bar button').forEach((b) => {
    b.classList.toggle('on', b.dataset.e === name);
  });
}
export function lookAt(x, y) {
  aim.x = Math.max(-1, Math.min(1, x));
  aim.y = Math.max(-1, Math.min(1, y));
}
export function poke() {
  // Restrained on purpose: enough to feel soft, not enough to look cartoonish.
  wobble.amount.value = 0.05;
  wobble.squash.value = 0.09;
}

addEventListener('pointermove', (e) => {
  const r = canvas.getBoundingClientRect();
  lookAt(((e.clientX - r.left) / r.width) * 2 - 1, ((e.clientY - r.top) / r.height) * 2 - 1);
});
addEventListener('pointerdown', poke);

function resize() {
  const w = canvas.clientWidth || 640;
  const h = canvas.clientHeight || 640;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();
paintFace(params);

const clock = new THREE.Timer();
renderer.setAnimationLoop(() => {
  clock.update();
  const dt = Math.min(0.05, clock.getDelta());
  const t = clock.getElapsed();
  wobble.time.value = t;

  // Wobble and squash decay, so a poke rings out like something soft.
  wobble.amount.value *= Math.pow(0.06, dt);
  wobble.squash.value *= Math.pow(0.02, dt);

  // The whole body TURNS toward the pointer — this is the part the 2D version
  // can only fake by skewing, and it takes the highlight with it.
  look.x += (aim.x - look.x) * Math.min(1, dt * 5);
  look.y += (aim.y - look.y) * Math.min(1, dt * 5);
  orb.rotation.y = look.x * 0.42;
  orb.rotation.x = look.y * 0.26;
  orb.position.x = look.x * 0.10;
  orb.position.y = -look.y * 0.07 + Math.sin(t * 1.4) * 0.022;   // breathing

  // Ease the face toward its target so expressions cross-fade rather than
  // cutting. Everything is one parameter space, so this is a single loop.
  let moved = false;
  for (const k in target) {
    const d = target[k] - params[k];
    if (Math.abs(d) > 0.0008) { params[k] += d * Math.min(1, dt * 7); moved = true; }
    else if (params[k] !== target[k]) { params[k] = target[k]; moved = true; }
  }
  if (moved) paintFace(params);

  // Speech. Real talking is not a mouth flapping at a constant rate: it comes
  // in syllables, grouped into phrases, with breaths between them. Three
  // nested rhythms give that without needing actual audio -- and when audio IS
  // available this is exactly where its amplitude would be substituted.
  if (talking) {
    talkT += dt;
    const phrase = Math.sin(talkT * 0.62) * 0.5 + 0.5;          // breathing between phrases
    const gate = phrase > 0.16 ? 1 : 0;                          // an actual pause, not a lull
    const syllable = Math.pow(Math.sin(talkT * 8.4) * 0.5 + 0.5, 0.65);
    const stress = 0.62 + 0.38 * (Math.sin(talkT * 3.1 + Math.sin(talkT * 1.7) * 2.0) * 0.5 + 0.5);
    const openness = gate * syllable * stress;
    params.mouthOpen = 0.04 + openness * 0.52;
    // Vowels are wide, consonants narrow. Tying width to openness sells it.
    params.mouthW = 0.74 + openness * 0.42;
    params.mouthCurve = 0.34 + openness * 0.30;
    paintFace(params);
  }

  // The body carries the mood. Colour is eased in colour space so a change of
  // feeling is a shift you can watch happen, not a cut.
  const k = Math.min(1, dt * 3.4);
  toneNow.lerp(toneTo, k);
  matNow.rough += (matTo.rough - matNow.rough) * k;
  matNow.sheen += (matTo.sheen - matNow.sheen) * k;
  // Lit orange means watching; drained means it is not -- and that has to be
  // true of the whole object, not just the two eyes.
  material.color.copy(DARK_HUE).lerp(toneNow, Math.min(1, params.lit * 1.05));
  material.roughness = matNow.rough;
  material.sheen = matNow.sheen * params.lit;

  nextBlink -= dt;
  if (nextBlink <= 0 && target.lit > 0.4 && target.lidTop < 0.5 && !talking) {
    params.blink = 1;
    target.blink = 1;
    nextBlink = 2.8 + Math.random() * 4.5;
    setTimeout(() => { params.blink = 0; target.blink = 0; paintFace(params); }, 110);
    paintFace(params);
  }

  renderer.render(scene, camera);
});

// ---- the test bar ----------------------------------------------------------
const bar = document.getElementById('bar');
if (bar) {
  for (const name of Object.keys(EXPRESSIONS)) {
    const b = document.createElement('button');
    b.textContent = name;
    b.dataset.e = name;
    b.addEventListener('click', (ev) => { ev.stopPropagation(); setExpression(name); });
    bar.appendChild(b);
  }
  const t = document.createElement('button');
  t.textContent = 'talking';
  t.className = 'talk';
  t.addEventListener('click', (ev) => {
    ev.stopPropagation();
    talking = !talking;
    t.classList.toggle('on', talking);
    if (!talking) {
      // Hand the mouth back to whatever expression is showing.
      const e = EXPRESSIONS[current];
      target.mouthOpen = e.mouthOpen ?? 0;
      target.mouthW = e.mouthW ?? 1;
      target.mouthCurve = e.mouthCurve ?? 0.65;
    }
  });
  bar.appendChild(t);
}
addEventListener('keydown', (e) => {
  const names = Object.keys(EXPRESSIONS);
  const i = names.indexOf(current);
  if (e.key === 'ArrowRight') setExpression(names[(i + 1) % names.length]);
  if (e.key === 'ArrowLeft') setExpression(names[(i - 1 + names.length) % names.length]);
});
setExpression('calm');

window.fren3d = {
  setParams, setExpression, lookAt, poke, params, EXPRESSIONS,
  talk: (on) => {
    talking = on ?? !talking;
    const b = document.querySelector('#bar button.talk');
    if (b) b.classList.toggle('on', talking);
    if (!talking) {
      const e = EXPRESSIONS[current];
      target.mouthOpen = e.mouthOpen ?? 0;
      target.mouthW = e.mouthW ?? 1;
      target.mouthCurve = e.mouthCurve ?? 0.65;
    }
    return talking;
  },
};
