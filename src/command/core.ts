// The swarm core: the Command Center's centrepiece, drawn on a canvas every
// frame. What the bots read flows in from the left (each source a curve, its
// sparks as fast as its data), through a lens-shaped membrane that swells and
// ripples with activity, and out to the right (picks, positions, results).
// Inside the lens each coin the swarm is reading is a sphere of particles:
// its size is the conviction, cyan the viability, magenta the virality; it
// drifts right as conviction grows, and coins held sit at the right tip.
import type { Palette } from '../ui/theme';

export interface CoreNode {
  label: string;
  value: string;
  /** 0..1: how busy this line is (spark rate) */
  rate: number;
  tone?: 'up' | 'down' | 'warn';
}

export interface CoreBlob {
  id: string;
  label: string;
  conviction: number;
  viability: number;
  virality: number;
  enter: boolean;
  held: boolean;
}

export interface CoreInput {
  inputs: CoreNode[];
  outputs: CoreNode[];
  blobs: CoreBlob[];
  /** 0..1 overall activity: the membrane's swell */
  activity: number;
  on: boolean;
  title: string;
  caption: string;
}

interface BlobState {
  x: number;
  y: number;
  r: number;
  a: number;
  seed: number;
  seen: number;
  data: CoreBlob;
}

interface Spark {
  out: boolean;
  i: number;
  u: number;
  speed: number;
  hot: boolean;
}

interface Dust {
  u: number;
  v: number;
  speed: number;
}

export interface CoreMemory {
  t: number;
  last: number;
  blobs: Map<string, BlobState>;
  sparks: Spark[];
  dust: Dust[];
}

export function coreMemory(): CoreMemory {
  const dust: Dust[] = [];
  for (let i = 0; i < 90; i++) dust.push({ u: Math.random(), v: Math.random() * 2 - 1, speed: 0.03 + Math.random() * 0.05 });
  return { t: 0, last: 0, blobs: new Map(), sparks: [], dust };
}

// unit sphere, evenly spread (Fibonacci)
const SPHERE: [number, number, number][] = [];
for (let i = 0, n = 120; i < n; i++) {
  const y = 1 - (2 * (i + 0.5)) / n;
  const r = Math.sqrt(1 - y * y);
  const th = i * 2.399963229728653;
  SPHERE.push([Math.cos(th) * r, y, Math.sin(th) * r]);
}

const hash = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return ((h >>> 0) % 10_000) / 10_000;
};

const bez = (p0: number, p1: number, p2: number, p3: number, u: number) => {
  const m = 1 - u;
  return m * m * m * p0 + 3 * m * m * u * p1 + 3 * m * u * u * p2 + u * u * u * p3;
};

const rgba = (c: [number, number, number], a: number) => `rgba(${c[0]},${c[1]},${c[2]},${Math.max(0, Math.min(1, a)).toFixed(3)})`;

/** Draw one frame. `dt` comes from the memory, so the motion is the same at any frame rate. */
export function drawCore(ctx: CanvasRenderingContext2D, w: number, h: number, pal: Palette, s: CoreInput, mem: CoreMemory, nowMs: number, slow = 1) {
  const dt = mem.last ? Math.min(0.1, (nowMs - mem.last) / 1000) * slow : 0;
  mem.last = nowMs;
  mem.t += dt * (s.on ? 1 : 0.35);
  const t = mem.t;
  const dark = pal.dark;
  const cyan = pal.accentRgb;
  const magenta = pal.sellRgb;
  const chrome: [number, number, number] = dark ? [226, 232, 242] : [40, 46, 56];
  const glow = dark ? 'lighter' : 'source-over';

  // geometry
  const narrow = w < 640;
  const L = narrow ? 18 : Math.min(190, w * 0.2);
  const R = w - L;
  const cx = w / 2;
  const cy = h / 2 + 6;
  const a = (R - L) * (narrow ? 0.36 : 0.34);
  const breathe = 1 + 0.035 * Math.sin(t * 1.15) + 0.05 * s.activity;
  const b = Math.min(h * 0.34, a * 0.66) * breathe;
  const tipL = cx - a;
  const tipR = cx + a;
  const env = (u: number) => Math.pow(Math.max(0, Math.sin(Math.PI * u)), 0.82);

  // background: a faint horizon and rings
  ctx.save();
  const bg = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(w, h) * 0.6);
  bg.addColorStop(0, rgba(cyan, dark ? 0.06 : 0.04));
  bg.addColorStop(0.5, rgba(magenta, dark ? 0.02 : 0.015));
  bg.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = rgba(chrome, 0.05);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, cy);
  ctx.lineTo(w, cy);
  ctx.stroke();
  for (let k = 1; k <= 3; k++) {
    ctx.beginPath();
    ctx.ellipse(cx, cy, a * (0.55 + k * 0.32), b * (0.55 + k * 0.42), 0, 0, Math.PI * 2);
    ctx.strokeStyle = rgba(chrome, 0.025);
    ctx.stroke();
  }
  ctx.restore();

  // input and output nodes
  const place = (n: number, i: number) => {
    const span = Math.min(h - 90, (n - 1) * 78);
    return n <= 1 ? cy : cy - span / 2 + (span * i) / (n - 1);
  };
  const inPath = (i: number) => {
    const y = place(s.inputs.length, i);
    return { x0: L, y0: y, x1: L + (tipL - L) * 0.55, y1: y, x2: tipL - (tipL - L) * 0.25, y2: cy, x3: tipL, y3: cy };
  };
  const outPath = (i: number) => {
    const y = place(s.outputs.length, i);
    return { x0: tipR, y0: cy, x1: tipR + (R - tipR) * 0.25, y1: cy, x2: R - (R - tipR) * 0.55, y2: y, x3: R, y3: y };
  };
  type Path = ReturnType<typeof inPath>;
  const at = (p: Path, u: number) => ({ x: bez(p.x0, p.x1, p.x2, p.x3, u), y: bez(p.y0, p.y1, p.y2, p.y3, u) });
  const curve = (p: Path, col: [number, number, number], alpha: number) => {
    ctx.beginPath();
    ctx.moveTo(p.x0, p.y0);
    ctx.bezierCurveTo(p.x1, p.y1, p.x2, p.y2, p.x3, p.y3);
    ctx.strokeStyle = rgba(col, alpha);
    ctx.lineWidth = 1;
    ctx.stroke();
  };
  s.inputs.forEach((n, i) => curve(inPath(i), cyan, 0.1 + n.rate * 0.25));
  s.outputs.forEach((n, i) => curve(outPath(i), n.tone === 'down' ? magenta : chrome, 0.08 + n.rate * 0.22));

  // sparks: spawned at each line's rate, travelling along it
  if (s.on) {
    s.inputs.forEach((n, i) => {
      if (Math.random() < (0.15 + n.rate * 3.2) * dt) mem.sparks.push({ out: false, i, u: 0, speed: 0.45 + Math.random() * 0.5 + n.rate * 0.4, hot: n.rate > 0.7 });
    });
    s.outputs.forEach((n, i) => {
      if (Math.random() < (0.05 + n.rate * 1.6) * dt) mem.sparks.push({ out: true, i, u: 0, speed: 0.35 + Math.random() * 0.4, hot: n.tone === 'up' });
    });
  }
  ctx.save();
  ctx.globalCompositeOperation = glow;
  for (const sp of mem.sparks) {
    sp.u += sp.speed * dt;
    const p = sp.out ? outPath(sp.i) : inPath(sp.i);
    if (sp.out ? sp.i >= s.outputs.length : sp.i >= s.inputs.length) continue;
    const col = sp.out ? (sp.hot ? pal.buyRgb : chrome) : sp.hot ? magenta : cyan;
    for (let k = 0; k < 6; k++) {
      const u = sp.u - k * 0.018;
      if (u < 0 || u > 1) continue;
      const q = at(p, u);
      ctx.fillStyle = rgba(col, (1 - k / 6) * 0.9);
      const r = k === 0 ? 2.1 : 1.4;
      ctx.fillRect(q.x - r / 2, q.y - r / 2, r, r);
    }
  }
  ctx.restore();
  mem.sparks = mem.sparks.filter((sp) => sp.u < 1.12).slice(-260);

  const node = (x: number, y: number, n: CoreNode, side: 'in' | 'out') => {
    const col = side === 'in' ? cyan : n.tone === 'down' ? magenta : n.tone === 'up' ? pal.buyRgb : chrome;
    ctx.beginPath();
    ctx.arc(x, y, 4.5, 0, Math.PI * 2);
    ctx.fillStyle = dark ? '#000' : '#fff';
    ctx.fill();
    ctx.strokeStyle = rgba(col, 0.55 + n.rate * 0.45);
    ctx.lineWidth = 1.4;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, 7 + 3 * Math.sin(t * 2.2 + y) * n.rate, 0, Math.PI * 2);
    ctx.strokeStyle = rgba(col, 0.15 * n.rate);
    ctx.stroke();
    if (narrow) return;
    ctx.textAlign = side === 'in' ? 'right' : 'left';
    const tx = side === 'in' ? x - 12 : x + 12;
    ctx.textBaseline = 'alphabetic';
    ctx.font = '600 9px Inter, system-ui, sans-serif';
    ctx.fillStyle = pal.muted;
    ctx.fillText(n.label.toUpperCase(), tx, y - 3);
    ctx.font = '700 12px "JetBrains Mono", ui-monospace, monospace';
    ctx.fillStyle = n.tone === 'down' ? pal.sell : n.tone === 'up' ? pal.buy : n.tone === 'warn' ? pal.warn : pal.text;
    ctx.fillText(n.value, tx, y + 11);
  };
  s.inputs.forEach((n, i) => node(L, place(s.inputs.length, i), n, 'in'));
  s.outputs.forEach((n, i) => node(R, place(s.outputs.length, i), n, 'out'));

  // the membrane: nested lens contours, rippling with activity
  const K = 11;
  const amp = 0.05 + 0.13 * s.activity;
  const glowIn = ctx.createRadialGradient(cx, cy, 0, cx, cy, a);
  glowIn.addColorStop(0, rgba(cyan, dark ? 0.08 + 0.06 * s.activity : 0.05));
  glowIn.addColorStop(0.6, rgba(magenta, dark ? 0.03 : 0.02));
  glowIn.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.save();
  ctx.fillStyle = glowIn;
  ctx.beginPath();
  ctx.ellipse(cx, cy, a, b, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalCompositeOperation = glow;
  for (let k = 0; k < K; k++) {
    const sc = 0.18 + (0.82 * (k + 1)) / K;
    ctx.beginPath();
    for (let side = 0; side < 2; side++) {
      for (let j = 0; j <= 72; j++) {
        const u = side ? 1 - j / 72 : j / 72;
        const wob = side
          ? 1 + amp * Math.sin(u * Math.PI * 3.4 - t * 0.8 + k * 0.45) * Math.cos(t * 0.43 + k * 0.9)
          : 1 + amp * Math.sin(u * Math.PI * 3 + t * 0.9 + k * 0.6) * Math.sin(t * 0.5 + k * 0.7);
        const x = tipL + 2 * a * u;
        const y = cy + (side ? 1 : -1) * b * sc * env(u) * wob;
        if (j === 0 && side === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
    }
    ctx.closePath();
    const outer = k === K - 1;
    ctx.strokeStyle = outer ? rgba(chrome, 0.55) : k % 3 === 0 ? rgba(magenta, 0.2) : rgba(cyan, 0.1 + 0.12 * (k / K));
    ctx.lineWidth = outer ? 1.3 : 0.8;
    if (outer && dark) {
      ctx.shadowColor = rgba(cyan, 0.6);
      ctx.shadowBlur = 10;
    }
    ctx.stroke();
    ctx.shadowBlur = 0;
  }
  // dust flowing through the core, left to right
  for (const d of mem.dust) {
    d.u += d.speed * dt * (0.6 + s.activity * 1.6);
    if (d.u > 1) {
      d.u -= 1;
      d.v = Math.random() * 2 - 1;
    }
    const x = tipL + 2 * a * d.u;
    const y = cy + d.v * b * 0.88 * env(d.u);
    ctx.fillStyle = rgba(d.v > 0 ? magenta : cyan, 0.18 + 0.3 * env(d.u));
    ctx.fillRect(x, y, 1.2, 1.2);
  }
  ctx.restore();

  // coins: particle spheres
  const seenNow = new Set<string>();
  const ease = 1 - Math.exp(-dt * 2.2);
  for (const blob of s.blobs) {
    seenNow.add(blob.id);
    let st = mem.blobs.get(blob.id);
    const seed = hash(blob.id);
    const conv = Math.max(0, Math.min(100, blob.conviction)) / 100;
    const u = blob.held ? 0.86 : 0.14 + conv * 0.68;
    const tx = tipL + 2 * a * u;
    const ty = cy + (seed * 2 - 1) * b * 0.62 * env(u) + Math.sin(t * 0.35 + seed * 40) * b * 0.06;
    const tr = Math.max(5, Math.min(b * 0.36, 4 + conv * b * 0.3 + (blob.held ? 8 : 0)));
    if (!st) {
      st = { x: tipL + 6, y: cy, r: 1, a: 0, seed, seen: t, data: blob };
      mem.blobs.set(blob.id, st);
    }
    st.data = blob;
    st.x += (tx - st.x) * ease;
    st.y += (ty - st.y) * ease;
    st.r += (tr - st.r) * ease;
    st.a += (1 - st.a) * ease;
  }
  for (const [id, st] of mem.blobs) {
    if (seenNow.has(id)) continue;
    st.a -= dt * 0.8;
    st.r *= 1 - dt * 0.6;
    if (st.a <= 0) mem.blobs.delete(id);
  }
  const list = [...mem.blobs.values()].sort((p, q) => p.r - q.r);
  ctx.save();
  // threads between neighbouring coins
  for (let i = 0; i < list.length; i++)
    for (let j = i + 1; j < list.length; j++) {
      const p = list[i];
      const q = list[j];
      const d = Math.hypot(p.x - q.x, p.y - q.y);
      const reach = (p.r + q.r) * 2.4;
      if (d > reach) continue;
      ctx.strokeStyle = rgba(chrome, 0.12 * (1 - d / reach) * Math.min(p.a, q.a));
      ctx.lineWidth = 0.7;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.quadraticCurveTo((p.x + q.x) / 2, (p.y + q.y) / 2 - 8, q.x, q.y);
      ctx.stroke();
    }
  ctx.globalCompositeOperation = glow;
  for (const st of list) {
    const blob = st.data;
    const share = blob.virality + blob.viability > 0 ? blob.virality / (blob.virality + blob.viability) : 0.5;
    const halo = ctx.createRadialGradient(st.x, st.y, 0, st.x, st.y, st.r * 2.2);
    halo.addColorStop(0, rgba(blob.held ? chrome : share > 0.5 ? magenta : cyan, (blob.enter || blob.held ? 0.32 : 0.16) * st.a));
    halo.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = halo;
    ctx.fillRect(st.x - st.r * 2.2, st.y - st.r * 2.2, st.r * 4.4, st.r * 4.4);
    const n = Math.max(28, Math.min(SPHERE.length, Math.round(st.r * 3.4)));
    const step = SPHERE.length / n;
    const th = t * (0.5 + st.seed * 0.5) + st.seed * 6.28;
    const c = Math.cos(th);
    const sn = Math.sin(th);
    const tilt = 0.35 + st.seed * 0.3;
    const ct = Math.cos(tilt);
    const stt = Math.sin(tilt);
    const pulse = 1 + 0.06 * Math.sin(t * 2.4 + st.seed * 20) * (blob.enter ? 1.6 : 1);
    for (let k = 0; k < n; k++) {
      const [X, Y, Z] = SPHERE[Math.floor(k * step)];
      const x1 = X * c + Z * sn;
      const z1 = -X * sn + Z * c;
      const y2 = Y * ct - z1 * stt;
      const z2 = Y * stt + z1 * ct;
      const depth = (z2 + 1) / 2;
      const col = blob.held && k % 3 === 0 ? chrome : Y < share * 2 - 1 ? magenta : cyan;
      ctx.fillStyle = rgba(col, (0.25 + 0.75 * depth) * st.a);
      const sz = 0.8 + depth * 1.7;
      ctx.fillRect(st.x + x1 * st.r * pulse - sz / 2, st.y + y2 * st.r * pulse - sz / 2, sz, sz);
    }
    if (blob.enter || blob.held) {
      ctx.beginPath();
      ctx.arc(st.x, st.y, st.r * (1.25 + 0.08 * Math.sin(t * 3)), 0, Math.PI * 2);
      ctx.strokeStyle = rgba(blob.held ? chrome : pal.buyRgb, 0.5 * st.a);
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }
  ctx.restore();
  // labels for the biggest
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.font = '700 10px "JetBrains Mono", ui-monospace, monospace';
  const placed: { x: number; y: number; w: number }[] = [];
  for (const st of [...list].reverse()) {
    if (st.a < 0.3 || placed.length >= 6) continue;
    const text = `${st.data.label}${st.data.held ? ' ●' : ''}`;
    const tw = ctx.measureText(text).width;
    const y = st.y + st.r * 1.3 + 3;
    if (placed.some((p) => Math.abs(p.y - y) < 12 && Math.abs(p.x - st.x) < (p.w + tw) / 2 + 6)) continue;
    placed.push({ x: st.x, y, w: tw });
    ctx.fillStyle = st.data.held ? pal.text : rgba(chrome, 0.7 * st.a);
    ctx.fillText(text, st.x, y);
  }

  // titles
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.font = '700 10px Inter, system-ui, sans-serif';
  ctx.fillStyle = rgba(chrome, 0.55);
  const title = s.title.split('').join(String.fromCharCode(8202));
  ctx.fillText(title, cx, cy - b - 18);
  ctx.font = '500 11px Inter, system-ui, sans-serif';
  ctx.fillStyle = pal.muted;
  ctx.fillText(s.caption, cx, cy + b + 28);
}
