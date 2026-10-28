#!/usr/bin/env node
// Turns Capri's raw ElevenLabs takes (tools/voice/raw/<key>/NN.mp3, from tts.sh) into her construct
// voice, the same chain as the capri-virus-saver soundtrack (tools/soundtrack/score.js): a word-level
// stutter (from the take's character timings), a chorus of minds (detuned and octave layers), a little
// ring mod and bit/sample-rate crush, EQ and a short reverb. Then each clip is brought to about
// -16 LUFS with a true peak <= -1 dBTP and encoded mono 48 kHz Opus into assets/voice/<key>/NN.ogg,
// with the manifest assets/voice/lines.json (key -> [{ file, text }]).
// Needs ffmpeg (with libopus). Usage: node tools/voice/process.mjs [key ...]
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RAW = path.join(ROOT, 'tools/voice/raw');
const OUT = path.join(ROOT, 'assets/voice');
const SR = 48000;
const TARGET_I = -16, TARGET_TP = -1.0, BITRATE = '40k';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'capri-voice-'));
const src = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/voice/lines.json'), 'utf8'));
const only = process.argv.slice(2);

// per-key flavour on top of the usual chain
const FLAVOUR = {
  'battery-low': { sag: 0.8 },               // the tape slowing down: she runs out of juice
  'net-down': { radio: true },                // a thin, far-away line
  'late-night': { radio: true, wet: 0.3 },
  'satellite': { wet: 0.32 },
  'angry': { deep: 0.55 },                    // the low mind comes forward
  'screen-possess': { deep: 0.5, crush: 0.3 },
  'possess-window': { deep: 0.4 },
  'claude-error': { crush: 0.32 },
  'cpu-hot': { crush: 0.3 },
};

// ---------------------------------------------------------------- small helpers
function rng(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const hashStr = (s) => { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; };

function decode(file) {
  const pcm = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-ar', String(SR), '-ac', '1', '-f', 'f32le', '-'], { maxBuffer: 1 << 28 });
  return new Float32Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength));
}

function wav(file, x) { // mono 32-bit float
  const data = Buffer.alloc(x.length * 4);
  for (let i = 0; i < x.length; i++) data.writeFloatLE(x[i], i * 4);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12); h.writeUInt32LE(16, 16);
  h.writeUInt16LE(3, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(SR, 24); h.writeUInt32LE(SR * 4, 28); h.writeUInt16LE(4, 32); h.writeUInt16LE(32, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([h, data]));
}

function loud(file) { // integrated loudness + true peak, from ffmpeg's ebur128
  const r = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-af', 'ebur128=peak=true:framelog=quiet', '-f', 'null', '-'], { encoding: 'utf8' });
  const e = r.stderr;
  return { I: +e.match(/I:\s+(-?[\d.]+|-inf) LUFS/)[1], TP: +e.match(/True peak:\s+Peak:\s+(-?[\d.]+|-inf) dBFS/)[1] };
}

// ---------------------------------------------------------------- the chain (ported from score.js)
function pitchShift(x, ratio, win = 0.05) { // two-tap delay-line shifter (keeps the length)
  const W = Math.round(win * SR), y = new Float32Array(x.length), inc = (1 - ratio) / W;
  let p = 0;
  const at = (i) => { const i0 = Math.floor(i), fr = i - i0; return i0 < 0 ? 0 : (x[i0] || 0) * (1 - fr) + (x[i0 + 1] || 0) * fr; };
  for (let n = 0; n < x.length; n++) {
    p += inc; p -= Math.floor(p);
    const p2 = (p + 0.5) % 1;
    y[n] = Math.sin(Math.PI * p) * at(n - p * W) + Math.sin(Math.PI * p2) * at(n - p2 * W);
  }
  return y;
}

function stutter(x, list) { // [[offset s, grain s, repeats]] -> the grain repeated, each repeat a bit more crushed
  if (!list.length) return x;
  const parts = []; let pos = 0;
  for (const [off, len, reps] of [...list].sort((a, b) => a[0] - b[0])) {
    const o = Math.round(off * SR), l = Math.round(len * SR);
    parts.push(x.subarray(pos, o));
    for (let r = 0; r < reps - 1; r++) {
      const g = x.slice(o, o + l), q = Math.pow(2, 7 - r * 1.5);
      for (let i = 0; i < g.length; i++) { const e = Math.min(1, i / 64, (g.length - i) / 64); g[i] = Math.round(g[i] * q) / q * e * (1 - r * 0.12); }
      parts.push(g);
    }
    pos = o;
  }
  parts.push(x.subarray(pos));
  const out = new Float32Array(parts.reduce((s, p) => s + p.length, 0)); let k = 0;
  for (const p of parts) { out.set(p, k); k += p.length; }
  return out;
}

function sag(x, end) { // variable-speed playback, the rate falling from 1 to `end`: pitch and tempo droop
  const out = []; let p = 0;
  while (p < x.length - 1) {
    const i0 = Math.floor(p), fr = p - i0;
    out.push(x[i0] * (1 - fr) + x[i0 + 1] * fr);
    p += 1 - (1 - end) * Math.pow(p / x.length, 0.8);
  }
  return Float32Array.from(out);
}

function biquad(x, type, f, q = Math.SQRT1_2, gainDb = 0) { // RBJ cookbook, in place
  const w = 2 * Math.PI * f / SR, c = Math.cos(w), s = Math.sin(w), al = s / (2 * q), A = Math.pow(10, gainDb / 40);
  let b0, b1, b2, a0, a1, a2;
  if (type === 'highpass') { b0 = (1 + c) / 2; b1 = -(1 + c); b2 = b0; a0 = 1 + al; a1 = -2 * c; a2 = 1 - al; }
  else if (type === 'lowpass') { b0 = (1 - c) / 2; b1 = 1 - c; b2 = b0; a0 = 1 + al; a1 = -2 * c; a2 = 1 - al; }
  else { b0 = 1 + al * A; b1 = -2 * c; b2 = 1 - al * A; a0 = 1 + al / A; a1 = -2 * c; a2 = 1 - al / A; } // peaking
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = (b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v; x[i] = v;
  }
  return x;
}

function makeIR(sec, decay, seed) { // filtered noise with a power decay and a 12 ms pre-delay (score.js), channel 0
  const n = Math.round(sec * SR), d = new Float32Array(n), r = rng(seed);
  let lp = 0;
  for (let i = 0; i < n; i++) { const x = r() * 2 - 1; lp += (x - lp) * (0.25 + 0.7 * Math.exp(-i / (SR * 0.05))); d[i] = lp * Math.pow(1 - i / n, decay) * (i < SR * 0.012 ? 0 : 1); }
  // what a ConvolverNode does to it (normalize = true): unit RMS power, then -58 dB, then 44.1k/SR
  let p = 0; for (const v of d) p += v * v;
  const k = 0.00125 / Math.sqrt(p / n) * (44100 / SR);
  for (let i = 0; i < n; i++) d[i] *= k;
  return d;
}
const IR = makeIR(1.5, 2.6, 5);

function fft(re, im, inv) { // iterative radix-2, in place
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (inv ? 2 : -2) * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
  if (inv) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}

function convolve(x, h) {
  let n = 1; while (n < x.length + h.length) n <<= 1;
  const ar = new Float64Array(n), ai = new Float64Array(n), br = new Float64Array(n), bi = new Float64Array(n);
  ar.set(x); br.set(h);
  fft(ar, ai, false); fft(br, bi, false);
  for (let i = 0; i < n; i++) { const r = ar[i] * br[i] - ai[i] * bi[i]; ai[i] = ar[i] * bi[i] + ai[i] * br[i]; ar[i] = r; }
  fft(ar, ai, true);
  return Float32Array.from(ar.subarray(0, x.length + h.length - 1));
}

function construct(x, stutters, fl) {
  x = stutter(x, stutters);
  if (fl.sag) x = sag(x, fl.sag);
  { let s = 0, n = 0; for (const v of x) if (Math.abs(v) > 0.01) { s += v * v; n++; } const g = 0.1 / Math.max(Math.sqrt(s / Math.max(1, n)), 1e-4); x = x.map((v) => v * g); }
  const pre = Math.round(0.03 * SR), len = x.length + pre + Math.round(1.6 * SR);
  const y = new Float32Array(len);
  const layers = [ // ratio, delay s, gain: the minds around her (mono: the stereo spread of score.js summed)
    [1, 0, 1], [Math.pow(2, -0.38 / 12), 0.013, 0.5], [Math.pow(2, 0.31 / 12), 0.022, 0.45],
    [0.5, 0.008, fl.deep ?? 0.26], [2, 0.017, 0.08],
  ];
  for (const [ratio, d, g] of layers) {
    const v = ratio === 1 ? x : pitchShift(x, ratio, ratio < 0.6 ? 0.07 : 0.045), o = pre + Math.round(d * SR);
    for (let i = 0; i < v.length; i++) y[o + i] += v[i] * g * 0.62; // ~ the summed gains back near unity
  }
  const radio = Boolean(fl.radio);
  const rm = radio ? 0.3 : 0.14, crush = fl.crush ?? (radio ? 0.5 : 0.22), bits = radio ? 6 : 8, hold = radio ? 4 : 3;
  { let h = 0; const q = Math.pow(2, bits - 1);
    for (let i = 0; i < len; i++) {
      const v = y[i], ring = v * (1 - rm) + v * Math.sin(2 * Math.PI * 290 * i / SR) * rm;
      if (i % hold === 0) h = Math.round(ring * q) / q;
      y[i] = ring * (1 - crush) + h * crush;
    } }
  biquad(y, 'highpass', radio ? 500 : 130);
  biquad(y, 'peaking', 3200, 0.8, 4);
  biquad(y, 'lowpass', radio ? 3400 : 10000);
  const wet = convolve(y, IR), wg = fl.wet ?? (radio ? 0.25 : 0.2);
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) out[i] = y[i] + wet[i] * wg;
  let end = len; while (end > 0 && Math.abs(out[end - 1]) < 1e-4) end--;
  const o = out.slice(0, end), fade = Math.min(o.length, Math.round(0.02 * SR));
  for (let i = 0; i < fade; i++) o[o.length - 1 - i] *= i / fade;
  return o;
}

// ---------------------------------------------------------------- loudness: gain + a look-ahead limiter
function limit(x, gainDb, ceilDb) {
  const g0 = Math.pow(10, gainDb / 20), ceil = Math.pow(10, ceilDb / 20), n = x.length;
  const LA = Math.round(0.0015 * SR), REL = 1 - Math.exp(-1 / (0.08 * SR));
  const req = new Float32Array(n);
  for (let i = 0; i < n; i++) { const p = Math.abs(x[i]) * g0; req[i] = p > ceil ? ceil / p : 1; }
  const mn = new Float32Array(n);
  for (let i = 0; i < n; i++) { let m = 1; for (let k = Math.max(0, i - LA); k <= Math.min(n - 1, i + LA); k++) if (req[k] < m) m = req[k]; mn[i] = m; }
  const out = new Float32Array(n); let gs = 1;
  for (let i = 0; i < n; i++) { gs = Math.min(mn[i], gs + (1 - gs) * REL); out[i] = x[i] * g0 * gs; }
  return out;
}

function encode(x, file) {
  const tmpWav = path.join(TMP, 'in.wav'), tmpDec = path.join(TMP, 'dec.wav');
  wav(tmpWav, x);
  const raw = loud(tmpWav);
  let gain = TARGET_I - raw.I, ceil = -1.8, m;
  for (let it = 0; it < 6; it++) {
    wav(tmpWav, limit(x, gain, ceil));
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', tmpWav, '-c:a', 'libopus', '-b:a', BITRATE, '-ar', String(SR), '-ac', '1', '-application', 'audio', '-map_metadata', '-1', file]);
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', file, '-ar', String(SR), '-c:a', 'pcm_f32le', tmpDec]);
    m = loud(tmpDec);
    const okI = Math.abs(m.I - TARGET_I) <= 0.5, okTP = m.TP <= TARGET_TP;
    if (okI && okTP) break;
    if (!okTP) ceil -= (m.TP - TARGET_TP) + 0.1;
    gain += TARGET_I - m.I;
  }
  return m;
}

// ---------------------------------------------------------------- word timings -> stutter points
function wordStarts(alignFile) {
  if (!fs.existsSync(alignFile)) return [];
  const a = JSON.parse(fs.readFileSync(alignFile, 'utf8')).alignment;
  if (!a?.characters) return [];
  const starts = []; let tag = false, prev = ' ';
  a.characters.forEach((ch, i) => {
    if (ch === '[') tag = true;
    if (!tag && /[\p{L}\p{N}]/u.test(ch) && !/[\p{L}\p{N}']/u.test(prev)) starts.push(a.character_start_times_seconds[i]);
    if (ch === ']') tag = false;
    prev = tag ? ' ' : ch;
  });
  return starts;
}

function leadingSilence(x, thresh = 0.0056) {
  let i = 0; while (i < x.length && Math.abs(x[i]) < thresh) i++;
  return Math.max(0, i - Math.round(0.02 * SR));
}
function trailingEnd(x, thresh = 0.0056) {
  let i = x.length; while (i > 0 && Math.abs(x[i - 1]) < thresh) i--;
  return Math.min(x.length, i + Math.round(0.05 * SR));
}

// ---------------------------------------------------------------- main
const manifest = fs.existsSync(path.join(OUT, 'lines.json')) ? JSON.parse(fs.readFileSync(path.join(OUT, 'lines.json'), 'utf8')) : {};
const report = [];
for (const [key, takes] of Object.entries(src.keys)) {
  if (only.length && !only.includes(key)) continue;
  const fl = FLAVOUR[key] || {};
  const entries = [];
  fs.mkdirSync(path.join(OUT, key), { recursive: true });
  takes.forEach((take, i) => {
    const nn = String(i + 1).padStart(2, '0');
    const mp3 = path.join(RAW, key, nn + '.mp3');
    if (!fs.existsSync(mp3)) { console.warn('missing take, skipped:', key, nn); return; }
    let x = decode(mp3);
    const lead = leadingSilence(x);
    x = x.slice(lead, trailingEnd(x));
    const words = wordStarts(path.join(RAW, key, nn + '.align.json')).map((t) => t - lead / SR).filter((t) => t > 0.02 && t < x.length / SR - 0.12);
    let stutters = [];
    if (Array.isArray(take.stutter)) stutters = take.stutter.filter(([w]) => words[w] !== undefined).map(([w, g, r]) => [words[w], g, r]);
    else {
      const r = rng(hashStr(key + nn));
      if (words.length && r() < 0.7) {
        // a hiccup on a word: the first one often, like the video's takes
        const w = r() < 0.5 ? 0 : Math.floor(r() * words.length);
        stutters.push([words[w], 0.06 + r() * 0.025, r() < 0.4 ? 3 : 2]);
      }
    }
    const y = construct(x, stutters, fl);
    const file = path.join(OUT, key, nn + '.ogg');
    const m = encode(y, file);
    const bytes = fs.statSync(file).size;
    entries.push({ file: `${key}/${nn}.ogg`, text: take.text.replace(/\[[^\]]*\]\s*/g, '').trim() });
    report.push({ clip: `${key}/${nn}`, s: (y.length / SR).toFixed(2), I: m.I, TP: m.TP, kb: (bytes / 1024).toFixed(1), stutter: stutters.length });
    console.log(`${key}/${nn}  ${(y.length / SR).toFixed(2)} s  I ${m.I} LUFS  TP ${m.TP} dBTP  ${(bytes / 1024).toFixed(1)} kB${stutters.length ? '  stutter' : ''}`);
  });
  if (entries.length) manifest[key] = entries;
}
const ordered = Object.fromEntries(Object.keys(src.keys).filter((k) => manifest[k]).map((k) => [k, manifest[k]]));
fs.writeFileSync(path.join(OUT, 'lines.json'), JSON.stringify(ordered, null, 1) + '\n');
fs.rmSync(TMP, { recursive: true, force: true });
const bad = report.filter((r) => r.TP > TARGET_TP || Math.abs(r.I - TARGET_I) > 1);
console.log(`${report.length} clips, ${report.reduce((s, r) => s + +r.kb, 0).toFixed(0)} kB${bad.length ? `, off target: ${bad.map((r) => r.clip).join(' ')}` : ', all on target'}`);
