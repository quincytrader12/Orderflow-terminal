// The swarm core in 3D (WebGL): the same picture as core.ts, with depth.
//
//   membrane  a spindle-shaped lens of nested shells; noise ripples them with
//             the activity, a chrome rim catches the light, contour lines flow
//   coins     rotating particle spheres inside it: size the conviction, cyan
//             the viability, magenta the virality, further along the axis as
//             conviction grows; coins held sit at the far tip with a ring
//   streams   the bots' inputs flow in on the left along curves, results flow
//             out on the right; sparks travel each curve as fast as its data
//   stage     a grid floor fading into the dark, drifting dust, bloom
//
// Drag to orbit, scroll to zoom, double-click to reset; hover a coin for its
// read, click it to open it. Falls back to the flat core (core.ts) when WebGL
// is not available.
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import type { CoreBlob, CoreInput, CoreNode } from './core';

const A = 3.9; // lens half-length (world units)
const B = 1.7; // lens half-height
const SPAN_X = 6.9; // where the input and output nodes sit
const CYAN = new THREE.Color('#38e1ff');
const MAGENTA = new THREE.Color('#ff3d7f');
const CHROME = new THREE.Color('#e4eaf4');
const GREEN = new THREE.Color('#2cf0b0');

// Ashima 3D simplex noise
const NOISE = /* glsl */ `
vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}
float snoise(vec3 v){
  const vec2 C=vec2(1.0/6.0,1.0/3.0);const vec4 D=vec4(0.0,0.5,1.0,2.0);
  vec3 i=floor(v+dot(v,C.yyy));vec3 x0=v-i+dot(i,C.xxx);
  vec3 g=step(x0.yzx,x0.xyz);vec3 l=1.0-g;vec3 i1=min(g.xyz,l.zxy);vec3 i2=max(g.xyz,l.zxy);
  vec3 x1=x0-i1+C.xxx;vec3 x2=x0-i2+C.yyy;vec3 x3=x0-D.yyy;
  i=mod289(i);
  vec4 p=permute(permute(permute(i.z+vec4(0.0,i1.z,i2.z,1.0))+i.y+vec4(0.0,i1.y,i2.y,1.0))+i.x+vec4(0.0,i1.x,i2.x,1.0));
  float n_=0.142857142857;vec3 ns=n_*D.wyz-D.xzx;
  vec4 j=p-49.0*floor(p*ns.z*ns.z);vec4 x_=floor(j*ns.z);vec4 y_=floor(j-7.0*x_);
  vec4 x=x_*ns.x+ns.yyyy;vec4 y=y_*ns.x+ns.yyyy;vec4 h=1.0-abs(x)-abs(y);
  vec4 b0=vec4(x.xy,y.xy);vec4 b1=vec4(x.zw,y.zw);
  vec4 s0=floor(b0)*2.0+1.0;vec4 s1=floor(b1)*2.0+1.0;vec4 sh=-step(h,vec4(0.0));
  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy;vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
  vec3 p0=vec3(a0.xy,h.x);vec3 p1=vec3(a0.zw,h.y);vec3 p2=vec3(a1.xy,h.z);vec3 p3=vec3(a1.zw,h.w);
  vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
  p0*=norm.x;p1*=norm.y;p2*=norm.z;p3*=norm.w;
  vec4 m=max(0.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0);m=m*m;
  return 42.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}`;

const envelope = (u: number) => Math.pow(Math.max(0, Math.sin(Math.PI * u)), 0.82);

function glowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const r = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  r.addColorStop(0, 'rgba(255,255,255,1)');
  r.addColorStop(0.25, 'rgba(255,255,255,0.45)');
  r.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = r;
  g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** A spindle along the x axis: the lens profile revolved. */
function lensGeometry(scale: number) {
  const pts: THREE.Vector2[] = [];
  const n = 96;
  for (let i = 0; i <= n; i++) {
    const u = i / n;
    pts.push(new THREE.Vector2(Math.max(1e-4, B * scale * envelope(u)), -A + 2 * A * u));
  }
  const g = new THREE.LatheGeometry(pts, 128);
  g.rotateZ(-Math.PI / 2);
  return g;
}

function membraneMaterial(rim: THREE.Color, tint: THREE.Color, opacity: number, lines: number, phase: number) {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    uniforms: { uTime: { value: 0 }, uAmp: { value: 0.1 }, uPhase: { value: phase }, uRim: { value: rim }, uTint: { value: tint }, uOpacity: { value: opacity }, uLines: { value: lines } },
    vertexShader: /* glsl */ `
      uniform float uTime; uniform float uAmp; uniform float uPhase;
      varying vec3 vN; varying vec3 vV; varying vec2 vUv;
      ${NOISE}
      void main(){
        vec3 p = position;
        float env = sin(3.14159265 * uv.y);
        float n = snoise(p * 0.55 + vec3(uTime * 0.22, uPhase, uTime * 0.16));
        p += normal * n * uAmp * env;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        vN = normalize(normalMatrix * normal);
        vV = normalize(-mv.xyz);
        vUv = uv;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uRim; uniform vec3 uTint; uniform float uOpacity; uniform float uLines; uniform float uTime;
      varying vec3 vN; varying vec3 vV; varying vec2 vUv;
      void main(){
        float fres = pow(1.0 - abs(dot(vN, vV)), 2.4);
        float lat = vUv.y * uLines - uTime * 0.06;
        float lon = vUv.x * 24.0;
        // thin anti-aliased lines at whole numbers of lat and lon
        float la = 1.0 - smoothstep(0.0, fwidth(lat) * 1.2, 0.5 - abs(fract(lat) - 0.5));
        float lo = 1.0 - smoothstep(0.0, fwidth(lon) * 1.2, 0.5 - abs(fract(lon) - 0.5));
        float env = sin(3.14159265 * vUv.y);
        vec3 col = uRim * fres * 1.1 + uTint * (la * 0.7 + lo * 0.22) * (0.3 + env);
        float a = (fres * 0.8 + la * 0.3 + lo * 0.09) * uOpacity;
        gl_FragColor = vec4(col * a, a);
      }`,
  });
}

const SPHERE_N = 260;
const unitSphere = (() => {
  const a = new Float32Array(SPHERE_N * 3);
  for (let i = 0; i < SPHERE_N; i++) {
    const y = 1 - (2 * (i + 0.5)) / SPHERE_N;
    const r = Math.sqrt(1 - y * y);
    const th = i * 2.399963229728653;
    a.set([Math.cos(th) * r, y, Math.sin(th) * r], i * 3);
  }
  return a;
})();

function coinMaterial(pixelRatio: number) {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: { uR: { value: 0.3 }, uShare: { value: 0.5 }, uAlpha: { value: 0 }, uPulse: { value: 1 }, uPx: { value: pixelRatio }, uHeld: { value: 0 }, uHot: { value: 0 }, uCyan: { value: CYAN }, uMagenta: { value: MAGENTA }, uChrome: { value: CHROME } },
    vertexShader: /* glsl */ `
      uniform float uR; uniform float uShare; uniform float uAlpha; uniform float uPulse; uniform float uPx; uniform float uHeld;
      uniform vec3 uCyan; uniform vec3 uMagenta; uniform vec3 uChrome;
      varying vec3 vCol; varying float vA;
      void main(){
        vec3 p = position * uR * uPulse;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        vec4 c = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        gl_Position = projectionMatrix * mv;
        float depth = clamp((mv.z - c.z) / (uR * uPulse) * 0.5 + 0.5, 0.0, 1.0);
        gl_PointSize = uPx * (2.0 + depth * 2.8) * (22.0 / -mv.z);
        float band = smoothstep(-0.12, 0.12, position.y - (uShare * 2.0 - 1.0));
        vCol = mix(uMagenta, uCyan, band);
        vCol = mix(vCol, uChrome, uHeld * step(0.66, fract(float(gl_VertexID) / 3.0)));
        vA = (0.12 + 0.5 * depth) * uAlpha;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uHot;
      varying vec3 vCol; varying float vA;
      void main(){
        float d = length(gl_PointCoord - 0.5);
        if (d > 0.5) discard;
        float a = smoothstep(0.5, 0.0, d) * vA * (1.0 + uHot * 0.6);
        gl_FragColor = vec4(vCol * a, a);
      }`,
  });
}

interface Coin {
  data: CoreBlob;
  group: THREE.Group;
  points: THREE.Points;
  mat: THREE.ShaderMaterial;
  halo: THREE.Sprite;
  ring: THREE.Mesh;
  ring2: THREE.Mesh;
  seed: number;
  pos: THREE.Vector3;
  r: number;
  a: number;
  alive: boolean;
}

interface Spark {
  out: boolean;
  i: number;
  u: number;
  speed: number;
  col: THREE.Color;
}

const hash = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return ((h >>> 0) % 10_000) / 10_000;
};

/** Does this machine draw WebGL2? */
export function webglAvailable() {
  try {
    const c = document.createElement('canvas');
    return Boolean(c.getContext('webgl2'));
  } catch {
    return false;
  }
}

export class Core3D {
  private renderer: THREE.WebGLRenderer;
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(36, 1, 0.1, 200);
  private clock = new THREE.Clock();
  private t = 0;
  private raf = 0;
  private visible = true;
  private ro: ResizeObserver;
  private io: IntersectionObserver;
  private shells: { mesh: THREE.Mesh; mat: THREE.ShaderMaterial }[] = [];
  private core: THREE.Sprite;
  private coins = new Map<string, Coin>();
  private glow = glowTexture();
  private inCurves: THREE.CubicBezierCurve3[] = [];
  private outCurves: THREE.CubicBezierCurve3[] = [];
  private curveLines = new THREE.Group();
  private nodes = new THREE.Group();
  private sparks: Spark[] = [];
  private sparkGeo: THREE.BufferGeometry;
  private sparkMat: THREE.ShaderMaterial;
  private dust: THREE.Points;
  private flow: THREE.Points;
  private floor: THREE.Mesh;
  private labels: HTMLDivElement[] = [];
  private coinTags: HTMLDivElement[] = [];
  private labelLayer: HTMLDivElement;
  private tip: HTMLDivElement;
  private hud: HTMLDivElement;
  private caption: HTMLDivElement;
  private nIn = -1;
  private nOut = -1;
  // camera orbit
  private yaw = 0;
  private pitch = 0.2;
  private zoom = 1;
  private yawT = 0;
  private pitchT = 0.2;
  private zoomT = 1;
  /** coasting speed after a drag, rad/s */
  private vYaw = 0;
  private lastMove = 0;
  private slowFrames = 0;
  private dropped = false;
  private dragging = false;
  private moved = 0;
  private lastInput = -1e9;
  private pointer = { x: 0, y: 0, nx: 0, ny: 0, inside: false };
  private hovered: Coin | null = null;
  private fit = 18;
  private w = 1;
  private h = 1;

  constructor(
    private host: HTMLElement,
    private input: () => CoreInput,
    private onSelect: (id: string) => void,
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    const px = Math.min(2, window.devicePixelRatio || 1);
    this.renderer.setPixelRatio(px);
    this.renderer.setClearColor(0x000000, 1);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    const el = this.renderer.domElement;
    el.className = 'cc3d-canvas';
    host.appendChild(el);

    this.scene.fog = new THREE.FogExp2(0x000000, 0.035);
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.8, 0.5, 0.16);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    // membrane: nested shells
    const shells: [number, THREE.Color, THREE.Color, number, number][] = [
      [1.0, CHROME, CYAN, 0.55, 9],
      [0.78, CYAN, MAGENTA, 0.26, 7],
      [0.55, MAGENTA, CYAN, 0.18, 5],
      [0.32, CYAN, CYAN, 0.12, 4],
    ];
    shells.forEach(([sc, rim, tint, op, lines], i) => {
      const mat = membraneMaterial(rim, tint, op, lines, i * 1.7);
      const mesh = new THREE.Mesh(lensGeometry(sc), mat);
      mesh.renderOrder = 1;
      this.scene.add(mesh);
      this.shells.push({ mesh, mat });
    });
    this.core = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glow, color: CYAN, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, opacity: 0.35 }));
    this.core.scale.set(A * 1.6, B * 1.6, 1);
    this.scene.add(this.core);

    // stage: floor grid, dust
    const floorMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: { uTime: { value: 0 }, uCol: { value: CYAN } },
      vertexShader: /* glsl */ `varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: /* glsl */ `
        uniform float uTime; uniform vec3 uCol; varying vec3 vW;
        float line(float x){ float w = fwidth(x); return 1.0 - smoothstep(0.0, w * 1.4, abs(fract(x - 0.5) - 0.5)); }
        void main(){
          vec2 g = vW.xz * 0.9;
          float l = max(line(g.x), line(g.y)) * 0.55 + max(line(g.x * 0.2), line(g.y * 0.2)) * 0.6;
          float d = length(vW.xz);
          float fade = exp(-d * 0.11);
          float pool = exp(-d * d * 0.05) * 0.5;
          float scan = smoothstep(0.0, 0.08, abs(fract(d * 0.08 - uTime * 0.05) - 0.5) - 0.42) ;
          float a = (l * 0.18 + scan * 0.12) * fade + pool * 0.08;
          gl_FragColor = vec4(uCol * a, a);
        }`,
    });
    this.floor = new THREE.Mesh(new THREE.PlaneGeometry(90, 90), floorMat);
    this.floor.rotation.x = -Math.PI / 2;
    this.floor.position.y = -B * 2.3;
    this.scene.add(this.floor);

    const dn = 1600;
    const dp = new Float32Array(dn * 3);
    for (let i = 0; i < dn; i++) dp.set([(Math.random() - 0.5) * 50, (Math.random() - 0.35) * 18, (Math.random() - 0.5) * 40 - 6], i * 3);
    const dg = new THREE.BufferGeometry();
    dg.setAttribute('position', new THREE.BufferAttribute(dp, 3));
    this.dust = new THREE.Points(dg, new THREE.PointsMaterial({ size: 0.05, color: 0x9fb4d0, transparent: true, opacity: 0.45, depthWrite: false, blending: THREE.AdditiveBlending }));
    this.scene.add(this.dust);

    // flow through the lens, computed in the shader
    const fn = 900;
    const fa = new Float32Array(fn * 3);
    for (let i = 0; i < fn; i++) fa.set([Math.random(), Math.random() * Math.PI * 2, Math.sqrt(Math.random())], i * 3);
    const fg = new THREE.BufferGeometry();
    fg.setAttribute('position', new THREE.BufferAttribute(fa, 3));
    this.flow = new THREE.Points(
      fg,
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        uniforms: { uTime: { value: 0 }, uSpeed: { value: 0.05 }, uPx: { value: px }, uCyan: { value: CYAN }, uMagenta: { value: MAGENTA } },
        vertexShader: /* glsl */ `
          uniform float uTime; uniform float uSpeed; uniform float uPx; uniform vec3 uCyan; uniform vec3 uMagenta;
          varying vec3 vCol; varying float vA;
          void main(){
            float u = fract(position.x + uTime * uSpeed * (0.6 + position.z * 0.8));
            float env = pow(max(0.0, sin(3.14159265 * u)), 0.82);
            float rr = ${B.toFixed(3)} * 0.9 * env * position.z;
            vec3 p = vec3(-${A.toFixed(3)} + ${(2 * A).toFixed(3)} * u, cos(position.y) * rr, sin(position.y) * rr);
            vec4 mv = modelViewMatrix * vec4(p, 1.0);
            gl_Position = projectionMatrix * mv;
            gl_PointSize = uPx * 1.6 * (22.0 / -mv.z);
            vCol = mix(uCyan, uMagenta, step(0.0, cos(position.y)));
            vA = 0.18 + 0.4 * env;
          }`,
        fragmentShader: /* glsl */ `varying vec3 vCol; varying float vA; void main(){ float d = length(gl_PointCoord - 0.5); if (d > 0.5) discard; float a = smoothstep(0.5, 0.0, d) * vA; gl_FragColor = vec4(vCol * a, a); }`,
      }),
    );
    this.scene.add(this.flow);
    this.scene.add(this.curveLines, this.nodes);

    // sparks
    const cap = 500;
    this.sparkGeo = new THREE.BufferGeometry();
    this.sparkGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(cap * 3), 3));
    this.sparkGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(cap * 3), 3));
    this.sparkGeo.setAttribute('size', new THREE.BufferAttribute(new Float32Array(cap), 1));
    this.sparkMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uPx: { value: px } },
      vertexShader: /* glsl */ `attribute vec3 color; attribute float size; uniform float uPx; varying vec3 vCol; void main(){ vec4 mv = modelViewMatrix * vec4(position,1.0); gl_Position = projectionMatrix * mv; gl_PointSize = uPx * size * (20.0 / -mv.z); vCol = color; }`,
      fragmentShader: /* glsl */ `varying vec3 vCol; void main(){ float d = length(gl_PointCoord - 0.5); if (d > 0.5) discard; float a = pow(smoothstep(0.5, 0.0, d), 1.6); gl_FragColor = vec4(vCol * a, a); }`,
    });
    const sp = new THREE.Points(this.sparkGeo, this.sparkMat);
    sp.frustumCulled = false;
    this.scene.add(sp);

    // DOM: labels, tooltip, HUD
    this.labelLayer = document.createElement('div');
    this.labelLayer.className = 'cc3d-labels';
    this.tip = document.createElement('div');
    this.tip.className = 'cc3d-tip';
    this.hud = document.createElement('div');
    this.hud.className = 'cc3d-hud mono';
    this.caption = document.createElement('div');
    this.caption.className = 'cc3d-caption';
    const corners = document.createElement('div');
    corners.className = 'cc3d-corners';
    corners.innerHTML = '<i></i><i></i><i></i><i></i>';
    const hint = document.createElement('div');
    hint.className = 'cc3d-hint';
    hint.textContent = 'drag to orbit · scroll to zoom · double-click to reset · click a coin to open it';
    host.append(this.labelLayer, this.tip, this.hud, this.caption, corners, hint);

    this.bind(el);
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
    this.io = new IntersectionObserver((e) => (this.visible = e[0]?.isIntersecting ?? true));
    this.io.observe(host);
    this.resize();
    this.loop();
  }

  private bind(el: HTMLCanvasElement) {
    let lx = 0;
    let ly = 0;
    const local = (e: PointerEvent | WheelEvent | MouseEvent) => {
      const r = el.getBoundingClientRect();
      this.pointer.x = e.clientX - r.left;
      this.pointer.y = e.clientY - r.top;
      this.pointer.nx = (this.pointer.x / r.width) * 2 - 1;
      this.pointer.ny = (this.pointer.y / r.height) * 2 - 1;
    };
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      this.dragging = true;
      this.moved = 0;
      lx = e.clientX;
      ly = e.clientY;
      el.setPointerCapture(e.pointerId);
      this.lastInput = performance.now();
    });
    el.addEventListener('pointermove', (e) => {
      local(e);
      this.pointer.inside = true;
      if (!this.dragging) return;
      const dx = e.clientX - lx;
      const dy = e.clientY - ly;
      lx = e.clientX;
      ly = e.clientY;
      this.moved += Math.abs(dx) + Math.abs(dy);
      const now = performance.now();
      const v = (-dx * 0.005) / Math.max(0.008, (now - this.lastMove) / 1000);
      this.lastMove = now;
      this.vYaw = Math.max(-2.5, Math.min(2.5, this.vYaw * 0.5 + v * 0.5));
      this.yawT = Math.max(-1.05, Math.min(1.05, this.yawT - dx * 0.005));
      this.pitchT = Math.max(-0.1, Math.min(0.9, this.pitchT + dy * 0.004));
      this.lastInput = now;
    });
    el.addEventListener('pointerup', (e) => {
      this.dragging = false;
      if (performance.now() - this.lastMove > 80) this.vYaw = 0;
      try {
        el.releasePointerCapture(e.pointerId);
      } catch {
        /* released */
      }
      if (this.moved < 4 && this.hovered) this.onSelect(this.hovered.data.id);
    });
    el.addEventListener('pointerleave', () => {
      this.pointer.inside = false;
      this.hovered = null;
    });
    el.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.zoomT = Math.max(0.55, Math.min(1.7, this.zoomT * Math.exp(e.deltaY * 0.001)));
        this.lastInput = performance.now();
      },
      { passive: false },
    );
    el.addEventListener('dblclick', () => {
      this.yawT = 0;
      this.pitchT = 0.2;
      this.zoomT = 1;
      this.vYaw = 0;
    });
  }

  private resize() {
    const r = this.host.getBoundingClientRect();
    this.w = Math.max(2, Math.floor(r.width));
    this.h = Math.max(2, Math.floor(r.height));
    this.renderer.setSize(this.w, this.h, false);
    this.renderer.domElement.style.width = `${this.w}px`;
    this.renderer.domElement.style.height = `${this.h}px`;
    this.composer.setSize(this.w, this.h);
    this.bloom.resolution.set(this.w / 2, this.h / 2);
    this.camera.aspect = this.w / this.h;
    // fit the whole span (nodes and labels) in view
    const halfW = SPAN_X + (this.w < 700 ? 0.6 : 3.3);
    const tan = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    this.fit = Math.max(halfW / (tan * this.camera.aspect), 3.6 / tan);
    this.camera.updateProjectionMatrix();
  }

  /** Curves from each input node to the lens's left tip, and from its right tip out. */
  private buildStreams(nIn: number, nOut: number) {
    this.curveLines.clear();
    this.nodes.clear();
    for (const l of this.labels) l.remove();
    this.labels = [];
    const place = (n: number, i: number) => (n <= 1 ? 0 : 2.9 - (5.8 * i) / (n - 1));
    const mkLine = (c: THREE.CubicBezierCurve3, col: THREE.Color, inbound: boolean) => {
      const pts = c.getPoints(90);
      const g = new THREE.BufferGeometry().setFromPoints(pts);
      const cols = new Float32Array(pts.length * 3);
      pts.forEach((_, k) => {
        const f = k / (pts.length - 1);
        const a = 0.12 + 0.5 * (inbound ? f : 1 - f);
        cols.set([col.r * a, col.g * a, col.b * a], k * 3);
      });
      g.setAttribute('color', new THREE.BufferAttribute(cols, 3));
      this.curveLines.add(new THREE.Line(g, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false })));
    };
    const mkNode = (p: THREE.Vector3, col: THREE.Color) => {
      const m = new THREE.Mesh(new THREE.SphereGeometry(0.075, 20, 20), new THREE.MeshBasicMaterial({ color: col }));
      m.position.copy(p);
      const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glow, color: col, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.6 }));
      halo.scale.setScalar(0.55);
      halo.position.copy(p);
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.13, 0.145, 40), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.6, side: THREE.DoubleSide }));
      ring.position.copy(p);
      ring.userData.ring = true;
      this.nodes.add(m, halo, ring);
    };
    this.inCurves = [];
    this.outCurves = [];
    for (let i = 0; i < nIn; i++) {
      const y = place(nIn, i);
      const z = (i % 2 ? 1 : -1) * 0.9 * Math.sin((i + 1) * 1.3);
      const p0 = new THREE.Vector3(-SPAN_X, y, z);
      const c = new THREE.CubicBezierCurve3(p0, new THREE.Vector3(-SPAN_X + 2.2, y, z), new THREE.Vector3(-A - 1.6, 0, z * 0.2), new THREE.Vector3(-A, 0, 0));
      this.inCurves.push(c);
      mkLine(c, CYAN, true);
      mkNode(p0, CYAN);
    }
    for (let i = 0; i < nOut; i++) {
      const y = place(nOut, i);
      const z = (i % 2 ? -1 : 1) * 0.9 * Math.sin((i + 1) * 1.1);
      const p3 = new THREE.Vector3(SPAN_X, y, z);
      const c = new THREE.CubicBezierCurve3(new THREE.Vector3(A, 0, 0), new THREE.Vector3(A + 1.6, 0, z * 0.2), new THREE.Vector3(SPAN_X - 2.2, y, z), p3);
      this.outCurves.push(c);
      mkLine(c, CHROME, false);
      mkNode(p3, CHROME);
    }
    for (let i = 0; i < nIn + nOut; i++) {
      const d = document.createElement('div');
      d.className = `cc3d-label ${i < nIn ? 'in' : 'out'}`;
      d.innerHTML = '<span></span><b></b>';
      this.labelLayer.appendChild(d);
      this.labels.push(d);
    }
  }

  private coin(b: CoreBlob): Coin {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(unitSphere, 3));
    const mat = coinMaterial(this.renderer.getPixelRatio());
    const points = new THREE.Points(g, mat);
    const group = new THREE.Group();
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glow, color: CYAN, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0 }));
    const ringMat = () => new THREE.MeshBasicMaterial({ color: CHROME, transparent: true, opacity: 0, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false });
    const ring = new THREE.Mesh(new THREE.TorusGeometry(1.45, 0.012, 8, 96), ringMat());
    const ring2 = new THREE.Mesh(new THREE.TorusGeometry(1.75, 0.008, 8, 96), ringMat());
    group.add(halo, points, ring, ring2);
    this.scene.add(group);
    const c: Coin = { data: b, group, points, mat, halo, ring, ring2, seed: hash(b.id), pos: new THREE.Vector3(-A + 0.2, 0, 0), r: 0.05, a: 0, alive: true };
    this.coins.set(b.id, c);
    return c;
  }

  private dropCoin(c: Coin) {
    this.scene.remove(c.group);
    c.points.geometry.dispose();
    c.mat.dispose();
    (c.halo.material as THREE.Material).dispose();
    for (const m of [c.ring, c.ring2]) {
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
    this.coins.delete(c.data.id);
  }

  private project(v: THREE.Vector3) {
    const p = v.clone().project(this.camera);
    return { x: (p.x * 0.5 + 0.5) * this.w, y: (-p.y * 0.5 + 0.5) * this.h, z: p.z };
  }

  private loop = () => {
    this.raf = requestAnimationFrame(this.loop);
    if (!this.visible || document.hidden) {
      this.clock.getDelta();
      return;
    }
    // a slow GPU: draw at 1× instead of the display's density
    const raw = this.clock.getDelta();
    if (!this.dropped && raw > 1 / 30) {
      if (++this.slowFrames > 90 && this.renderer.getPixelRatio() > 1) {
        this.dropped = true;
        this.renderer.setPixelRatio(1);
        this.resize();
      }
    } else this.slowFrames = Math.max(0, this.slowFrames - 1);
    const s = this.input();
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const dt = Math.min(0.1, raw) * (reduce ? 0.3 : 1);
    this.t += dt * (s.on ? 1 : 0.35);
    const t = this.t;
    if (s.inputs.length !== this.nIn || s.outputs.length !== this.nOut) {
      this.nIn = s.inputs.length;
      this.nOut = s.outputs.length;
      this.buildStreams(this.nIn, this.nOut);
    }

    // camera: idle drift, inertia after a drag, parallax on the pointer
    const idle = performance.now() - this.lastInput > 5000;
    if (!this.dragging) {
      this.yawT = Math.max(-1.05, Math.min(1.05, this.yawT + this.vYaw * dt));
      this.vYaw *= Math.exp(-dt * 4);
      if (idle) this.yawT += (Math.sin(t * 0.09) * 0.32 - this.yawT) * dt * 0.25;
    }
    const k = 1 - Math.exp(-dt * 6);
    this.yaw += (this.yawT - this.yaw) * k;
    this.pitch += (this.pitchT - this.pitch) * k;
    this.zoom += (this.zoomT - this.zoom) * k;
    const par = this.pointer.inside && !this.dragging ? 0.05 : 0;
    const yaw = this.yaw + this.pointer.nx * par;
    const pitch = this.pitch - this.pointer.ny * par * 0.6;
    const dist = this.fit * this.zoom;
    this.camera.position.set(dist * Math.sin(yaw) * Math.cos(pitch), dist * Math.sin(pitch) + 0.3, dist * Math.cos(yaw) * Math.cos(pitch));
    this.camera.lookAt(0, -0.15, 0);

    // membrane
    const breathe = 1 + 0.035 * Math.sin(t * 1.15) + 0.05 * s.activity;
    this.shells.forEach(({ mesh, mat }, i) => {
      mat.uniforms.uTime.value = t;
      mat.uniforms.uAmp.value = (0.08 + 0.22 * s.activity) * (1 - i * 0.12);
      mesh.scale.set(1, breathe, breathe);
      mesh.rotation.x = t * (0.05 + i * 0.03) * (i % 2 ? -1 : 1);
    });
    (this.core.material as THREE.SpriteMaterial).opacity = 0.08 + 0.1 * s.activity + 0.03 * Math.sin(t * 2);
    (this.flow.material as THREE.ShaderMaterial).uniforms.uTime.value = t;
    (this.flow.material as THREE.ShaderMaterial).uniforms.uSpeed.value = 0.04 + s.activity * 0.1;
    (this.floor.material as THREE.ShaderMaterial).uniforms.uTime.value = t;
    this.dust.rotation.y = t * 0.008;
    this.bloom.strength = 0.7 + 0.3 * s.activity;
    for (const n of this.nodes.children) if (n.userData.ring) n.lookAt(this.camera.position);

    // coins
    for (const c of this.coins.values()) c.alive = false;
    const ease = 1 - Math.exp(-dt * 2.2);
    for (const b of s.blobs) {
      const c = this.coins.get(b.id) ?? this.coin(b);
      c.alive = true;
      c.data = b;
      const conv = Math.max(0, Math.min(100, b.conviction)) / 100;
      const u = b.held ? 0.84 : 0.14 + conv * 0.66;
      const env = envelope(u);
      const ang = c.seed * Math.PI * 2 + t * 0.06;
      const rad = B * 0.62 * env * (0.35 + 0.65 * ((c.seed * 7.3) % 1));
      const target = new THREE.Vector3(-A + 2 * A * u, Math.cos(ang) * rad, Math.sin(ang) * rad);
      const r = Math.max(0.08, Math.min(B * 0.42, 0.1 + conv * B * 0.32 + (b.held ? 0.12 : 0)));
      c.pos.lerp(target, ease);
      c.r += (r - c.r) * ease;
      c.a += (1 - c.a) * ease;
    }
    for (const c of [...this.coins.values()]) {
      if (!c.alive) {
        c.a -= dt * 0.8;
        c.r *= 1 - dt * 0.5;
        if (c.a <= 0) {
          if (this.hovered === c) this.hovered = null;
          this.dropCoin(c);
          continue;
        }
      }
      const b = c.data;
      const hot = this.hovered === c ? 1 : 0;
      const share = b.virality + b.viability > 0 ? b.virality / (b.virality + b.viability) : 0.5;
      c.group.position.copy(c.pos);
      c.points.rotation.set(0.35 + c.seed * 0.3, t * (0.45 + c.seed * 0.5) + c.seed * 6.28, 0);
      const u = c.mat.uniforms;
      u.uR.value = c.r;
      u.uShare.value = share;
      u.uAlpha.value = c.a;
      u.uHeld.value = b.held ? 1 : 0;
      u.uHot.value = hot;
      u.uPulse.value = 1 + 0.06 * Math.sin(t * 2.4 + c.seed * 20) * (b.enter ? 1.8 : 1);
      const hm = c.halo.material as THREE.SpriteMaterial;
      hm.color.copy(b.held ? CHROME : share > 0.5 ? MAGENTA : CYAN);
      hm.opacity = (b.enter || b.held ? 0.22 : 0.1) * c.a + hot * 0.2;
      c.halo.scale.setScalar(c.r * 4.2);
      const ringOn = b.held || b.enter;
      (c.ring.material as THREE.MeshBasicMaterial).opacity = (ringOn ? 0.75 : hot * 0.5) * c.a;
      (c.ring.material as THREE.MeshBasicMaterial).color.copy(b.held ? CHROME : GREEN);
      (c.ring2.material as THREE.MeshBasicMaterial).opacity = (b.held ? 0.35 : 0) * c.a;
      c.ring.scale.setScalar(c.r);
      c.ring2.scale.setScalar(c.r);
      c.ring.rotation.set(1.1 + Math.sin(t * 0.7 + c.seed) * 0.2, t * 0.8, 0);
      c.ring2.rotation.set(0.4, -t * 0.5, 0.6);
    }

    // sparks
    if (s.on) {
      s.inputs.forEach((n, i) => {
        if (Math.random() < (0.2 + n.rate * 3.6) * dt) this.sparks.push({ out: false, i, u: 0, speed: 0.35 + Math.random() * 0.4 + n.rate * 0.35, col: n.rate > 0.7 ? MAGENTA : CYAN });
      });
      s.outputs.forEach((n, i) => {
        if (Math.random() < (0.06 + n.rate * 1.8) * dt) this.sparks.push({ out: true, i, u: 0, speed: 0.3 + Math.random() * 0.3, col: n.tone === 'down' ? MAGENTA : n.tone === 'up' ? GREEN : CHROME });
      });
    }
    const posA = this.sparkGeo.getAttribute('position') as THREE.BufferAttribute;
    const colA = this.sparkGeo.getAttribute('color') as THREE.BufferAttribute;
    const sizeA = this.sparkGeo.getAttribute('size') as THREE.BufferAttribute;
    let n = 0;
    const tmp = new THREE.Vector3();
    this.sparks = this.sparks.filter((sp) => (sp.u += sp.speed * dt) < 1.05).slice(-90);
    for (const sp of this.sparks) {
      const curve = sp.out ? this.outCurves[sp.i] : this.inCurves[sp.i];
      if (!curve) continue;
      for (let k2 = 0; k2 < 5 && n < posA.count; k2++) {
        const uu = sp.u - k2 * 0.016;
        if (uu < 0 || uu > 1) continue;
        curve.getPoint(uu, tmp);
        posA.setXYZ(n, tmp.x, tmp.y, tmp.z);
        const f = 1 - k2 / 5;
        colA.setXYZ(n, sp.col.r * f, sp.col.g * f, sp.col.b * f);
        sizeA.setX(n, k2 === 0 ? 5.5 : 3.2 * f);
        n++;
      }
    }
    for (let i = n; i < posA.count; i++) sizeA.setX(i, 0);
    posA.needsUpdate = colA.needsUpdate = sizeA.needsUpdate = true;
    this.sparkGeo.setDrawRange(0, n);

    // hover: the coin under the pointer, by its projected size
    this.hovered = null;
    if (this.pointer.inside && !this.dragging) {
      let best = Infinity;
      for (const c of this.coins.values()) {
        if (c.a < 0.4) continue;
        const p = this.project(c.pos);
        const edge = this.project(c.pos.clone().add(new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0).multiplyScalar(c.r * 1.3)));
        const pr = Math.max(10, Math.hypot(edge.x - p.x, edge.y - p.y));
        const d = Math.hypot(p.x - this.pointer.x, p.y - this.pointer.y);
        if (d < pr && p.z < best) {
          best = p.z;
          this.hovered = c;
        }
      }
    }
    this.renderer.domElement.style.cursor = this.dragging ? 'grabbing' : this.hovered ? 'pointer' : 'grab';

    this.composer.render();
    this.overlay(s);
  };

  private overlay(s: CoreInput) {
    const nodes: [CoreNode, THREE.Vector3, boolean][] = [...s.inputs.map((x, i) => [x, this.inCurves[i]?.v0, true] as [CoreNode, THREE.Vector3, boolean]), ...s.outputs.map((x, i) => [x, this.outCurves[i]?.v3, false] as [CoreNode, THREE.Vector3, boolean])];
    const narrow = this.w < 700;
    nodes.forEach(([node, v, inbound], i) => {
      const el = this.labels[i];
      if (!el || !v) return;
      const p = this.project(v);
      el.style.transform = `translate(${Math.round(p.x)}px, ${Math.round(p.y)}px)`;
      el.style.display = narrow ? 'none' : '';
      el.className = `cc3d-label ${inbound ? 'in' : 'out'}${node.tone ? ` ${node.tone}` : ''}`;
      const [a, b] = el.children as unknown as HTMLElement[];
      if (a.textContent !== node.label) a.textContent = node.label;
      if (b.textContent !== node.value) b.textContent = node.value;
    });
    const h = this.hovered;
    if (h) {
      const p = this.project(h.pos);
      const b = h.data;
      this.tip.style.display = 'block';
      this.tip.style.transform = `translate(${Math.round(Math.min(this.w - 210, p.x + 18))}px, ${Math.round(Math.max(8, p.y - 70))}px)`;
      this.tip.innerHTML = `<b>${escape(b.label)}</b>${b.held ? ' <span class="held">HELD</span>' : b.enter ? ' <span class="pick">PICK</span>' : ''}<div><span>conviction</span><i>${Math.round(b.conviction)}</i></div><div><span>viability</span><i class="c">${Math.round(b.viability)}</i></div><div><span>virality</span><i class="m">${Math.round(b.virality)}</i></div><em>click to open</em>`;
    } else this.tip.style.display = 'none';
    // tags on the leading coins, tracking them in 3D
    const lead = [...this.coins.values()].filter((c) => c.a > 0.5).sort((p, q) => Number(q.data.held) - Number(p.data.held) || q.r - p.r).slice(0, 7);
    while (this.coinTags.length < 7) {
      const d = document.createElement('div');
      d.className = 'cc3d-tag';
      this.labelLayer.appendChild(d);
      this.coinTags.push(d);
    }
    const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1);
    const taken: { x: number; y: number }[] = [];
    this.coinTags.forEach((el, i) => {
      const c = lead[i];
      const p = c ? this.project(c.pos.clone().addScaledVector(up, -c.r * 1.45)) : null;
      if (!c || !p || taken.some((q) => Math.abs(q.x - p.x) < 64 && Math.abs(q.y - p.y) < 14)) {
        el.style.opacity = '0';
        return;
      }
      taken.push(p);
      el.style.opacity = String(Math.min(1, c.a));
      el.style.transform = `translate(${Math.round(p.x)}px, ${Math.round(p.y)}px) translate(-50%, 0)`;
      const html = `${escape(c.data.label)}<i>${c.data.held ? 'HELD' : Math.round(c.data.conviction)}</i>`;
      if (el.innerHTML !== html) el.innerHTML = html;
      el.classList.toggle('held', c.data.held);
      el.classList.toggle('pick', c.data.enter && !c.data.held);
    });
    const yawDeg = THREE.MathUtils.radToDeg(this.yaw).toFixed(1);
    const pitchDeg = THREE.MathUtils.radToDeg(this.pitch).toFixed(1);
    this.hud.textContent = `CORE · ${this.coins.size} OBJ · YAW ${yawDeg}° · PITCH ${pitchDeg}° · ZOOM ${(1 / this.zoom).toFixed(2)}×`;
    if (this.caption.textContent !== s.caption) this.caption.textContent = s.caption;
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.io.disconnect();
    for (const c of [...this.coins.values()]) this.dropCoin(c);
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose?.();
      const mat = m.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
      else mat?.dispose?.();
    });
    this.glow.dispose();
    this.composer.dispose();
    this.renderer.dispose();
    // give the GPU context back now: the browser keeps only a handful, and the view can be opened and closed many times
    this.renderer.forceContextLoss();
    this.host.replaceChildren();
  }
}

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
