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
faceCanvas.width = faceCanvas.height = 512;
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
  eqCtx.clearRect(0, 0, equirect.width, equirect.height);
  // The face occupies roughly 60 deg across and 50 deg down, centred on the
  // equator — little enough that equirect stretch stays invisible.
  const w = equirect.width * (74 / 360);
  const h = equirect.height * (66 / 180);
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
  emissiveIntensity: 2.1,
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

// ---- state -----------------------------------------------------------------
const params = {
  lit: 1, lidTop: 0, blink: 0, eyeAsym: 0,
  mouthW: 0.66, mouthOpen: 0.2, mouthCurve: 0.9, mouthWave: 0,
};
const aim = { x: 0, y: 0 };      // where it is looking, -1..1
const look = { x: 0, y: 0 };
let nextBlink = 2;

export function setParams(next) {
  Object.assign(params, next);
  paintFace(params);
}
export function lookAt(x, y) {
  aim.x = Math.max(-1, Math.min(1, x));
  aim.y = Math.max(-1, Math.min(1, y));
}
export function poke() {
  wobble.amount.value = 0.085;
  wobble.squash.value = 0.16;
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
  orb.rotation.y = look.x * 0.5;
  orb.rotation.x = look.y * 0.34;
  orb.position.x = look.x * 0.12;
  orb.position.y = -look.y * 0.08 + Math.sin(t * 1.5) * 0.03;   // breathing

  nextBlink -= dt;
  if (nextBlink <= 0) {
    params.blink = 1;
    nextBlink = 2.6 + Math.random() * 4;
    setTimeout(() => { params.blink = 0; paintFace(params); }, 120);
    paintFace(params);
  }

  renderer.render(scene, camera);
});

window.fren3d = { setParams, lookAt, poke, params };
