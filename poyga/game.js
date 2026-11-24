// Chaqmoq — 3D arcade racing vs bots. Original game for sezgir.github.io
import * as THREE from './three.module.min.js';
import { RoundedBoxGeometry } from './RoundedBoxGeometry.js';
import { RoomEnvironment } from './RoomEnvironment.js';
import { mergeGeometries } from './BufferGeometryUtils.js';

const $ = (id) => document.getElementById(id);
const TG = window.Telegram && window.Telegram.WebApp;
if (TG) {
  try { TG.ready(); TG.expand(); TG.disableVerticalSwipes && TG.disableVerticalSwipes(); TG.setHeaderColor && TG.setHeaderColor('#1b1430'); TG.setBackgroundColor && TG.setBackgroundColor('#1b1430'); } catch (e) {}
}
const isTouch = matchMedia('(pointer:coarse)').matches || 'ontouchstart' in window;
if (!isTouch) document.body.classList.add('kbd');
$('howto').textContent = isTouch
  ? "Ekranning chap/o'ng tomonini bosib boshqaring · ikkalasi = tormoz · NITRO tugmasi"
  : "← → yoki A D: burilish · ↓ / S: tormoz · Probel: nitro · Esc: pauza";

const store = {
  get(k, d) { try { const v = localStorage.getItem('chaqmoq:' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('chaqmoq:' + k, JSON.stringify(v)); } catch (e) {} },
};

// ---------------------------------------------------------------- utils
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const TAU = Math.PI * 2;
const wrapA = (a) => a - TAU * Math.floor((a + Math.PI) / TAU);
const damp = (a, b, k, dt) => lerp(a, b, 1 - Math.exp(-k * dt));
function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const R = rng(20261124);
function hash2(x, y) { const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return s - Math.floor(s); }
function vnoise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi), b = hash2(xi + 1, yi), c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1);
  return lerp(lerp(a, b, u), lerp(c, d, u), v);
}
function fbm(x, y) { let f = 0, a = 0.5; for (let i = 0; i < 4; i++) { f += a * vnoise(x, y); x *= 2.03; y *= 2.03; a *= 0.5; } return f; }
const fmtT = (t) => { if (!isFinite(t)) return '—'; const m = Math.floor(t / 60), s = t - m * 60; return m + ':' + (s < 10 ? '0' : '') + s.toFixed(1); };

// ---------------------------------------------------------------- renderer
const canvas = $('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
let pixelRatio = Math.min(window.devicePixelRatio || 1, isTouch ? 1.6 : 2);
renderer.setPixelRatio(pixelRatio);
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
const FOG = new THREE.Color('#f2b98c');
scene.fog = new THREE.Fog(FOG, 140, 900);
const camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.5, 3000);
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.55;

addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  sizeFx();
});

// ---------------------------------------------------------------- sky + lights
{
  const g = new THREE.SphereGeometry(2000, 32, 16);
  const m = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: { sunDir: { value: new THREE.Vector3(-0.55, 0.22, -0.8).normalize() } },
    vertexShader: 'varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.); }',
    fragmentShader: `varying vec3 vP; uniform vec3 sunDir;
      void main(){ float h = vP.y;
        vec3 top = vec3(0.16,0.27,0.62), mid = vec3(0.55,0.55,0.85), hor = vec3(0.98,0.74,0.55), low = vec3(0.95,0.66,0.48);
        vec3 c = h>0.0 ? mix(hor, mix(mid, top, smoothstep(0.15,0.7,h)), smoothstep(0.0,0.25,h)) : low;
        float s = max(dot(vP, sunDir),0.0);
        c += vec3(1.0,0.75,0.45)*pow(s,8.0)*0.45 + vec3(1.0,0.95,0.8)*smoothstep(0.9965,0.999,s)*1.4;
        gl_FragColor = vec4(c,1.); }`,
  });
  scene.add(new THREE.Mesh(g, m));
}
const hemi = new THREE.HemisphereLight('#bcd3ff', '#c98a5a', 1.25);
scene.add(hemi);
const sun = new THREE.DirectionalLight('#ffd7a8', 2.6);
const SUNV = new THREE.Vector3(-0.55, 0.62, -0.8).normalize();
sun.castShadow = true;
sun.shadow.mapSize.set(isTouch ? 1024 : 2048, isTouch ? 1024 : 2048);
const sc = sun.shadow.camera; sc.left = -60; sc.right = 60; sc.top = 60; sc.bottom = -60; sc.near = 1; sc.far = 260;
sun.shadow.bias = -0.0006; sun.shadow.normalBias = 0.6;
scene.add(sun, sun.target);

// ---------------------------------------------------------------- track
const CTRL = [[0,0],[0,-120],[20,-200],[80,-240],[160,-230],[210,-180],[200,-110],[150,-70],[140,-20],[190,30],[260,50],[300,120],[270,200],[190,230],[100,210],[60,150],[20,100]];
const curve = new THREE.CatmullRomCurve3(CTRL.map((p) => new THREE.Vector3(p[0], 0, p[1])), true, 'centripetal');
const N = 1400;
const sp = curve.getSpacedPoints(N);
const PX = new Float32Array(N), PZ = new Float32Array(N), TX = new Float32Array(N), TZ = new Float32Array(N), NX = new Float32Array(N), NZ = new Float32Array(N), CUM = new Float32Array(N + 1);
for (let i = 0; i < N; i++) {
  PX[i] = sp[i].x; PZ[i] = sp[i].z;
}
for (let i = 0; i < N; i++) {
  const a = (i + 1) % N, b = (i - 1 + N) % N;
  let tx = PX[a] - PX[b], tz = PZ[a] - PZ[b]; const l = Math.hypot(tx, tz); tx /= l; tz /= l;
  TX[i] = tx; TZ[i] = tz; NX[i] = tz; NZ[i] = -tx; // N = right-hand side normal
}
for (let i = 1; i <= N; i++) { const a = i - 1, b = i % N; CUM[i] = CUM[a] + Math.hypot(PX[b] - PX[a], PZ[b] - PZ[a]); }
const L = CUM[N], STEP = L / N;
const HW = 7.5, CURB = 1.1, WALL = 12.5;

function nearestIdx(x, z, hint) {
  let best = hint, bd = Infinity;
  if (hint < 0) { for (let i = 0; i < N; i += 2) { const d = (PX[i] - x) ** 2 + (PZ[i] - z) ** 2; if (d < bd) { bd = d; best = i; } } hint = best; bd = Infinity; }
  for (let k = -40; k <= 40; k++) { const i = (hint + k + N) % N; const d = (PX[i] - x) ** 2 + (PZ[i] - z) ** 2; if (d < bd) { bd = d; best = i; } }
  return best;
}
function distToTrack(x, z) { let bd = Infinity; for (let i = 0; i < N; i += 5) { const d = (PX[i] - x) ** 2 + (PZ[i] - z) ** 2; if (d < bd) bd = d; } return Math.sqrt(bd); }

// --- textures
function canvasTex(w, h, draw, repeat = true) {
  const c = document.createElement('canvas'); c.width = w; c.height = h; draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; }
  return t;
}
const roadTex = canvasTex(256, 512, (g, w, h) => {
  g.fillStyle = '#4a4650'; g.fillRect(0, 0, w, h);
  const r = rng(7);
  for (let i = 0; i < 9000; i++) { const v = 60 + r() * 50 | 0; g.fillStyle = `rgba(${v},${v - 4},${v + 8},${0.35 + r() * 0.4})`; g.fillRect(r() * w, r() * h, 1 + r() * 2, 1 + r() * 2); }
  // tyre marks
  g.fillStyle = 'rgba(25,22,30,.22)'; g.fillRect(w * 0.27, 0, 22, h); g.fillRect(w * 0.66, 0, 22, h);
  g.fillStyle = '#f4efe6'; g.fillRect(8, 0, 7, h); g.fillRect(w - 15, 0, 7, h);
  g.fillStyle = '#f7d774'; g.fillRect(w / 2 - 4, 0, 8, h * 0.45);
});
const curbTex = canvasTex(64, 128, (g, w, h) => { g.fillStyle = '#e8edf2'; g.fillRect(0, 0, w, h); g.fillStyle = '#e2363e'; g.fillRect(0, 0, w, h / 2); });
const wallTex = canvasTex(256, 64, (g, w, h) => {
  const cols = ['#1b8f8a', '#f2f2f2', '#1b8f8a', '#f2b33d'];
  for (let i = 0; i < 4; i++) { g.fillStyle = cols[i]; g.fillRect(i * w / 4, 0, w / 4, h); }
  g.fillStyle = 'rgba(0,0,0,.18)'; g.fillRect(0, h - 8, w, 8);
  g.fillStyle = 'rgba(255,255,255,.25)'; g.fillRect(0, 0, w, 5);
});
const sandTex = canvasTex(256, 256, (g, w, h) => {
  g.fillStyle = '#d8ad7a'; g.fillRect(0, 0, w, h); const r = rng(3);
  for (let i = 0; i < 5000; i++) { g.fillStyle = r() < 0.5 ? 'rgba(160,110,70,.25)' : 'rgba(255,230,190,.25)'; g.fillRect(r() * w, r() * h, 2, 2); }
});

function ribbon(off0, off1, y0, y1, vScale, mat, uMode) {
  const pos = [], uv = [], idx = [];
  for (let i = 0; i <= N; i++) {
    const j = i % N, v = CUM[i] / vScale;
    pos.push(PX[j] + NX[j] * off0, y0, PZ[j] + NZ[j] * off0, PX[j] + NX[j] * off1, y1, PZ[j] + NZ[j] * off1);
    uv.push(0, v, 1, v);
    if (i < N) { const a = i * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx); g.computeVertexNormals();
  if (g.attributes.normal.getY(0) < 0) { for (let k = 0; k < idx.length; k += 3) { const t = idx[k + 1]; idx[k + 1] = idx[k + 2]; idx[k + 2] = t; } g.setIndex(idx); g.computeVertexNormals(); }
  const m = new THREE.Mesh(g, mat); m.receiveShadow = true; scene.add(m); return m;
}
const roadMat = new THREE.MeshStandardMaterial({ map: roadTex, roughness: 0.82, metalness: 0.0 });
ribbon(HW, -HW, 0.03, 0.03, 18, roadMat);
const curbMat = new THREE.MeshStandardMaterial({ map: curbTex, roughness: 0.6 });
ribbon(HW + CURB, HW, 0.08, 0.05, 4.5, curbMat);
ribbon(-HW, -HW - CURB, 0.05, 0.08, 4.5, curbMat);
const shoulderMat = new THREE.MeshStandardMaterial({ map: sandTex, roughness: 1 });
sandTex.repeat.set(1, 1);
ribbon(WALL + 0.5, HW + CURB, 0.02, 0.04, 9, shoulderMat);
ribbon(-HW - CURB, -WALL - 0.5, 0.04, 0.02, 9, shoulderMat);
// walls (vertical ribbons)
function wall(off) {
  const pos = [], uv = [], idx = [];
  for (let i = 0; i <= N; i++) {
    const j = i % N, v = CUM[i] / 12, x = PX[j] + NX[j] * off, z = PZ[j] + NZ[j] * off;
    pos.push(x, 0, z, x, 1.05, z); uv.push(v, 0, v, 1);
    if (i < N) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setIndex(idx); g.computeVertexNormals();
  const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ map: wallTex, roughness: 0.55, side: THREE.DoubleSide }));
  m.castShadow = true; m.receiveShadow = true; scene.add(m);
  // top cap
  ribbon(off + 0.25, off - 0.25, 1.06, 1.06, 6, new THREE.MeshStandardMaterial({ color: '#f5f0e8', roughness: 0.5 }));
}
wall(WALL); wall(-WALL);

// start line (checker)
const START_I = 0;
{
  const t = canvasTex(256, 32, (g, w, h) => { for (let x = 0; x < 16; x++) for (let y = 0; y < 2; y++) { g.fillStyle = (x + y) % 2 ? '#111' : '#fff'; g.fillRect(x * 16, y * 16, 16, 16); } }, false);
  const m = new THREE.Mesh(new THREE.PlaneGeometry(HW * 2, 2.2), new THREE.MeshStandardMaterial({ map: t, roughness: 0.6 }));
  m.rotation.x = -Math.PI / 2; m.rotation.z = Math.atan2(TX[0], TZ[0]); m.position.set(PX[0], 0.045, PZ[0]); m.receiveShadow = true; scene.add(m);
}

// ---------------------------------------------------------------- terrain
{
  const S = 1800, seg = isTouch ? 150 : 220;
  const g = new THREE.PlaneGeometry(S, S, seg, seg); g.rotateX(-Math.PI / 2);
  const p = g.attributes.position, col = new Float32Array(p.count * 3);
  const c1 = new THREE.Color('#d9a873'), c2 = new THREE.Color('#c48553'), c3 = new THREE.Color('#9aa75a'), c4 = new THREE.Color('#6f8f45'), tmp = new THREE.Color();
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i) + 150, z = p.getZ(i) - 10; p.setX(i, x); p.setZ(i, z);
    const d = distToTrack(x, z);
    const k = clamp((d - 16) / 110, 0, 1), kk = k * k * (3 - 2 * k);
    const n = fbm(x * 0.006, z * 0.006);
    const far = clamp((Math.hypot(x - 150, z + 10) - 450) / 300, 0, 1);
    const h = (n - 0.35) * 46 * kk + far * far * 60 * fbm(x * 0.01 + 5, z * 0.01);
    p.setY(i, h - 0.25);
    const green = clamp((fbm(x * 0.012 + 11, z * 0.012 - 4) - 0.5) * 4, 0, 1) * (1 - far) * clamp(1.2 - h / 18, 0, 1);
    tmp.copy(c1).lerp(c2, clamp(n * 1.4 - 0.2, 0, 1)).lerp(c3, green * 0.9).lerp(c4, green * green * 0.6);
    tmp.multiplyScalar(0.92 + hash2(x, z) * 0.12);
    col[i * 3] = tmp.r; col[i * 3 + 1] = tmp.g; col[i * 3 + 2] = tmp.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3)); g.computeVertexNormals();
  const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, flatShading: true }));
  m.receiveShadow = true; scene.add(m);
}
// distant mountains
{
  const mat = new THREE.MeshStandardMaterial({ color: '#9c7aa6', roughness: 1, flatShading: true });
  const snow = new THREE.MeshStandardMaterial({ color: '#fff4ec', roughness: 0.9, flatShading: true });
  for (let i = 0; i < 26; i++) {
    const a = (i / 26) * Math.PI * 2 + R() * 0.2, r = 1050 + R() * 250, h = 120 + R() * 200, w = 160 + R() * 160;
    const geo = new THREE.ConeGeometry(w, h, 6 + (R() * 3 | 0), 1); const m = new THREE.Mesh(geo, mat);
    m.position.set(150 + Math.cos(a) * r, h / 2 - 20, -10 + Math.sin(a) * r); m.rotation.y = R() * 3; scene.add(m);
    if (h > 210) { const s = new THREE.Mesh(new THREE.ConeGeometry(w * 0.3, h * 0.3, geo.parameters.radialSegments, 1), snow); s.position.copy(m.position); s.position.y = h - 20 - h * 0.15 + 0.5; s.rotation.y = m.rotation.y; scene.add(s); }
  }
}

// ---------------------------------------------------------------- scenery
const tmpM = new THREE.Matrix4(), tmpQ = new THREE.Quaternion(), tmpS = new THREE.Vector3(), tmpP = new THREE.Vector3(), UP = new THREE.Vector3(0, 1, 0);
function scatter(count, minD, maxD, fn) {
  let n = 0, tries = 0; const out = [];
  while (n < count && tries < count * 40) {
    tries++;
    const i = (R() * N) | 0, side = R() < 0.5 ? -1 : 1, off = minD + R() * (maxD - minD);
    const x = PX[i] + NX[i] * off * side + (R() - 0.5) * 10, z = PZ[i] + NZ[i] * off * side + (R() - 0.5) * 10;
    if (distToTrack(x, z) < minD) continue;
    out.push([x, z]); n++;
  }
  out.forEach(fn); return out;
}
function instanced(geo, mat, list, shadow = true) {
  const m = new THREE.InstancedMesh(geo, mat, list.length);
  list.forEach((t, i) => { tmpQ.setFromAxisAngle(UP, t.r || 0); tmpS.set(t.sx || t.s, t.sy || t.s, t.sz || t.sx || t.s); tmpP.set(t.x, t.y || 0, t.z); tmpM.compose(tmpP, tmpQ, tmpS); m.setMatrixAt(i, tmpM); if (t.c) m.setColorAt(i, t.c); });
  m.castShadow = shadow; m.receiveShadow = true; scene.add(m); return m;
}
{
  // poplars (terak) — tall slim trees in rows, very Uzbek-countryside
  const poplars = [], trunks = [], rounds = [], roundTrunks = [];
  const greens = ['#4f8a3c', '#5f9a40', '#7aa847', '#c9b23d', '#e0a33a'].map((c) => new THREE.Color(c));
  scatter(48, 20, 70, ([x, z]) => {
    const ang = R() * Math.PI, n = 4 + (R() * 6 | 0);
    for (let k = 0; k < n; k++) {
      const px = x + Math.cos(ang) * k * 5.5, pz = z + Math.sin(ang) * k * 5.5;
      if (distToTrack(px, pz) < 18) continue;
      const s = 0.8 + R() * 0.5;
      poplars.push({ x: px, y: 2.2 * s, z: pz, s, sx: s, sy: s, r: R() * 6, c: greens[R() < 0.8 ? (R() * 3 | 0) : 3 + (R() * 2 | 0)] });
      trunks.push({ x: px, y: 1.1 * s, z: pz, s: s });
    }
  });
  scatter(110, 19, 120, ([x, z]) => {
    const s = 0.8 + R() * 0.9;
    rounds.push({ x, y: 3.2 * s, z, s, r: R() * 6, c: greens[R() < 0.75 ? (R() * 3 | 0) : 3 + (R() * 2 | 0)] });
    roundTrunks.push({ x, y: 1.2 * s, z, s });
  });
  const leaf = new THREE.MeshStandardMaterial({ roughness: 0.85, flatShading: true });
  const bark = new THREE.MeshStandardMaterial({ color: '#7a5434', roughness: 1 });
  const pg = new THREE.ConeGeometry(1.25, 9, 7, 2); pg.translate(0, 4.5, 0);
  { const p = pg.attributes.position; for (let i = 0; i < p.count; i++) { const y = p.getY(i); const k = Math.sin(clamp(y / 9, 0, 1) * Math.PI) * 0.6 + 0.4; p.setX(i, p.getX(i) * k * 1.4); p.setZ(i, p.getZ(i) * k * 1.4); } pg.computeVertexNormals(); }
  instanced(pg, leaf, poplars);
  instanced(new THREE.CylinderGeometry(0.18, 0.26, 2.2, 5), bark, trunks);
  const rg = new THREE.IcosahedronGeometry(2.4, 0);
  instanced(rg, leaf, rounds);
  instanced(new THREE.CylinderGeometry(0.25, 0.35, 2.4, 5), bark, roundTrunks);
  // rocks
  const rocks = []; scatter(70, 16, 90, ([x, z]) => rocks.push({ x, y: 0.2, z, s: 0.6 + R() * 1.6, r: R() * 6, c: new THREE.Color().setHSL(0.07, 0.25, 0.45 + R() * 0.2) }));
  instanced(new THREE.DodecahedronGeometry(1, 0), new THREE.MeshStandardMaterial({ roughness: 1, flatShading: true }), rocks);
}

// madrasa / dome buildings — turquoise domes and tiled portals
const tileTex = canvasTex(128, 128, (g, w, h) => {
  g.fillStyle = '#1f6fa8'; g.fillRect(0, 0, w, h);
  g.strokeStyle = '#7fd7e8'; g.lineWidth = 3;
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) { const cx = i * 32 + 16, cy = j * 32 + 16; g.beginPath(); g.moveTo(cx, cy - 13); g.lineTo(cx + 13, cy); g.lineTo(cx, cy + 13); g.lineTo(cx - 13, cy); g.closePath(); g.stroke(); g.fillStyle = '#f2c75c'; g.fillRect(cx - 3, cy - 3, 6, 6); }
});
const brickTex = canvasTex(128, 128, (g, w, h) => {
  g.fillStyle = '#d9b07c'; g.fillRect(0, 0, w, h); g.fillStyle = 'rgba(120,80,40,.35)';
  for (let y = 0; y < h; y += 8) { g.fillRect(0, y, w, 1); for (let x = ((y / 8) % 2) * 8; x < w; x += 16) g.fillRect(x, y, 1, 8); }
});
const domeMat = new THREE.MeshStandardMaterial({ color: '#2fb5b9', roughness: 0.25, metalness: 0.2, flatShading: false });
const brickMat = new THREE.MeshStandardMaterial({ map: brickTex, roughness: 0.9 });
const tileMat = new THREE.MeshStandardMaterial({ map: tileTex, roughness: 0.4 });
const darkMat = new THREE.MeshStandardMaterial({ color: '#2a2036', roughness: 0.8 });
function madrasa(x, z, rot, s) {
  const g = new THREE.Group();
  const base = new THREE.Mesh(new THREE.BoxGeometry(26, 9, 18), brickMat); base.position.y = 4.5; g.add(base);
  const portal = new THREE.Mesh(new THREE.BoxGeometry(11, 16, 3), tileMat); portal.position.set(0, 8, 9.6); g.add(portal);
  const arch = new THREE.Mesh(new THREE.CylinderGeometry(3, 3, 0.6, 20, 1, false, 0, Math.PI), darkMat); arch.rotation.set(Math.PI / 2, 0, Math.PI / 2); arch.position.set(0, 10, 11.15); arch.rotation.z = 0;
  const archH = new THREE.Mesh(new THREE.BoxGeometry(6, 9, 0.6), darkMat); archH.position.set(0, 5.5, 11.15); g.add(archH);
  const archTop = new THREE.Mesh(new THREE.CircleGeometry(3, 20, 0, Math.PI), darkMat); archTop.position.set(0, 10, 11.47); g.add(archTop);
  const drum = new THREE.Mesh(new THREE.CylinderGeometry(5.2, 5.2, 4, 20), tileMat); drum.position.set(0, 11, -1); g.add(drum);
  const dome = new THREE.Mesh(new THREE.SphereGeometry(5.6, 24, 14, 0, Math.PI * 2, 0, Math.PI / 2), domeMat); dome.position.set(0, 13, -1); dome.scale.y = 1.25; g.add(dome);
  const tip = new THREE.Mesh(new THREE.ConeGeometry(0.4, 2.4, 8), new THREE.MeshStandardMaterial({ color: '#f2c75c', metalness: 0.8, roughness: 0.3 })); tip.position.set(0, 21, -1); g.add(tip);
  for (const sx of [-1, 1]) {
    const mn = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.5, 22, 12), brickMat); mn.position.set(sx * 12.5, 11, 8); g.add(mn);
    const band = new THREE.Mesh(new THREE.CylinderGeometry(1.25, 1.25, 2.5, 12), tileMat); band.position.set(sx * 12.5, 18, 8); g.add(band);
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(1.8, 1.2, 1.4, 12), brickMat); cap.position.set(sx * 12.5, 22.4, 8); g.add(cap);
    const cd = new THREE.Mesh(new THREE.SphereGeometry(1.4, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), domeMat); cd.position.set(sx * 12.5, 23.1, 8); g.add(cd);
  }
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  g.position.set(x, 0, z); g.rotation.y = rot; g.scale.setScalar(s); scene.add(g);
}
function placeFacing(i, side, off, s) {
  const x = PX[i] + NX[i] * off * side, z = PZ[i] + NZ[i] * off * side;
  const rot = Math.atan2(PX[i] - x, PZ[i] - z); madrasa(x, z, rot, s);
}
placeFacing(Math.round(N * 0.06), -1, 48, 1.15);
placeFacing(Math.round(N * 0.33), 1, 52, 1.0);
placeFacing(Math.round(N * 0.55), -1, 58, 1.3);
placeFacing(Math.round(N * 0.8), 1, 50, 0.95);
// single minarets
for (const [f, side, off] of [[0.2, 1, 36], [0.45, -1, 40], [0.68, 1, 44], [0.92, -1, 34]]) {
  const i = Math.round(N * f), x = PX[i] + NX[i] * off * side, z = PZ[i] + NZ[i] * off * side;
  const g = new THREE.Group();
  const t = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 2.6, 30, 14), brickMat); t.position.y = 15; g.add(t);
  for (const y of [9, 19]) { const b = new THREE.Mesh(new THREE.CylinderGeometry(2.1 - y * 0.02, 2.1 - y * 0.02, 2.4, 14), tileMat); b.position.y = y; g.add(b); }
  const lan = new THREE.Mesh(new THREE.CylinderGeometry(2.4, 1.7, 2.6, 14), brickMat); lan.position.y = 31; g.add(lan);
  const d = new THREE.Mesh(new THREE.SphereGeometry(2.2, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2), domeMat); d.position.y = 32.3; g.add(d);
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; } });
  g.position.set(x, 0, z); scene.add(g);
}

// start gate + grandstand + bunting
const START_ANG = Math.atan2(TX[0], TZ[0]);
{
  const g = new THREE.Group();
  const pillarMat = tileMat;
  for (const sx of [-1, 1]) { const p = new THREE.Mesh(new THREE.BoxGeometry(1.6, 9, 1.6), pillarMat); p.position.set(sx * (WALL + 0.8), 4.5, 0); g.add(p);
    const c = new THREE.Mesh(new THREE.SphereGeometry(1.1, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), domeMat); c.position.set(sx * (WALL + 0.8), 9, 0); g.add(c); }
  const bannerTex = canvasTex(1024, 128, (c, w, h) => {
    const gr = c.createLinearGradient(0, 0, 0, h); gr.addColorStop(0, '#ff9f2e'); gr.addColorStop(1, '#e25b1e'); c.fillStyle = gr; c.fillRect(0, 0, w, h);
    c.fillStyle = 'rgba(255,255,255,.18)'; c.fillRect(0, 0, w, 10);
    c.font = '900 78px Unbounded, Rubik, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillStyle = '#fff';
    c.fillText('CHAQMOQ  ·  START', w / 2, h / 2 + 4);
    for (let x = 0; x < w; x += 32) { c.fillStyle = (x / 32) % 2 ? '#111' : '#fff'; c.fillRect(x, h - 14, 32, 14); }
  }, false);
  const beam = new THREE.Mesh(new THREE.BoxGeometry(WALL * 2 + 3.2, 2.6, 0.9), [darkMat, darkMat, darkMat, darkMat, new THREE.MeshStandardMaterial({ map: bannerTex, roughness: 0.5 }), new THREE.MeshStandardMaterial({ map: bannerTex, roughness: 0.5 })]);
  beam.position.y = 7.6; g.add(beam);
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; } });
  g.position.set(PX[0], 0, PZ[0]); g.rotation.y = START_ANG; scene.add(g);

  // grandstand on the left side near the start
  const i0 = N - 40; const off = WALL + 9;
  const st = new THREE.Group();
  const crowdTex = canvasTex(512, 64, (c, w, h) => { c.fillStyle = '#4b3a5e'; c.fillRect(0, 0, w, h); const r = rng(9); const cs = ['#ffd166', '#ef476f', '#06d6a0', '#118ab2', '#fff', '#f78c6b'];
    for (let x = 4; x < w; x += 9) for (let y = 8; y < h; y += 16) { c.fillStyle = cs[r() * cs.length | 0]; c.beginPath(); c.arc(x + r() * 3, y + r() * 3, 3.4, 0, 7); c.fill(); } });
  crowdTex.wrapS = THREE.RepeatWrapping; crowdTex.repeat.set(4, 1);
  for (let k = 0; k < 5; k++) {
    const step = new THREE.Mesh(new THREE.BoxGeometry(60, 1.2, 2.2), [darkMat, darkMat, brickMat, darkMat, new THREE.MeshStandardMaterial({ map: crowdTex }), darkMat]);
    step.position.set(0, 0.6 + k * 1.2, k * 2.2); st.add(step);
  }
  const roof = new THREE.Mesh(new THREE.BoxGeometry(62, 0.5, 13), new THREE.MeshStandardMaterial({ color: '#f2f2f2', roughness: 0.5 })); roof.position.set(0, 9.5, 4); roof.rotation.x = -0.08; st.add(roof);
  for (const sx of [-30, -10, 10, 30]) { const c = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.25, 9.5), darkMat); c.position.set(sx, 4.75, 10); st.add(c); }
  st.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  const sx = PX[i0] - NX[i0] * off, sz = PZ[i0] - NZ[i0] * off;
  st.position.set(sx, 0, sz); st.rotation.y = Math.atan2(PX[i0] - sx, PZ[i0] - sz) + Math.PI; scene.add(st);
}
// flags on poles along the track
const flags = [];
{
  const poleMat = new THREE.MeshStandardMaterial({ color: '#e8e8e8', metalness: 0.6, roughness: 0.3 });
  const fcols = ['#ff5f6d', '#ffc046', '#3fe0c5', '#5aa9ff', '#ffffff'];
  for (let k = 0; k < 44; k++) {
    const i = Math.round((k / 44) * N + 6) % N; const side = k % 2 ? 1 : -1;
    const x = PX[i] + NX[i] * (WALL + 1.4) * side, z = PZ[i] + NZ[i] * (WALL + 1.4) * side;
    const p = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 6, 6), poleMat); p.position.set(x, 3, z); p.castShadow = true; scene.add(p);
    const fg = new THREE.PlaneGeometry(2.2, 1.3, 8, 1); fg.translate(1.1, 0, 0);
    const f = new THREE.Mesh(fg, new THREE.MeshStandardMaterial({ color: fcols[k % fcols.length], side: THREE.DoubleSide, roughness: 0.7 }));
    f.userData.dyn = true; f.position.set(x, 5.3, z); f.rotation.y = Math.atan2(TX[i], TZ[i]) + Math.PI / 2; f.castShadow = true; scene.add(f);
    flags.push({ m: f, base: fg.attributes.position.array.slice(), ph: R() * 6 });
  }
}
// boost pads
const PADS = [];
const padTex = canvasTex(128, 128, (g, w, h) => {
  g.fillStyle = 'rgba(0,0,0,0)'; g.clearRect(0, 0, w, h);
  g.strokeStyle = '#fff'; g.lineWidth = 16; g.lineCap = 'round'; g.lineJoin = 'round';
  for (let k = 0; k < 2; k++) { const y = 30 + k * 56; g.beginPath(); g.moveTo(22, y + 30); g.lineTo(64, y - 4); g.lineTo(106, y + 30); g.stroke(); }
});
{
  const defs = [[0.12, 0], [0.29, -3.2], [0.47, 3.2], [0.63, 0], [0.86, -3]];
  for (const [f, lat] of defs) {
    const i = Math.round(f * N) % N;
    const mat = new THREE.MeshBasicMaterial({ map: padTex, color: '#7ff3ff', transparent: true, depthWrite: false, toneMapped: false, opacity: 0.95 });
    const m = new THREE.Mesh(new THREE.PlaneGeometry(4, 6), mat); m.rotation.x = -Math.PI / 2; m.rotation.z = Math.atan2(TX[i], TZ[i]) + Math.PI;
    m.position.set(PX[i] + NX[i] * lat, 0.07, PZ[i] + NZ[i] * lat);
    const glow = new THREE.Mesh(new THREE.PlaneGeometry(4.8, 7), new THREE.MeshBasicMaterial({ color: '#1a8cff', transparent: true, opacity: 0.35, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }));
    glow.rotation.copy(m.rotation); glow.position.copy(m.position); glow.position.y = 0.06;
    m.userData.dyn = glow.userData.dyn = true; scene.add(glow, m);
    PADS.push({ i, s: CUM[i], lat, mat });
  }
}

// clouds
const clouds = new THREE.Group();
{
  const cm = new THREE.MeshStandardMaterial({ color: '#fff', roughness: 1, flatShading: true, emissive: '#ffd9c2', emissiveIntensity: 0.25, fog: false });
  for (let k = 0; k < 14; k++) {
    const c = new THREE.Group();
    for (let j = 0; j < 5; j++) { const b = new THREE.Mesh(new THREE.IcosahedronGeometry(10 + R() * 10, 0), cm); b.position.set(j * 14 - 28, R() * 6, R() * 10); b.scale.y = 0.6; c.add(b); }
    const a = R() * Math.PI * 2, r = 400 + R() * 500; c.position.set(150 + Math.cos(a) * r, 140 + R() * 80, Math.sin(a) * r); c.rotation.y = R() * 3; clouds.add(c);
  }
  scene.add(clouds);
}

// merge static meshes by material -> far fewer draw calls on phones
const _inv = new THREE.Matrix4(), _rel = new THREE.Matrix4();
function bakeStatic(root, objs) {
  root.updateMatrixWorld(true); _inv.copy(root.matrixWorld).invert();
  const groups = new Map();
  for (const o of objs) o.traverse((m) => {
    if (!m.isMesh || m.isInstancedMesh || m.userData.dyn || Array.isArray(m.material) || m.material.isShaderMaterial) return;
    const key = m.material.uuid + (m.castShadow ? 's' : '') + (m.receiveShadow ? 'r' : '');
    if (!groups.has(key)) groups.set(key, []); groups.get(key).push(m);
  });
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const hasUv = list.every((m) => m.geometry.attributes.uv);
    const geos = list.map((m) => {
      let g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone();
      for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal' && !(k === 'uv' && hasUv)) g.deleteAttribute(k);
      if (!g.attributes.normal) g.computeVertexNormals();
      g.applyMatrix4(_rel.multiplyMatrices(_inv, m.matrixWorld)); return g;
    });
    const merged = mergeGeometries(geos, false); if (!merged) continue;
    const mm = new THREE.Mesh(merged, list[0].material); mm.castShadow = list[0].castShadow; mm.receiveShadow = list[0].receiveShadow;
    root.add(mm);
    for (const m of list) m.parent && m.parent.remove(m);
  }
}
bakeStatic(scene, scene.children.filter((o) => o !== clouds));

// ---------------------------------------------------------------- cars
const CAR_DEFS = [
  { name: "Qizil olov", body: '#e8303c', accent: '#1a1a22' },
  { name: "Moviy shamol", body: '#1f7bff', accent: '#f4f4f4' },
  { name: "Oq lochin", body: '#f3f1ec', accent: '#e8303c' },
  { name: "Sariq bo'ron", body: '#ffb11f', accent: '#1a1a22' },
];
const BOT_DEFS = [
  { name: 'Jasur', body: '#22b573', accent: '#f4f4f4' },
  { name: 'Malika', body: '#ff5fa8', accent: '#ffffff' },
  { name: 'Bobur', body: '#7b4dff', accent: '#ffd166' },
  { name: 'Dilnoza', body: '#13c4d6', accent: '#1a1a22' },
  { name: 'Sardor', body: '#ff7a1f', accent: '#1a1a22' },
  { name: 'Nilufar', body: '#c9ced6', accent: '#1f7bff' },
  { name: 'Otabek', body: '#2c2c36', accent: '#ff4d4d' },
  { name: 'Zarina', body: '#ffe14d', accent: '#7b4dff' },
];
const glassMat = new THREE.MeshPhysicalMaterial({ color: '#1d3148', roughness: 0.05, metalness: 0.6, envMapIntensity: 1.4 });
const tyreMat = new THREE.MeshStandardMaterial({ color: '#17161a', roughness: 0.9 });
const rimMat = new THREE.MeshStandardMaterial({ color: '#d8dbe0', metalness: 0.95, roughness: 0.25 });
const headMat = new THREE.MeshBasicMaterial({ color: '#fffbe6', toneMapped: false });
const tailMat = new THREE.MeshBasicMaterial({ color: '#ff2a3a', toneMapped: false });
const blobTex = canvasTex(64, 64, (g) => { const gr = g.createRadialGradient(32, 32, 2, 32, 32, 31); gr.addColorStop(0, 'rgba(0,0,0,.55)'); gr.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = gr; g.fillRect(0, 0, 64, 64); }, false);
const flameTex = canvasTex(64, 128, (g) => { const gr = g.createLinearGradient(0, 0, 0, 128); gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.25, 'rgba(120,220,255,.95)'); gr.addColorStop(0.7, 'rgba(40,110,255,.5)'); gr.addColorStop(1, 'rgba(40,60,255,0)'); g.fillStyle = gr; g.beginPath(); g.ellipse(32, 64, 26, 64, 0, 0, 7); g.fill(); }, false);

function buildCar(def) {
  const g = new THREE.Group();
  const paint = new THREE.MeshPhysicalMaterial({ color: def.body, metalness: 0.45, roughness: 0.28, clearcoat: 1, clearcoatRoughness: 0.08, envMapIntensity: 1.2 });
  const acc = new THREE.MeshStandardMaterial({ color: def.accent, metalness: 0.3, roughness: 0.4 });
  const body = new THREE.Mesh(new RoundedBoxGeometry(2.05, 0.62, 4.4, 4, 0.26), paint); body.position.y = 0.62; g.add(body);
  // wedge nose
  const nose = new THREE.Mesh(new RoundedBoxGeometry(1.9, 0.36, 1.4, 3, 0.16), paint); nose.position.set(0, 0.48, 2.05); nose.rotation.x = 0.12; g.add(nose);
  const cab = new THREE.Mesh(new RoundedBoxGeometry(1.56, 0.52, 1.9, 4, 0.24), glassMat); cab.position.set(0, 1.08, -0.3); g.add(cab);
  const roof = new THREE.Mesh(new RoundedBoxGeometry(1.5, 0.12, 1.3, 2, 0.06), paint); roof.position.set(0, 1.35, -0.38); g.add(roof);
  // stripes
  const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.02, 4.0), acc); stripe.position.set(0, 0.94, 0.1); g.add(stripe);
  const stripe2 = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.02, 1.3), acc); stripe2.position.set(0, 1.42, -0.38); g.add(stripe2);
  // spoiler
  const wing = new THREE.Mesh(new RoundedBoxGeometry(2.1, 0.08, 0.5, 2, 0.04), acc); wing.position.set(0, 1.32, -2.05); g.add(wing);
  for (const sx of [-0.7, 0.7]) { const st = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.4, 0.2), acc); st.position.set(sx, 1.1, -2.0); g.add(st); }
  // side skirts / bumper
  const lip = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.12, 0.3), acc); lip.position.set(0, 0.32, 2.62); g.add(lip);
  // lights
  for (const sx of [-0.62, 0.62]) {
    const h = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.14, 0.06), headMat); h.position.set(sx, 0.7, 2.68); h.rotation.x = 0.12; g.add(h);
    const t = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.14, 0.06), tailMat); t.position.set(sx, 0.8, -2.21); g.add(t);
  }
  // wheels
  const wheels = [];
  const tg = new THREE.CylinderGeometry(0.42, 0.42, 0.36, 18); tg.rotateZ(Math.PI / 2);
  const rg = new THREE.CylinderGeometry(0.26, 0.26, 0.38, 10); rg.rotateZ(Math.PI / 2);
  for (const [x, z] of [[-1.0, 1.45], [1.0, 1.45], [-1.0, -1.45], [1.0, -1.45]]) {
    const piv = new THREE.Group(); piv.position.set(x, 0.42, z);
    const w = new THREE.Group(); const t = new THREE.Mesh(tg, tyreMat); const r = new THREE.Mesh(rg, rimMat); w.add(t, r);
    for (let k = 0; k < 5; k++) { const sp = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.06, 0.08), rimMat); sp.rotation.x = (k / 5) * Math.PI; sp.position.x = x > 0 ? 0.03 : -0.03; w.add(sp); }
    piv.add(w); g.add(piv); wheels.push({ piv, w, front: z > 0 });
  }
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; } });
  // blob shadow (cheap contact shadow)
  const blob = new THREE.Mesh(new THREE.PlaneGeometry(3.0, 5.4), new THREE.MeshBasicMaterial({ map: blobTex, transparent: true, depthWrite: false }));
  blob.rotation.x = -Math.PI / 2; blob.position.y = 0.06; g.add(blob);
  // exhaust flames
  const flames = [];
  for (const sx of [-0.45, 0.45]) {
    const f = new THREE.Mesh(new THREE.PlaneGeometry(0.55, 1.6), new THREE.MeshBasicMaterial({ map: flameTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, side: THREE.DoubleSide }));
    f.userData.dyn = true; f.rotation.x = Math.PI / 2; f.position.set(sx, 0.5, -2.9); f.visible = false; g.add(f);
    const f2 = f.clone(); f2.rotation.set(Math.PI / 2, Math.PI / 2, 0); f.add(f2); f2.position.set(0, 0, 0); f2.rotation.set(0, Math.PI / 2, 0); f2.userData.dyn = true;
    flames.push(f);
  }
  const bodyGroup = new THREE.Group();
  // move everything except wheels/blob into a body group for roll/pitch
  [...g.children].forEach((c) => { if (c !== blob && !wheels.some((w) => w.piv === c)) bodyGroup.add(c); });
  g.add(bodyGroup);
  bakeStatic(bodyGroup, [...bodyGroup.children]);
  scene.add(g);
  return { g, body: bodyGroup, wheels, flames, paint };
}

// ---------------------------------------------------------------- particles
const PMAX = 900;
const pGeo = new THREE.BufferGeometry();
const pPos = new Float32Array(PMAX * 3), pCol = new Float32Array(PMAX * 3), pSize = new Float32Array(PMAX), pAlpha = new Float32Array(PMAX);
pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
pGeo.setAttribute('color', new THREE.BufferAttribute(pCol, 3));
pGeo.setAttribute('size', new THREE.BufferAttribute(pSize, 1));
pGeo.setAttribute('alpha', new THREE.BufferAttribute(pAlpha, 1));
const pMat = new THREE.ShaderMaterial({
  transparent: true, depthWrite: false,
  uniforms: { scale: { value: innerHeight * 0.5 } },
  vertexShader: `attribute float size; attribute float alpha; attribute vec3 color; varying float vA; varying vec3 vC; uniform float scale;
    void main(){ vec4 mv = modelViewMatrix*vec4(position,1.); gl_PointSize = size*scale/(-mv.z); vA = alpha; vC = color; gl_Position = projectionMatrix*mv; }`,
  fragmentShader: `varying float vA; varying vec3 vC; void main(){ vec2 d = gl_PointCoord-.5; float r = dot(d,d)*4.; if(r>1.) discard; gl_FragColor = vec4(vC, vA*(1.-r)); }`,
});
const points = new THREE.Points(pGeo, pMat); points.frustumCulled = false; scene.add(points);
const sGeo = pGeo.clone(); // sparks (additive)
const sMat = pMat.clone(); sMat.blending = THREE.AdditiveBlending;
const PS = []; for (let i = 0; i < PMAX; i++) PS.push({ life: 0 });
let pHead = 0;
function emit(x, y, z, vx, vy, vz, life, size, r, g, b, grow = 1.5, a = 0.6) {
  const p = PS[pHead]; pHead = (pHead + 1) % PMAX;
  p.x = x; p.y = y; p.z = z; p.vx = vx; p.vy = vy; p.vz = vz; p.life = life; p.max = life; p.size = size; p.r = r; p.g = g; p.b = b; p.grow = grow; p.a = a;
}
function updateParticles(dt) {
  for (let i = 0; i < PMAX; i++) {
    const p = PS[i];
    if (p.life > 0) {
      p.life -= dt; p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt; p.vx *= 0.96; p.vz *= 0.96; p.vy += 0.4 * dt;
      const k = p.life / p.max;
      pPos[i * 3] = p.x; pPos[i * 3 + 1] = p.y; pPos[i * 3 + 2] = p.z;
      pCol[i * 3] = p.r; pCol[i * 3 + 1] = p.g; pCol[i * 3 + 2] = p.b;
      pSize[i] = p.size * (1 + (1 - k) * p.grow); pAlpha[i] = p.a * k;
    } else pAlpha[i] = 0;
  }
  pGeo.attributes.position.needsUpdate = pGeo.attributes.color.needsUpdate = pGeo.attributes.size.needsUpdate = pGeo.attributes.alpha.needsUpdate = true;
}

// ---------------------------------------------------------------- audio
const Audio = {
  ctx: null, on: store.get('sound', true),
  init() {
    if (this.ctx || !this.on) return;
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
    const c = this.ctx = new AC();
    this.master = c.createGain(); this.master.gain.value = 0.55; this.master.connect(c.destination);
    this.eng = c.createGain(); this.eng.gain.value = 0;
    this.f = c.createBiquadFilter(); this.f.type = 'lowpass'; this.f.frequency.value = 900; this.f.Q.value = 3;
    this.o1 = c.createOscillator(); this.o1.type = 'sawtooth'; this.o2 = c.createOscillator(); this.o2.type = 'square';
    const g2 = c.createGain(); g2.gain.value = 0.35;
    this.o1.connect(this.f); this.o2.connect(g2); g2.connect(this.f); this.f.connect(this.eng); this.eng.connect(this.master);
    this.o1.start(); this.o2.start();
    // noise for skid / wind
    const buf = c.createBuffer(1, c.sampleRate * 2, c.sampleRate), d = buf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    this.noise = buf;
    const n = c.createBufferSource(); n.buffer = buf; n.loop = true;
    this.skF = c.createBiquadFilter(); this.skF.type = 'bandpass'; this.skF.frequency.value = 1800; this.skF.Q.value = 1.2;
    this.sk = c.createGain(); this.sk.gain.value = 0; n.connect(this.skF); this.skF.connect(this.sk); this.sk.connect(this.master); n.start();
    const n2 = c.createBufferSource(); n2.buffer = buf; n2.loop = true;
    this.wF = c.createBiquadFilter(); this.wF.type = 'lowpass'; this.wF.frequency.value = 500;
    this.wind = c.createGain(); this.wind.gain.value = 0; n2.connect(this.wF); this.wF.connect(this.wind); this.wind.connect(this.master); n2.start();
  },
  engine(speed, max, boost, active) {
    if (!this.ctx) return; const t = this.ctx.currentTime;
    if (t - (this.lastE || 0) < 0.05) return; this.lastE = t;
    const _ = 0, k = clamp(speed / max, 0, 1.4);
    const gear = (k * 4.2) % 1, f = 55 + k * 120 + gear * 60;
    this.o1.frequency.setTargetAtTime(f, t, 0.05); this.o2.frequency.setTargetAtTime(f * 0.5, t, 0.05);
    this.f.frequency.setTargetAtTime(500 + k * 1600 + (boost ? 900 : 0), t, 0.08);
    this.eng.gain.setTargetAtTime(active ? 0.11 + k * 0.06 : 0.04, t, 0.1);
    this.wind.gain.setTargetAtTime(active ? k * k * 0.12 + (boost ? 0.08 : 0) : 0, t, 0.2);
  },
  skid(v) { if (this.ctx && this.ctx.currentTime - (this.lastS || 0) >= 0.05) this.lastS = this.ctx.currentTime, this.sk.gain.setTargetAtTime(clamp(v, 0, 1) * 0.12, this.ctx.currentTime, 0.06); },
  beep(f, dur = 0.18, type = 'square', vol = 0.18) {
    if (!this.ctx) return; const c = this.ctx, o = c.createOscillator(), g = c.createGain(); o.type = type; o.frequency.value = f;
    g.gain.setValueAtTime(vol, c.currentTime); g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + dur); o.connect(g); g.connect(this.master); o.start(); o.stop(c.currentTime + dur);
  },
  thump(v = 1) {
    if (!this.ctx) return; const c = this.ctx, s = c.createBufferSource(); s.buffer = this.noise; const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 380;
    const g = c.createGain(); g.gain.setValueAtTime(0.5 * v, c.currentTime); g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + 0.25); s.connect(f); f.connect(g); g.connect(this.master); s.start(); s.stop(c.currentTime + 0.3);
  },
  whoosh() {
    if (!this.ctx) return; const c = this.ctx, s = c.createBufferSource(); s.buffer = this.noise; const f = c.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 0.8;
    f.frequency.setValueAtTime(300, c.currentTime); f.frequency.exponentialRampToValueAtTime(3000, c.currentTime + 0.5);
    const g = c.createGain(); g.gain.setValueAtTime(0.0001, c.currentTime); g.gain.exponentialRampToValueAtTime(0.35, c.currentTime + 0.08); g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + 0.7);
    s.connect(f); f.connect(g); g.connect(this.master); s.start(); s.stop(c.currentTime + 0.8);
  },
  mute(on) { this.on = on; store.set('sound', on); if (on) { this.init(); this.ctx && this.ctx.resume(); this.master && (this.master.gain.value = 0.55); } else if (this.master) this.master.gain.value = 0; },
};
function haptic(kind) {
  try { if (TG && TG.HapticFeedback) { kind === 'light' ? TG.HapticFeedback.impactOccurred('light') : kind === 'ok' ? TG.HapticFeedback.notificationOccurred('success') : TG.HapticFeedback.impactOccurred('heavy'); } else if (navigator.vibrate) navigator.vibrate(kind === 'light' ? 8 : 25); } catch (e) {}
}

// ---------------------------------------------------------------- game state
const DIFF = [
  { skill: 0.86, band: 0.10, name: 'Oson' },
  { skill: 0.95, band: 0.07, name: "O'rta" },
  { skill: 1.02, band: 0.05, name: 'Qiyin' },
];
const LAPS = 3, MAXV = 47, BOOSTV = 64;
let carChoice = store.get('car', 0), diff = store.get('diff', 1);
let cars = [], player = null;
let state = 'menu'; // menu | count | race | finish | paused
let raceT = 0, countT = 0, finishT = 0, lastCount = 0;
const input = { l: false, r: false, b: false, n: false };

function makeCar(def, isPlayer) {
  const v = buildCar(def);
  return {
    def, v, isPlayer,
    x: 0, z: 0, h: 0, va: 0, speed: 0, steer: 0, idx: 0, s: 0, d: 0,
    laps: -1, lastS: 0, lapStart: 0, lapTimes: [], best: Infinity, done: false, finishTime: 0, prog: 0,
    nitro: 0.35, boostT: 0, nitroOn: false, offroad: false, slip: 0, roll: 0, pitch: 0, wheelRot: 0, hitT: 0,
    lane: 0, laneT: 0, skill: 1, wobble: R() * 10, nitroAI: 0,
  };
}

function setupRace() {
  cars.forEach((c) => scene.remove(c.v.g));
  cars = [];
  player = makeCar(CAR_DEFS[carChoice], true);
  const bots = BOT_DEFS.slice().sort(() => R() - 0.5).slice(0, 5);
  const grid = [...bots.map((b) => makeCar(b, false)), player]; // player starts last-ish
  // move player to 5th of 6 (2 behind... feels fair & exciting)
  grid.splice(4, 0, grid.pop());
  grid.forEach((c, k) => {
    const row = Math.floor(k / 2), col = k % 2;
    const s = L - 8 - row * 9 - col * 3; const i = Math.floor(s / STEP) % N;
    const lat = col ? -3.3 : 3.3;
    c.x = PX[i] + NX[i] * lat; c.z = PZ[i] + NZ[i] * lat; c.h = c.va = Math.atan2(TX[i], TZ[i]);
    c.idx = i; c.s = CUM[i]; c.lastS = c.s; c.laps = -1; c.lane = lat;
    const D = DIFF[diff];
    c.skill = c.isPlayer ? 1 : D.skill + (k / 6 - 0.4) * 0.06 + (R() - 0.5) * 0.03;
    cars.push(c);
    placeCarMesh(c, 0);
  });
  raceT = 0; finishT = 0;
}

function placeCarMesh(c, dt) {
  const g = c.v.g;
  g.position.set(c.x, 0, c.z); g.rotation.y = c.h;
  const tr = clamp(-c.steer * c.speed / MAXV, -1, 1) * 0.07 + c.slip * 0.15;
  c.roll = damp(c.roll, tr, 8, dt || 1); c.v.body.rotation.z = c.roll;
  c.v.body.rotation.x = damp(c.v.body.rotation.x, c.pitch, 6, dt || 1);
  c.v.body.position.y = c.offroad ? Math.sin(performance.now() * 0.05 + c.wobble) * 0.035 : 0;
  c.wheelRot += c.speed * (dt || 0) / 0.42;
  for (const w of c.v.wheels) { w.w.rotation.x = c.wheelRot; if (w.front) w.piv.rotation.y = -c.steer * 0.45; }
  const boosting = c.boostT > 0 || c.nitroOn;
  for (const f of c.v.flames) { f.visible = boosting; if (boosting) { const s = 0.8 + Math.random() * 0.5; f.scale.set(s, s * (1 + (c.nitroOn ? 0.6 : 0)), s); } }
}

// ---------------------------------------------------------------- physics
function stepCar(c, dt, ctl) {
  const D = DIFF[diff];
  // steering smooth
  c.steer = damp(c.steer, ctl.steer, ctl.steer === 0 ? 10 : 7, dt);
  let maxV = MAXV * (c.isPlayer ? 1 : c.skill);
  const boosting = c.boostT > 0 || c.nitroOn;
  if (boosting) maxV = BOOSTV * (c.isPlayer ? 1 : Math.min(1, c.skill + 0.04));
  if (c.offroad) maxV *= 0.58;
  const acc = boosting ? 34 : 19;
  if (ctl.brake) c.speed -= 38 * dt;
  else if (ctl.gas) { if (c.speed < maxV) c.speed += acc * (1 - (c.speed / maxV) * 0.75) * dt; }
  if (c.speed > maxV) c.speed = damp(c.speed, maxV, c.offroad ? 2.6 : 1.1, dt);
  c.speed = Math.max(c.speed - (ctl.gas ? 0 : 6 * dt), ctl.brake ? -8 : 0);
  // turn
  const sp = Math.abs(c.speed);
  const turn = c.steer * 2.05 * clamp(sp / 10, 0, 1) / (1 + sp / 95);
  c.h -= turn * dt * Math.sign(c.speed || 1);
  // grip / drift: velocity angle follows heading
  const grip = c.offroad ? 4.2 : 5.4;
  const diffA = wrapA(c.h - c.va);
  c.va += diffA * Math.min(1, grip * dt);
  c.h = wrapA(c.h); c.va = c.h - wrapA(c.h - c.va);
  c.slip = clamp(wrapA(c.h - c.va), -0.6, 0.6);
  c.speed -= Math.abs(c.slip) * sp * 0.35 * dt; // scrub
  c.x += Math.sin(c.va) * c.speed * dt; c.z += Math.cos(c.va) * c.speed * dt;
  // track relation
  c.idx = nearestIdx(c.x, c.z, c.idx);
  const i = c.idx, rx = c.x - PX[i], rz = c.z - PZ[i];
  c.d = rx * NX[i] + rz * NZ[i];
  let s = CUM[i] + rx * TX[i] + rz * TZ[i]; s = (s + L) % L; c.s = s;
  c.offroad = Math.abs(c.d) > HW + CURB * 0.6;
  // walls
  const lim = WALL - 1.15;
  if (Math.abs(c.d) > lim) {
    const sg = Math.sign(c.d), pen = Math.abs(c.d) - lim;
    c.x -= NX[i] * pen * sg; c.z -= NZ[i] * pen * sg;
    const vx = Math.sin(c.va) * c.speed, vz = Math.cos(c.va) * c.speed;
    const vn = vx * NX[i] * sg + vz * NZ[i] * sg; // into-wall speed
    if (vn > 0) {
      const nvx = vx - NX[i] * sg * vn * 1.35, nvz = vz - NZ[i] * sg * vn * 1.35;
      const ns = Math.hypot(nvx, nvz); c.va = Math.atan2(nvx, nvz); c.h = lerp(c.h, c.h + wrapA(c.va - c.h), 0.6);
      c.speed = ns * (vn > 6 ? 0.86 : 0.97);
      if (vn > 4 && c.hitT <= 0) {
        c.hitT = 0.25;
        const hx = c.x + NX[i] * sg * 1.1, hz = c.z + NZ[i] * sg * 1.1;
        for (let k = 0; k < 14; k++) emitSpark(hx, 0.6, hz, (Math.random() - 0.5) * 8 - NX[i] * sg * 4, Math.random() * 5, (Math.random() - 0.5) * 8 - NZ[i] * sg * 4);
        if (c.isPlayer) { shake = Math.min(1, shake + vn / 18); Audio.thump(clamp(vn / 15, 0.3, 1)); haptic('heavy'); }
      }
    }
  }
  c.hitT -= dt;
  // boost pads
  for (const p of PADS) {
    let ds = c.s - p.s; if (ds > L / 2) ds -= L; if (ds < -L / 2) ds += L;
    if (Math.abs(ds) < 3.2 && Math.abs(c.d - p.lat) < 2.6) {
      if (c.boostT < 0.3 && c.isPlayer) { Audio.whoosh(); haptic('light'); toast('TEZLASHISH!'); }
      c.boostT = 1.5; c.speed = Math.max(c.speed, MAXV * 1.05);
    }
  }
  c.boostT -= dt;
  // nitro
  if (ctl.nitro && c.nitro > 0.02) { if (!c.nitroOn && c.isPlayer) Audio.whoosh(); c.nitroOn = true; c.nitro = Math.max(0, c.nitro - dt * 0.33); }
  else c.nitroOn = false;
  if (!c.nitroOn) c.nitro = Math.min(1, c.nitro + dt * (0.028 + Math.abs(c.slip) * (sp > 20 ? 0.45 : 0)));
  // lap counting
  if (c.lastS > L * 0.75 && c.s < L * 0.25) onLap(c);
  else if (c.lastS < L * 0.25 && c.s > L * 0.75) c.laps--;
  c.lastS = c.s;
  c.prog = c.laps * L + c.s;
  c.pitch = ctl.brake ? 0.03 : boosting ? -0.035 : 0;
  // fx: tyre smoke / dust
  if (sp > 8) {
    const bx = c.x - Math.sin(c.h) * 1.6, bz = c.z - Math.cos(c.h) * 1.6;
    const px = Math.cos(c.h) * 0.95, pz = -Math.sin(c.h) * 0.95;
    if (c.offroad && Math.random() < 0.9) {
      for (const sgn of [-1, 1]) emit(bx + px * sgn, 0.3, bz + pz * sgn, (Math.random() - 0.5) * 2, 0.8 + Math.random(), (Math.random() - 0.5) * 2, 1.1, 1.3, 0.85, 0.68, 0.5, 2.4, 0.55);
    } else if (Math.abs(c.slip) > 0.12 && sp > 18 && Math.random() < 0.8) {
      for (const sgn of [-1, 1]) emit(bx + px * sgn, 0.25, bz + pz * sgn, (Math.random() - 0.5) * 1.5, 0.6, (Math.random() - 0.5) * 1.5, 0.9, 0.9, 0.92, 0.92, 0.95, 2.6, 0.45);
    }
    if ((c.boostT > 0 || c.nitroOn) && Math.random() < 0.7) {
      for (const sgn of [-1, 1]) emitSpark(c.x - Math.sin(c.h) * 2.9 + px * 0.45 * sgn, 0.5, c.z - Math.cos(c.h) * 2.9 + pz * 0.45 * sgn, -Math.sin(c.h) * 6 + (Math.random() - .5) * 2, Math.random() * 1.5, -Math.cos(c.h) * 6 + (Math.random() - .5) * 2, 0.35, 0.5, 0.65, 0.9, 1);
    }
  }
}
// sparks share the same particle pool but bright colours
function emitSpark(x, y, z, vx, vy, vz, life = 0.45, r = 1, g = 0.72, b = 0.25) { emit(x, y, z, vx, vy, vz, life, 0.35, r, g, b, -0.5, 1); }

function collideCars() {
  for (let a = 0; a < cars.length; a++) for (let b = a + 1; b < cars.length; b++) {
    const A = cars[a], B = cars[b];
    const dx = B.x - A.x, dz = B.z - A.z, d2 = dx * dx + dz * dz, R2 = 2.3;
    if (d2 < R2 * R2 && d2 > 0.0001) {
      const d = Math.sqrt(d2), nx = dx / d, nz = dz / d, pen = (R2 - d) / 2;
      A.x -= nx * pen; A.z -= nz * pen; B.x += nx * pen; B.z += nz * pen;
      const avx = Math.sin(A.va) * A.speed, avz = Math.cos(A.va) * A.speed, bvx = Math.sin(B.va) * B.speed, bvz = Math.cos(B.va) * B.speed;
      const rel = (avx - bvx) * nx + (avz - bvz) * nz;
      if (rel > 0) {
        const j = rel * 0.55;
        const navx = avx - nx * j, navz = avz - nz * j, nbvx = bvx + nx * j, nbvz = bvz + nz * j;
        A.speed = Math.hypot(navx, navz); A.va = Math.atan2(navx, navz); B.speed = Math.hypot(nbvx, nbvz); B.va = Math.atan2(nbvx, nbvz);
        if (rel > 3 && (A.isPlayer || B.isPlayer)) {
          shake = Math.min(1, shake + rel / 25); Audio.thump(clamp(rel / 14, 0.2, 0.8)); haptic('light');
          for (let k = 0; k < 8; k++) emitSpark(A.x + nx * 1.15, 0.6, A.z + nz * 1.15, (Math.random() - 0.5) * 7, Math.random() * 4, (Math.random() - 0.5) * 7);
        }
      }
    }
  }
}

function botControl(c, dt) {
  const ctl = { steer: 0, gas: true, brake: false, nitro: false };
  if (c.done) { ctl.gas = c.speed < 18; }
  const sp = Math.max(c.speed, 5);
  // lane wander + avoidance
  c.laneT -= dt;
  if (c.laneT <= 0) { c.laneT = 2 + R() * 3; c.laneTarget = (R() - 0.5) * 9; }
  let laneT = c.laneTarget ?? c.lane;
  for (const o of cars) {
    if (o === c) continue;
    let ds = o.prog - c.prog;
    if (ds > 0 && ds < 13 && Math.abs(o.d - c.lane) < 2.6) { laneT = o.d + (o.d > 0 ? -4.2 : 4.2); break; }
  }
  // aim for boost pads ahead
  for (const p of PADS) { let ds = p.s - c.s; if (ds < 0) ds += L; if (ds > 10 && ds < 60) { laneT = lerp(laneT, p.lat, 0.5); } }
  c.lane = damp(c.lane, clamp(laneT, -HW + 1.6, HW - 1.6), 1.6, dt);
  const la = 7 + sp * 0.42;
  const ti = (c.idx + Math.round(la / STEP)) % N;
  const tx = PX[ti] + NX[ti] * c.lane, tz = PZ[ti] + NZ[ti] * c.lane;
  const want = Math.atan2(tx - c.x, tz - c.z);
  const da = wrapA(want - c.h);
  ctl.steer = clamp(-da * 3.2, -1, 1);
  // corner speed
  const ai = (c.idx + Math.round((20 + sp * 0.9) / STEP)) % N;
  const ang = Math.abs(wrapA(Math.atan2(TX[ai], TZ[ai]) - Math.atan2(TX[c.idx], TZ[c.idx])));
  let target = MAXV * c.skill * (1 - clamp(ang / 1.4, 0, 1) * 0.42);
  // rubber band relative to player
  const gap = player.prog - c.prog, D = DIFF[diff];
  target *= 1 + clamp(gap / 220, -D.band, D.band * 1.4);
  if (c.speed > target + 4) ctl.brake = true; if (c.speed > target) ctl.gas = false;
  // AI nitro on straights
  c.nitroAI -= dt;
  if (ang < 0.15 && c.nitro > 0.6 && c.nitroAI <= 0 && state === 'race') { c.nitroAI = 1.6; }
  ctl.nitro = c.nitroAI > 0 && c.nitro > 0.05;
  return ctl;
}

// ---------------------------------------------------------------- camera & fx
let shake = 0, camInit = false;
const camPos = new THREE.Vector3(), camLook = new THREE.Vector3();
function updateCamera(dt) {
  const c = player;
  if (state === 'menu' || state === 'finish') {
    const t = performance.now() * 0.00012;
    const narrow = camera.aspect < 1;
    const r = state === 'menu' ? (narrow ? 10.5 : 9) : 14;
    const tx = c.x + Math.sin(t * 2) * r, tz = c.z + Math.cos(t * 2) * r;
    camPos.set(tx, state === 'menu' ? (narrow ? 4.2 : 2.6) : 4.5, tz);
    camera.position.lerp(camPos, camInit ? 1 - Math.exp(-dt * 3) : 1);
    camLook.set(c.x, state === 'menu' && narrow ? -2.4 : 0.9, c.z); camera.lookAt(camLook); camInit = true;
    camera.fov = damp(camera.fov, 50, 3, dt); camera.updateProjectionMatrix();
    return;
  }
  const ha = c.h + wrapA(c.va - c.h) * 0.35;
  const fx = Math.sin(ha), fz = Math.cos(ha);
  const k = clamp(c.speed / MAXV, 0, 1.4);
  const portrait = camera.aspect < 0.8;
  const back = (portrait ? 6.6 : 8.2) + k * 1.6, up = (portrait ? 3.0 : 3.3) + k * 0.4;
  camPos.set(c.x - fx * back, up, c.z - fz * back);
  if (!camInit) { camera.position.copy(camPos); camInit = true; }
  camera.position.x = damp(camera.position.x, camPos.x, 9, dt);
  camera.position.z = damp(camera.position.z, camPos.z, 9, dt);
  camera.position.y = damp(camera.position.y, camPos.y, 5, dt);
  camLook.set(c.x + fx * 6, 1.25, c.z + fz * 6);
  camera.lookAt(camLook);
  if (shake > 0) { camera.position.x += (Math.random() - 0.5) * shake * 0.6; camera.position.y += (Math.random() - 0.5) * shake * 0.4; shake = Math.max(0, shake - dt * 2.5); }
  camera.rotateZ(-c.steer * 0.025 * k);
  const boosting = c.boostT > 0 || c.nitroOn;
  camera.fov = damp(camera.fov, (portrait ? 72 : 60) + k * 12 + (boosting ? 9 : 0), 4, dt); camera.updateProjectionMatrix();
}

// speed lines overlay (2D)
const fx = $('speedfx'), fxc = fx.getContext('2d');
function sizeFx() { fx.width = innerWidth * 0.5; fx.height = innerHeight * 0.5; pMat.uniforms.scale.value = innerHeight * 0.5 * Math.min(renderer.getPixelRatio(), 2); }
sizeFx();
const lines = Array.from({ length: 60 }, () => ({ a: Math.random() * Math.PI * 2, r: Math.random(), v: 0.6 + Math.random() }));
function drawSpeedFx(dt, amt) {
  fx.style.opacity = amt.toFixed(2);
  if (amt < 0.02) return;
  const w = fx.width, h = fx.height, cx = w / 2, cy = h * 0.45, R0 = Math.hypot(w, h) * 0.55;
  fxc.clearRect(0, 0, w, h);
  fxc.lineCap = 'round';
  for (const l of lines) {
    l.r += dt * l.v * 2.2; if (l.r > 1) { l.r = 0.25 + Math.random() * 0.2; l.a = Math.random() * Math.PI * 2; }
    const r1 = R0 * l.r, r2 = r1 + R0 * 0.18 * l.v;
    fxc.strokeStyle = `rgba(255,255,255,${0.5 * l.r})`; fxc.lineWidth = 1 + l.r * 2;
    fxc.beginPath(); fxc.moveTo(cx + Math.cos(l.a) * r1, cy + Math.sin(l.a) * r1); fxc.lineTo(cx + Math.cos(l.a) * r2, cy + Math.sin(l.a) * r2); fxc.stroke();
  }
  const gr = fxc.createRadialGradient(cx, cy, R0 * 0.35, cx, cy, R0);
  gr.addColorStop(0, 'rgba(80,180,255,0)'); gr.addColorStop(1, 'rgba(80,180,255,.35)'); fxc.fillStyle = gr; fxc.fillRect(0, 0, w, h);
}

// ---------------------------------------------------------------- HUD
const mini = $('mini'), mc = mini.getContext('2d');
let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
for (let i = 0; i < N; i++) { minX = Math.min(minX, PX[i]); maxX = Math.max(maxX, PX[i]); minZ = Math.min(minZ, PZ[i]); maxZ = Math.max(maxZ, PZ[i]); }
const mScale = 196 / Math.max(maxX - minX, maxZ - minZ);
const mOx = (236 - (maxX - minX) * mScale) / 2, mOz = (236 - (maxZ - minZ) * mScale) / 2;
const mapX = (x) => 236 - (mOx + (x - minX) * mScale), mapZ = (z) => 236 - (mOz + (z - minZ) * mScale);
const miniBg = document.createElement('canvas'); miniBg.width = miniBg.height = 236;
{
  const g = miniBg.getContext('2d'); g.lineJoin = 'round';
  g.beginPath(); for (let i = 0; i <= N; i += 4) { const j = i % N; i ? g.lineTo(mapX(PX[j]), mapZ(PZ[j])) : g.moveTo(mapX(PX[j]), mapZ(PZ[j])); } g.closePath();
  g.strokeStyle = 'rgba(0,0,0,.35)'; g.lineWidth = 16; g.stroke(); g.strokeStyle = 'rgba(255,255,255,.85)'; g.lineWidth = 9; g.stroke();
  g.fillStyle = '#ffb547'; g.fillRect(mapX(PX[0]) - 5, mapZ(PZ[0]) - 5, 10, 10);
}
function drawMini() {
  mc.clearRect(0, 0, 236, 236); mc.drawImage(miniBg, 0, 0);
  for (const c of cars) { if (c.isPlayer) continue; mc.fillStyle = c.def.body; mc.beginPath(); mc.arc(mapX(c.x), mapZ(c.z), 7, 0, 7); mc.fill(); mc.lineWidth = 2; mc.strokeStyle = 'rgba(0,0,0,.5)'; mc.stroke(); }
  const p = player; mc.fillStyle = '#fff'; mc.beginPath(); mc.arc(mapX(p.x), mapZ(p.z), 10, 0, 7); mc.fill(); mc.fillStyle = p.def.body; mc.beginPath(); mc.arc(mapX(p.x), mapZ(p.z), 6.5, 0, 7); mc.fill();
}
const gc = $('gc'), gctx = gc.getContext('2d');
function drawGauge(k, boost) {
  const w = 340, h = 208, cx = w / 2, cy = 180, r = 150; gctx.clearRect(0, 0, w, h);
  const a0 = Math.PI * 1.08, a1 = Math.PI * 1.92;
  gctx.lineCap = 'round'; gctx.lineWidth = 18; gctx.strokeStyle = 'rgba(20,14,40,.45)'; gctx.beginPath(); gctx.arc(cx, cy, r, a0, a1); gctx.stroke();
  const gr = gctx.createLinearGradient(cx - r, 0, cx + r, 0); gr.addColorStop(0, '#3fe0c5'); gr.addColorStop(0.6, '#ffb547'); gr.addColorStop(1, '#ff5f6d');
  gctx.strokeStyle = boost ? '#7ff3ff' : gr; gctx.lineWidth = 14; gctx.beginPath(); gctx.arc(cx, cy, r, a0, a0 + (a1 - a0) * clamp(k, 0, 1)); gctx.stroke();
  gctx.lineWidth = 3; gctx.strokeStyle = 'rgba(255,255,255,.45)';
  for (let i = 0; i <= 10; i++) { const a = a0 + (a1 - a0) * i / 10; gctx.beginPath(); gctx.moveTo(cx + Math.cos(a) * (r - 22), cy + Math.sin(a) * (r - 22)); gctx.lineTo(cx + Math.cos(a) * (r - 30), cy + Math.sin(a) * (r - 30)); gctx.stroke(); }
}
let toastT = 0;
function toast(t, dur = 1.1) { const e = $('toast'); e.textContent = t; e.classList.add('show'); toastT = dur; }
const ord = (n) => n;
function standings() {
  return cars.slice().sort((a, b) => {
    if (a.done && b.done) return a.finishTime - b.finishTime;
    if (a.done) return -1; if (b.done) return 1;
    return b.prog - a.prog;
  });
}
let lastPos = 0, hudAcc = 0;
function updateHud(dt) {
  hudAcc += dt;
  const st = standings(); const pos = st.indexOf(player) + 1;
  if (hudAcc > 0.1) {
    hudAcc = 0;
    $('pos').querySelector('b').innerHTML = pos + '<sup>/' + cars.length + '</sup>';
    $('lapBox').querySelector('b').innerHTML = clamp(player.laps + 1, 1, LAPS) + '<sup>/' + LAPS + '</sup>';
    $('timeBox').querySelector('b').textContent = fmtT(state === 'count' ? 0 : player.done ? player.finishTime : raceT);
    drawMini();
    // wrong-way detection
    const ta = Math.atan2(TX[player.idx], TZ[player.idx]);
    $('wrong').classList.toggle('hide', !(state === 'race' && Math.abs(wrapA(player.h - ta)) > 1.9 && player.speed > 3));
  }
  if (state === 'race' && lastPos && pos < lastPos) { toast(pos === 1 ? '1-O\'RIN!' : 'Quvib o\'tdingiz!', 0.9); haptic('light'); }
  lastPos = pos;
  const kmh = Math.round(Math.abs(player.speed) * 3.6);
  $('spd').firstChild.nodeValue = kmh;
  drawGauge(player.speed / BOOSTV, player.boostT > 0 || player.nitroOn);
  $('nitroBar').firstElementChild.style.width = (player.nitro * 100).toFixed(0) + '%';
  const nb = $('nitroBtn'); nb.querySelector('.fill').style.height = (player.nitro * 100).toFixed(0) + '%';
  nb.classList.toggle('empty', player.nitro < 0.05); nb.classList.toggle('on', player.nitroOn);
  if (toastT > 0) { toastT -= dt; if (toastT <= 0) $('toast').classList.remove('show'); }
}

function onLap(c) {
  c.laps++;
  if (c.laps === 0) { c.lapStart = raceT; return; }
  const lt = raceT - c.lapStart; c.lapStart = raceT; c.lapTimes.push(lt); c.best = Math.min(c.best, lt);
  if (c.laps >= LAPS && !c.done) {
    c.done = true; c.finishTime = raceT;
    if (c.isPlayer) finishRace();
  } else if (c.isPlayer) {
    toast(c.laps === LAPS - 1 ? 'OXIRGI AYLANA!' : (c.laps + 1) + '-AYLANA · ' + fmtT(lt), 1.6);
    Audio.beep(880, 0.15, 'triangle', 0.2);
  }
}

// ---------------------------------------------------------------- flow
function showMenu() {
  state = 'menu';
  $('menu').classList.remove('hide'); $('hud').classList.add('hide'); $('touch').classList.add('hide'); $('result').classList.add('hide'); $('pause').classList.add('hide');
  setupRace();
  renderBest();
  if (TG && TG.BackButton) { try { TG.BackButton.hide(); } catch (e) {} }
}
function renderBest() {
  const b = store.get('best' + diff, null);
  $('bestTxt').textContent = b ? `Rekordingiz (${DIFF[diff].name}): ${fmtT(b.t)} · ${b.p}-o'rin` : '';
}
function startRace() {
  Audio.init(); Audio.ctx && Audio.ctx.resume();
  setupRace();
  state = 'count'; countT = 3.6; lastCount = 0; camInit = false; lastPos = 0;
  $('menu').classList.add('hide'); $('result').classList.add('hide'); $('pause').classList.add('hide');
  $('hud').classList.remove('hide'); if (isTouch) $('touch').classList.remove('hide');
  if (TG && TG.BackButton) { try { TG.BackButton.show(); } catch (e) {} }
}
function finishRace() {
  state = 'finish'; finishT = 0;
  const pos = standings().indexOf(player) + 1;
  haptic('ok'); Audio.beep(660, 0.12, 'triangle', 0.2); setTimeout(() => Audio.beep(990, 0.3, 'triangle', 0.2), 130);
  toast(pos === 1 ? "G'ALABA!" : 'MARRA!', 2);
  setTimeout(() => showResult(pos), 1900);
}
function showResult(pos) {
  $('hud').classList.add('hide'); $('touch').classList.add('hide');
  const el = $('rPlace'); el.textContent = pos + '-o\'rin'; el.className = 'place ' + (pos === 1 ? '' : pos === 2 ? 'p2' : pos === 3 ? 'p3' : 'px');
  $('rSub').textContent = pos === 1 ? "Ajoyib! Chaqmoqdek tez bo'ldingiz 🏆" : pos <= 3 ? 'Zo\'r natija! Shohsupadasiz' : 'Yana bir urinish — albatta o\'tasiz!';
  $('rTime').textContent = fmtT(player.finishTime); $('rLap').textContent = fmtT(player.best);
  const key = 'best' + diff, old = store.get(key, null);
  const better = !old || pos < old.p || (pos === old.p && player.finishTime < old.t);
  $('rBest').classList.toggle('hide', !better);
  if (better) store.set(key, { t: player.finishTime, p: pos });
  const st = standings(); const rows = $('rRows'); rows.innerHTML = '';
  st.forEach((c, k) => {
    const r = document.createElement('div'); r.className = 'row' + (c.isPlayer ? ' me' : '');
    const t = c.done ? fmtT(c.finishTime) : '+' + Math.max(1, Math.round((player.prog - c.prog) / Math.max(c.speed, 20))) + ' s';
    r.innerHTML = `<span class="n">${k + 1}</span><span class="d" style="background:${c.def.body}"></span><span>${c.isPlayer ? 'Siz' : c.def.name}</span><span class="t">${t}</span>`;
    rows.appendChild(r);
  });
  $('result').classList.remove('hide');
}
function pause(on) {
  if (on && (state === 'race' || state === 'count')) { pausedFrom = state; state = 'paused'; $('pause').classList.remove('hide'); Audio.engine(0, 1, false, false); Audio.skid(0); }
  else if (!on && state === 'paused') { state = pausedFrom; $('pause').classList.add('hide'); }
}
let pausedFrom = 'race';

// ---------------------------------------------------------------- menu ui
{
  const box = $('cars');
  CAR_DEFS.forEach((d, i) => {
    const b = document.createElement('button'); b.className = 'car' + (i === carChoice ? ' on' : '');
    b.innerHTML = `<i style="background:radial-gradient(circle at 35% 30%, #fff8 0, ${d.body} 45%, ${d.body})"></i><span>${d.name}</span>`;
    b.onclick = () => { carChoice = i; store.set('car', i); [...box.children].forEach((c, k) => c.classList.toggle('on', k === i)); setupRace(); haptic('light'); };
    box.appendChild(b);
  });
  [...$('diff').children].forEach((b) => {
    b.classList.toggle('on', +b.dataset.d === diff);
    b.onclick = () => { diff = +b.dataset.d; store.set('diff', diff); [...$('diff').children].forEach((c) => c.classList.toggle('on', c === b)); renderBest(); haptic('light'); };
  });
  $('startBtn').onclick = startRace;
  $('rAgain').onclick = startRace;
  $('rMenu').onclick = showMenu;
  $('pauseBtn').onclick = () => pause(true);
  $('resumeBtn').onclick = () => pause(false);
  $('restartBtn').onclick = startRace;
  $('quitBtn').onclick = showMenu;
  const sb = $('soundBtn'); const sync = () => (sb.textContent = Audio.on ? '🔊' : '🔇'); sync();
  sb.onclick = () => { Audio.mute(!Audio.on); sync(); };
  if (TG) { $('backLink').href = '../'; try { TG.BackButton.onClick(() => { if (state === 'race' || state === 'count') pause(true); else if (state === 'paused') showMenu(); }); } catch (e) {} }
}
// keyboard
const KEYS = { ArrowLeft: 'l', KeyA: 'l', ArrowRight: 'r', KeyD: 'r', ArrowDown: 'b', KeyS: 'b', Space: 'n', ShiftLeft: 'n', ArrowUp: 'u', KeyW: 'u' };
addEventListener('keydown', (e) => {
  if (KEYS[e.code]) { input[KEYS[e.code]] = true; e.preventDefault(); }
  if (e.code === 'Escape' || e.code === 'KeyP') pause(state !== 'paused');
  if (e.code === 'Enter' && state === 'menu') startRace();
});
addEventListener('keyup', (e) => { if (KEYS[e.code]) input[KEYS[e.code]] = false; });
// touch: left half / right half; nitro button
const touches = new Map();
function syncTouch() {
  let l = false, r = false;
  for (const t of touches.values()) { if (t === 'l') l = true; if (t === 'r') r = true; }
  input.l = l; input.r = r; input.b = l && r;
  $('tzL').classList.toggle('on', l); $('tzR').classList.toggle('on', r);
}
const nitroBtn = $('nitroBtn');
function onTouch(e) {
  if (state !== 'race' && state !== 'count') return;
  for (const t of e.changedTouches) {
    if (e.type === 'touchstart' || e.type === 'touchmove') {
      if (t.target === nitroBtn || nitroBtn.contains(t.target)) { touches.set(t.identifier, 'n'); continue; }
      if (t.target.closest && t.target.closest('button')) continue;
      touches.set(t.identifier, t.clientX < innerWidth / 2 ? 'l' : 'r');
    } else touches.delete(t.identifier);
  }
  input.n = [...touches.values()].includes('n');
  syncTouch();
  if (e.cancelable && !(e.target.closest && e.target.closest('#pauseBtn'))) e.preventDefault();
}
['touchstart', 'touchmove', 'touchend', 'touchcancel'].forEach((ev) => addEventListener(ev, onTouch, { passive: false }));
document.addEventListener('visibilitychange', () => { if (document.hidden) pause(true); });

// ---------------------------------------------------------------- main loop
const clock = new THREE.Clock();
let frameAcc = 0, frameN = 0, tuned = false;
const AUTO = /[?&]auto/.test(location.search);
function frame() {
  requestAnimationFrame(frame);
  if (window.__hold) return;
  let dt = Math.min(clock.getDelta(), 0.05);
  update(dt);
}
function update(dt) {
  // auto quality: drop resolution if slow
  if (!tuned && state === 'race') { frameAcc += dt; frameN++; if (frameAcc > 3) { const avg = frameAcc / frameN; if (avg > 0.024 && pixelRatio > 1) { pixelRatio = 1; renderer.setPixelRatio(1); sizeFx(); } tuned = true; } }
  if (state === 'paused') { renderer.render(scene, camera); return; }
  const t = performance.now() * 0.001;

  if (state === 'count') {
    countT -= dt;
    const n = Math.ceil(countT - 0.6);
    if (n !== lastCount && countT > 0) {
      lastCount = n; const el = $('count');
      if (n >= 1 && n <= 3) { el.innerHTML = `<span>${n}</span>`; Audio.beep(440, 0.18); haptic('light'); }
      else if (n <= 0) { el.innerHTML = '<span class="gogo">START!</span>'; setTimeout(() => { if ($('count').textContent === 'START!') $('count').innerHTML = ''; }, 1000); Audio.beep(880, 0.4, 'square', 0.22); haptic('heavy'); state = 'race'; raceT = 0; cars.forEach((c) => (c.lapStart = 0)); }
    }
  }
  if (state === 'race' || state === 'finish' || state === 'count') {
    const sub = 2, h = dt / sub;
    for (let k = 0; k < sub; k++) {
      if (state === 'race' || state === 'finish') {
        raceT += h;
        for (const c of cars) {
          let ctl;
          if (c.isPlayer && state === 'race' && !AUTO) {
            const s = (input.l ? 1 : 0) - (input.r ? 1 : 0);
            ctl = { steer: -s, gas: !input.b, brake: input.b, nitro: input.n };
            // gentle assist: keep away from walls on touch
          } else ctl = botControl(c, h);
          stepCar(c, h, ctl);
        }
        collideCars();
      }
    }
    if (state === 'count') { for (const c of cars) { c.steer = 0; } }
  }
  for (const c of cars) placeCarMesh(c, dt);
  if (state !== 'menu') {
    const p = player, boosting = p.boostT > 0 || p.nitroOn;
    Audio.engine(Math.abs(p.speed), MAXV, boosting, state !== 'menu');
    Audio.skid(state === 'race' && !p.offroad && p.speed > 18 ? (Math.abs(p.slip) - 0.1) * 4 : 0);
    if (!window.__norender) drawSpeedFx(dt, state === 'race' ? clamp((p.speed - 40) / 20, 0, 1) * (boosting ? 1 : 0.45) : 0);
    if (!window.__norender) updateHud(dt);
  } else drawSpeedFx(dt, 0);
  // flags wave
  for (const f of flags) { const a = f.m.geometry.attributes.position; for (let i = 0; i < a.count; i++) { const bx = f.base[i * 3]; a.setZ(i, Math.sin(t * 6 + bx * 2.2 + f.ph) * 0.18 * bx / 2.2); } a.needsUpdate = true; }
  for (const p of PADS) p.mat.opacity = 0.65 + Math.sin(t * 10 + p.s) * 0.3;
  clouds.rotation.y = t * 0.004;
  updateParticles(dt);
  updateCamera(dt);
  // shadow follows player
  sun.position.set(player.x + SUNV.x * 120, SUNV.y * 120, player.z + SUNV.z * 120); sun.target.position.set(player.x, 0, player.z);
  if (!window.__norender) renderer.render(scene, camera);
}

showMenu();
window.__t = { info: () => ({ calls: renderer.info.render.calls, tris: renderer.info.render.triangles }), update, startRace, get state() { return state; }, get player() { return player; }, get cars() { return cars; }, input };
requestAnimationFrame(frame);
setTimeout(() => { const l = $('loading'); l.style.opacity = 0; setTimeout(() => l.remove(), 500); }, 250);
