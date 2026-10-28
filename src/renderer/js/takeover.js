// Screen possession: a few seconds of her owning your whole screen, in the style of her screensaver
// (capri-virus-saver): the edges crackle red, the screen goes dark and tears in bands, her close-up
// flickers through in red/cyan RGB-split slices with glitch bars over it, "CAPRI ONLINE." types
// itself in, then it all collapses to a line, like an old CRT going off, and your screen is back.
//
// Cheap on purpose: its own canvas, made for it and removed after (nothing drawn the rest of the
// time), at 1x, 24 drawings a second, and pointer-events: none, so you can keep clicking through it.

import { COLORS } from './fx.js';

const CYAN = '#5ef6ff';
const FRAME_MS = 1000 / 24;
const GLY = '01#%&@$*<>/\\|=+?ABCDEF▚▞';
const BAR_COLS = ['rgba(94,246,255,.9)', 'rgba(255,33,82,.9)', 'rgba(94,246,255,.6)', 'rgba(255,255,255,.5)', COLORS.green, COLORS.violet];

// from the screensaver: a stable random number for (a, b), a seeded generator, glyph corruption
const hash = (a, b = 0) => {
  const v = Math.sin(a * 127.1 + b * 311.7 + 17.3) * 43758.5453;
  return v - Math.floor(v);
};
function rng(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function corrupt(s, amt, step) {
  if (amt <= 0) return s;
  let o = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    o += ch !== ' ' && hash(i * 1.37, step * 0.71) < amt ? GLY[Math.floor(hash(i, step + 9) * GLY.length)] : ch;
  }
  return o;
}
const clamp01 = (v) => Math.max(0, Math.min(1, v));

// Her picture, fitted to the screen, in three copies: as she is, all red, all cyan.
function tinted(image, w, h) {
  const fit = Math.max(w / image.width, (h * 0.9) / image.height);
  const dw = Math.round(image.width * fit), dh = Math.round(image.height * fit);
  const copy = (fill) => {
    const c = document.createElement('canvas');
    c.width = dw;
    c.height = dh;
    const g = c.getContext('2d');
    g.drawImage(image, 0, 0, dw, dh);
    if (fill) {
      g.globalCompositeOperation = 'source-in';
      g.fillStyle = fill;
      g.fillRect(0, 0, dw, dh);
    }
    return c;
  };
  return { base: copy(null), red: copy(COLORS.red), cyan: copy(CYAN), x: Math.round((w - dw) / 2), y: Math.round((h - dh) / 2), w: dw, h: dh };
}

// The edges of the screen crackling (fx.js screenEdges), new runs every `seed`.
function edges(ctx, w, h, seed) {
  let i = 0;
  const r = (a, b) => a + hash(i++, seed) * (b - a);
  const runs = (horizontal, fixed, len) => {
    for (let p = r(-60, 0); p < len; p += r(70, 230)) {
      const l = r(50, 190), t = r(4, 9);
      const [x, y, rw, rh] = horizontal ? [p, fixed, l, t] : [fixed, p, t, l];
      ctx.fillStyle = COLORS.violet;
      ctx.fillRect(x + 3, y + 3, rw, rh);
      ctx.fillStyle = COLORS.red;
      ctx.fillRect(x, y, rw, rh);
    }
  };
  runs(true, 0, w);
  runs(true, h - 9, w);
  runs(false, 0, h);
  runs(false, w - 9, h);
}

// Glitch bars (the screensaver's bars()): black slabs and bright ones added on top, pixel clusters.
function bars(ctx, w, h, k, seed) {
  const r = rng(seed * 977 + 1);
  const n = Math.floor(2 + k * 16);
  for (let i = 0; i < n; i++) {
    const y = r() * h, bh = 2 + r() * r() * 46, x = r() * w * 0.6 - w * 0.1, bw = w * (0.2 + r() * 0.9);
    const t = r();
    ctx.globalCompositeOperation = t < 0.45 ? 'source-over' : 'lighter';
    ctx.fillStyle = t < 0.3 ? 'rgba(0,0,0,.88)' : BAR_COLS[Math.floor(r() * BAR_COLS.length)];
    ctx.globalAlpha = t < 0.3 ? 1 : 0.35 + r() * 0.5;
    ctx.fillRect(x, y, bw, bh);
    if (r() < 0.3) {
      const bs = 6 + r() * 14;
      for (let j = 0; j < 8; j++) ctx.fillRect(x + r() * bw, y + (r() - 0.5) * 60, bs * (1 + r() * 3), bs);
    }
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
}

// Her close-up torn into bands, each knocked sideways, its red and cyan copies pulled apart.
function torn(ctx, pic, k, seed, alpha) {
  const r = rng(seed * 131 + 7);
  const split = 5 + k * 22;
  for (let y = 0; y < pic.h;) {
    const bh = Math.min(pic.h - y, 10 + r() * 90);
    const shove = r() < 0.35 ? (r() - 0.5) * 220 * k : (r() - 0.5) * 14;
    const dx = pic.x + shove, dy = pic.y + y;
    if (r() > 0.12) { // a few bands drop out entirely
      ctx.globalAlpha = alpha;
      ctx.globalCompositeOperation = 'lighter';
      ctx.drawImage(pic.red, 0, y, pic.w, bh, dx - split, dy, pic.w, bh);
      ctx.drawImage(pic.cyan, 0, y, pic.w, bh, dx + split, dy, pic.w, bh);
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = alpha * 0.82;
      ctx.drawImage(pic.base, 0, y, pic.w, bh, dx, dy, pic.w, bh);
    }
    y += bh;
  }
  ctx.globalAlpha = 1;
}

// "CAPRI ONLINE." on her red tag (fx.js hiTag), typed in, glyphs settling into letters, the
// letters themselves split red / cyan.
function tag(ctx, x, y, text, fs, step) {
  ctx.save();
  ctx.font = `600 ${fs}px "Chakra Petch", sans-serif`;
  const skew = fs * 0.32, th = fs * 1.18;
  const tw = Math.max(fs * 2, ctx.measureText(text).width + fs * 0.9 + skew);
  ctx.translate(x - tw / 2, y);
  const band = (dx, dy) => {
    ctx.beginPath();
    ctx.moveTo(skew + dx, -th / 2 + dy);
    ctx.lineTo(tw + dx, -th / 2 + dy);
    ctx.lineTo(tw - skew + dx, th / 2 + dy);
    ctx.lineTo(dx, th / 2 + dy);
    ctx.closePath();
  };
  const jolt = hash(step, 3) < 0.25 ? (hash(step, 4) - 0.5) * fs * 0.6 : 0;
  band(9 + jolt, 9);
  ctx.fillStyle = COLORS.violet;
  ctx.fill();
  band(jolt, 0);
  ctx.fillStyle = COLORS.ink;
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = COLORS.red;
  ctx.stroke();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const cx = tw / 2 + jolt, cy = fs * 0.04;
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = COLORS.red;
  ctx.fillText(text, cx - 4, cy);
  ctx.fillStyle = CYAN;
  ctx.fillText(text, cx + 4, cy);
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = COLORS.paper;
  ctx.fillText(text, cx, cy);
  ctx.restore();
}

// Runs the whole thing; resolves when the screen is yours again. onCue(name): 'open', 'face',
// 'tag', 'collapse' (for her sounds).
export function takeover({ image, w, h, ms = 2800, text = 'CAPRI ONLINE.', onCue = () => {} }) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.setAttribute('aria-hidden', 'true');
  Object.assign(canvas.style, { position: 'fixed', left: '0', top: '0', width: `${w}px`, height: `${h}px`, zIndex: '3', pointerEvents: 'none' });
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  const pic = image ? tinted(image, w, h) : null;
  const scan = document.createElement('canvas');
  scan.width = 1;
  scan.height = 3;
  const sg = scan.getContext('2d');
  sg.fillStyle = 'rgba(0,0,0,.35)';
  sg.fillRect(0, 0, 1, 1);
  const scanlines = ctx.createPattern(scan, 'repeat');
  const fs = Math.round(Math.min(96, Math.max(44, w / 22)));
  const said = new Set();
  const cue = (name) => {
    if (said.has(name)) return;
    said.add(name);
    onCue(name);
  };

  return new Promise((done) => {
    const start = performance.now();
    let last = 0;
    const frame = (now) => {
      const t = (now - start) / ms;
      if (t >= 1) {
        canvas.remove();
        done();
        return;
      }
      requestAnimationFrame(frame);
      if (now - last < FRAME_MS - 2) return;
      last = now;
      const step = Math.floor((now - start) / FRAME_MS);
      ctx.clearRect(0, 0, w, h);

      // 1. it's coming: the edges crackle, a few bars, a flicker of dark
      if (t < 0.12) {
        cue('open');
        if (step % 2 === 0) {
          ctx.fillStyle = 'rgba(5,6,12,.22)';
          ctx.fillRect(0, 0, w, h);
        }
        edges(ctx, w, h, step);
        bars(ctx, w, h, 0.3, step);
        return;
      }
      // 3. gone: the picture squeezed down to a line, which shrinks to a dot
      if (t > 0.86) {
        cue('collapse');
        const k = clamp01((t - 0.86) / 0.14);
        const lh = Math.max(2, (h * 0.18) * Math.pow(1 - Math.min(1, k * 2), 3));
        const lw = w * (k < 0.5 ? 1 : 1 - (k - 0.5) * 2);
        const x = (w - lw) / 2, y = h / 2 - lh / 2;
        ctx.fillStyle = 'rgba(5,6,12,.35)';
        ctx.fillRect(0, y - lh * 2, w, lh * 5);
        ctx.fillStyle = COLORS.red;
        ctx.fillRect(x - 6, y - 3, lw, lh);
        ctx.fillStyle = CYAN;
        ctx.fillRect(x + 6, y + 3, lw, lh);
        ctx.fillStyle = COLORS.paper;
        ctx.fillRect(x, y, lw, lh);
        return;
      }
      // 2. hers: dark, scanlines, her face tearing through, bars, the tag
      const k = (t - 0.12) / 0.74;
      const spike = hash(step, 1) < 0.18 ? 1 : 0;
      const g = 0.35 + 0.4 * Math.sin(k * Math.PI) + spike * 0.4;
      ctx.fillStyle = `rgba(5,6,12,${(0.38 + spike * 0.2).toFixed(2)})`;
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = scanlines;
      ctx.fillRect(0, 0, w, h);
      // her face comes and goes: on most drawings, off on some, never for long
      if (pic && hash(step, 2) > 0.22) {
        cue('face');
        torn(ctx, pic, Math.min(1, g), step, k < 0.08 ? 0.5 : 0.9);
      }
      bars(ctx, w, h, Math.min(1, g), step + 100);
      if (spike || step % 6 === 0) edges(ctx, w, h, step);
      if (k > 0.3) {
        cue('tag');
        const typed = Math.min(text.length, Math.ceil(((k - 0.3) / 0.25) * text.length));
        const shown = corrupt(text.slice(0, typed), Math.max(0, 0.6 - (k - 0.3) * 1.6), step);
        tag(ctx, w / 2, h * 0.78, shown, fs, step);
      }
    };
    requestAnimationFrame(frame);
  });
}
