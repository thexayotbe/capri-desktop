// Capri's spoken lines: the voice pack in assets/voice (tools/voice makes it), one clip per reaction key.
// Asked for from anywhere in the renderer with
//   document.dispatchEvent(new CustomEvent('capri:say', { detail: { key: 'claude-done' } }))
// or from the main process with the IPC 'capri:say' { key }. Unknown keys, or no pack, do nothing.
// She never says the same take twice in a row, keeps quiet between lines (her chattiness), lets the
// important ones cut in, skips her synth blips while she speaks and nods along (the 'talk' act).

import { pick, rand } from './util.js';

const PACK = '../../assets/voice/';

// these may cut in on whatever she's saying, and get through even when she's quiet
export const PRIORITY = new Set(['claude-needs-you', 'claude-done', 'hello']);
// her reflexes (grabbed, thrown...): they cut in on idle chatter and don't wait for the gap
export const REFLEX = new Set(['grabbed', 'thrown', 'caught', 'angry', 'crash-wall', 'window-fall', 'zap-cursor']);
// ...and of those, the impacts: they cut in on another reflex too (grabbed, then slammed into a wall)
export const IMPACT = new Set(['crash-wall', 'caught']);

// tray › Voice › Chattiness: the least time between two lines, the chance an ordinary line is said
// at all, and how long before the same key may come back
const CHATTINESS = {
  quiet: { gap: 20000, chance: 0.35, again: 90000 },
  normal: { gap: 6000, chance: 0.85, again: 25000 },
  chatty: { gap: 3500, chance: 1, again: 10000 },
};

export class Speech {
  constructor({ voice, capri = null }) {
    this.voice = voice;   // her synth (voice.js): its AudioContext, and its blips to skip
    this.capri = capri;   // for the talk act while she speaks
    this.on = true;
    this.volume = 0.8;
    this.muted = false;   // the global Mute (tray › Sound)
    this.chattiness = 'normal';
    this.lines = null;    // key -> [{ file, text }]
    this.buffers = new Map(); // file -> Promise<AudioBuffer>
    this.last = new Map();    // key -> index of the take said last
    this.saidAt = new Map();  // key -> when
    this.lastLine = -Infinity;
    this.lastReflex = -Infinity;
    this.current = null;      // { key, src, gain, ends }
    this.gain = null;
    this.ready = this.load();
    document.addEventListener('capri:say', (e) => this.say(e.detail?.key, e.detail));
  }

  async load() {
    try {
      this.lines = await (await fetch(PACK + 'lines.json')).json();
    } catch (err) {
      console.warn('[capri] no voice pack', err?.message || err);
      this.lines = {};
    }
  }

  configure({ voice, voiceVolume, chattiness, muted }) {
    if (typeof voice === 'boolean') this.on = voice;
    if (typeof muted === 'boolean') this.muted = muted;
    if (typeof voiceVolume === 'number') this.volume = voiceVolume;
    if (CHATTINESS[chattiness]) this.chattiness = chattiness;
    if (this.gain) this.gain.gain.value = this.volume;
    if ((!this.on || this.muted) && this.current) this.stop();
  }

  get speaking() {
    return Boolean(this.current);
  }

  buffer(file) {
    if (!this.buffers.has(file)) {
      const ctx = this.voice.ensure();
      const p = fetch(PACK + file).then((r) => r.arrayBuffer()).then((data) => ctx.decodeAudioData(data));
      p.catch(() => this.buffers.delete(file)); // try again next time
      this.buffers.set(file, p);
    }
    return this.buffers.get(file);
  }

  // Whether `key` gets said now; force: no chattiness, gaps or chance (the --dev route, tests).
  allowed(key, force) {
    if (!this.on || this.muted) return 'off';
    const takes = this.lines?.[key];
    if (!takes?.length) return 'no lines';
    if (force) return '';
    const important = PRIORITY.has(key);
    const c = CHATTINESS[this.chattiness];
    const now = performance.now();
    const capri = this.capri;
    // put away in her biochip or asleep down to her mask: only what matters (and waking up)
    if (capri && (capri.stowed || capri.dormant) && !important && key !== 'wake') return 'away';
    // mid-line: only an important line cuts in (a reflex, on idle chatter), never the same one again
    const reflex = REFLEX.has(key);
    const impact = IMPACT.has(key);
    const cur = this.current?.key;
    if (cur) {
      const cuts = important || (!PRIORITY.has(cur) && (impact || (reflex && !REFLEX.has(cur))));
      if (cur === key || !cuts) return 'speaking';
    }
    if (important) return '';
    // a reflex waits only for the reflex before it (idle chatter doesn't hold it back), an impact not at all
    if (reflex ? !impact && now - this.lastReflex < 1500 : now - this.lastLine < c.gap) return 'too soon';
    if (now - (this.saidAt.get(key) ?? -Infinity) < c.again) return 'said lately';
    if (Math.random() > c.chance) return 'let it go';
    return '';
  }

  async say(key, { force = false } = {}) {
    if (!key) return false;
    if (!this.lines) await this.ready;
    const no = this.allowed(key, force);
    if (no) {
      if (no !== 'no lines' || this.lines?.[key]) console.log(`[capri] say ${key}: skipped (${no})`);
      return false;
    }
    const takes = this.lines[key];
    // a take that wasn't just said
    const prev = this.last.get(key);
    const choices = takes.map((_, i) => i).filter((i) => takes.length < 2 || i !== prev);
    const index = pick(choices);
    this.last.set(key, index);
    const now = performance.now();
    this.lastLine = now;
    if (REFLEX.has(key)) this.lastReflex = now;
    this.saidAt.set(key, now);
    const take = takes[index];
    let buf;
    try {
      buf = await this.buffer(take.file);
    } catch (err) {
      console.warn('[capri] could not load line', take.file, err?.message || err);
      return false;
    }
    if (!this.on || this.muted) return false;
    if (this.current) this.stop(0.06); // a more important line cuts in
    const ctx = this.voice.ensure();
    if (ctx.state === 'suspended') ctx.resume();
    if (!this.gain) {
      this.gain = ctx.createGain();
      this.gain.gain.value = this.volume;
      this.gain.connect(ctx.destination);
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    src.connect(g).connect(this.gain);
    const line = { key, src, gain: g, file: take.file };
    this.current = line;
    this.voice.hushBlips = true;
    src.onended = () => {
      if (this.current !== line) return;
      this.current = null;
      this.voice.hushBlips = false;
    };
    src.start();
    console.log(`[capri] say ${key}: ${take.file} "${take.text}" (${buf.duration.toFixed(2)} s, ctx ${ctx.state})`);
    this.nod(line);
    return true;
  }

  // her little nods as the words come out, if nothing bigger is going on: a few, with gaps, so
  // whatever checks she's free (a zap, a look at the satellite) still gets its turn
  async nod(line) {
    const capri = this.capri;
    if (!capri) return;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let n = 0; n < 3 && this.current === line; n++) {
      if (!capri.act && !capri.busy && !capri.dragging && capri.stance !== 'fall') await capri.perform('talk');
      await wait(rand(300, 700));
    }
  }

  stop(fade = 0.04) {
    const line = this.current;
    if (!line) return;
    this.current = null;
    this.voice.hushBlips = false;
    const t = this.voice.ctx.currentTime;
    line.gain.gain.setValueAtTime(line.gain.gain.value, t);
    line.gain.gain.linearRampToValueAtTime(0, t + fade);
    line.src.stop(t + fade + 0.01);
  }
}

// A voice line by key, from anywhere: the 'capri:say' event (harmless if nobody listens, or no page: the tests).
export const say = (key) => globalThis.document?.dispatchEvent(new CustomEvent('capri:say', { detail: { key } }));
