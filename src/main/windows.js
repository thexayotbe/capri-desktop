'use strict';

// Feeds the overlay with the position of the other windows, so Capri can sit on them.
// Windows: a small PowerShell helper does the Win32 calls; we turn its physical pixels into the
// overlay's coordinates. It also says when the window in front is another AI (ChatGPT,
// Gemini…: `ai`, the names it matched), for her jealousy, and never passes on a title; which game
// is in front, if one (`game`, its folder in Steam's library or another launcher's); and the USB
// sticks plugged in (`usb`, drive letters), and the last device plugged in or out (`plug`).
// macOS: a small Swift helper (mac/capri-helper.swift) reads them from CGWindowList, already in
// points, and also says which app is in front.

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { spawn } = require('node:child_process');
const { app, screen } = require('electron');
const { isGame } = require('./appkind');

// in the installed app they sit next to the app archive (asarUnpack), where they can be run
const unpacked = (file) => file.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
const SCRIPT = unpacked(path.join(__dirname, 'windows.ps1'));
const HELPER = unpacked(path.join(__dirname, 'mac', 'capri-helper'));
const BUILD_HELPER = path.join(__dirname, '..', '..', 'scripts', 'build-mac-helper.js');

// Only what overlaps Capri's screen, in her window's coordinates.
function onHerScreen(wins, bounds) {
  return wins.filter((w) => w.x < bounds.width && w.x + w.w > 0 && w.y < bounds.height && w.y + w.h > 0);
}

function startWindowWatch({ overlay, onUpdate, onApp = () => {}, onSpace = () => {} }) {
  if (process.platform === 'darwin') return startMacWatch({ overlay, onUpdate, onApp, onSpace });
  if (process.platform !== 'win32') return { stop() {}, refresh() {} };

  let child = null;
  let stopped = false;
  let restarts = 0;
  let last = null; // the helper's last snapshot: it only speaks when something changes

  const handle = overlay.getNativeWindowHandle();
  const self = handle.length >= 8 ? handle.readBigUInt64LE(0) : BigInt(handle.readUInt32LE(0));

  const toOverlay = (win, bounds) => {
    const dip = screen.screenToDipRect(null, { x: win.x, y: win.y, width: win.w, height: win.h });
    return { id: win.id, x: dip.x - bounds.x, y: dip.y - bounds.y, w: dip.width, h: dip.height, max: win.max };
  };

  // the snapshot as seen from her window, wherever it is now
  const send = () => {
    if (!last || overlay.isDestroyed()) return;
    const bounds = overlay.getBounds();
    const wins = onHerScreen(last.wins.map((w) => toOverlay(w, bounds)), bounds);
    onUpdate({
      fg: last.fg, taskbar: Boolean(last.taskbar), ai: Array.isArray(last.ai) ? last.ai : [],
      game: last.game || null, usb: Array.isArray(last.usb) ? last.usb : [], plug: last.plug || null, wins,
    });
  };

  const start = () => {
    child = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', SCRIPT, String(self), String(process.pid),
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });

    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      try {
        last = JSON.parse(line);
      } catch {
        return;
      }
      send();
    });
    child.stderr.on('data', (d) => console.error('[capri] window watch:', String(d).trim()));
    child.on('exit', () => {
      child = null;
      if (!stopped && restarts++ < 3) setTimeout(start, 3000);
    });
  };

  start();
  return {
    stop() {
      stopped = true;
      child?.kill();
    },
    // her window moved (another screen, the taskbar in it or not): the same windows, from there
    refresh: send,
  };
}

// The helper, built from its source when running from a clone without it (or with an older one).
function macHelper() {
  const stale = () => {
    try {
      return fs.statSync(HELPER).mtimeMs < fs.statSync(path.join(__dirname, 'mac', 'capri-helper.swift')).mtimeMs;
    } catch {
      return !fs.existsSync(HELPER);
    }
  };
  if (app.isPackaged || !stale()) return Promise.resolve(fs.existsSync(HELPER) ? HELPER : null);
  console.log('[capri] building the macOS window helper (swiftc)…');
  return new Promise((resolve) => {
    const build = spawn(process.execPath, [BUILD_HELPER], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'inherit', 'inherit'],
    });
    build.on('error', () => resolve(null));
    build.on('exit', (code) => resolve(code === 0 || fs.existsSync(HELPER) ? HELPER : null));
  });
}

// Zoomed (the green button with Option, or a double-click on the title bar) or full screen: its
// display's work area or more.
function isMax(win) {
  if (win.fs) return true;
  const { workArea: a } = screen.getDisplayMatching({ x: win.x, y: win.y, width: win.w, height: win.h });
  return win.x <= a.x + 4 && win.y <= a.y + 4 && win.x + win.w >= a.x + a.width - 4 && win.y + win.h >= a.y + a.height - 4;
}

// The other AIs' own Mac apps, by name or bundle id (their keys as in bond.js RIVALS), for her
// jealousy. No window titles on macOS (that needs Screen Recording): one in a browser tab goes unseen.
const MAC_AIS = [
  ['chatgpt', /chatgpt|^com\.openai\.chat/i],
  ['claude', /^claude$|^com\.anthropic\.claudefordesktop/i],
  ['codex', /codex/i],
  ['gemini', /gemini/i],
  ['copilot', /copilot/i],
  ['perplexity', /perplexity/i],
  ['deepseek', /deepseek/i],
  ['grok', /grok/i],
  ['lechat', /^le chat$|mistral/i],
];
const PLUG_WAIT = 2500; // a USB device: this long to see whether it's a disk (it mounts), not a device

// The same data windows.ps1 gives on Windows, from the helper: the AI or game in front, the external
// disks mounted (`usb`, by name, gone once their folder is), the last USB device plugged in (`plug`).
function startMacWatch({ overlay, onUpdate, onApp, onSpace }) {
  let child = null;
  let stopped = false;
  let restarts = 0;
  let last = null; // the helper's last window list
  let front = { ai: [], game: null };
  let disks = []; // [{ name, path }]
  let plug = null;
  let plugs = 0;
  let mountAt = -Infinity;

  const toOverlay = (win, bounds) => ({
    id: win.id, x: win.x - bounds.x, y: win.y - bounds.y, w: win.w, h: win.h, max: isMax(win), owner: win.owner, pid: win.pid,
  });

  // the last window list as seen from her window, wherever it is now
  const send = () => {
    if (!last || overlay.isDestroyed()) return;
    disks = disks.filter((d) => fs.existsSync(d.path)); // ejected
    const bounds = overlay.getBounds();
    const wins = onHerScreen(last.wins.map((w) => toOverlay(w, bounds)), bounds);
    onUpdate({ fg: last.fg, taskbar: false, ai: front.ai, game: front.game, usb: disks.map((d) => d.name), plug, wins });
  };

  const onLine = (line) => {
    let msg;
    try {
      msg = typeof line === 'string' ? JSON.parse(line) : line;
    } catch {
      return;
    }
    if (overlay.isDestroyed() || !msg) return;
    if (msg.t === 'app') {
      const evt = { name: msg.name || '', bundleId: msg.bundleId || '', pid: msg.pid, fullscreen: Boolean(msg.fullscreen) };
      front = {
        ai: MAC_AIS.filter(([, re]) => re.test(evt.name) || re.test(evt.bundleId)).map(([key]) => key),
        game: isGame(evt) ? evt.name : null,
      };
      onApp(evt);
      send();
    } else if (msg.t === 'space') onSpace();
    else if (msg.t === 'mount') {
      mountAt = Date.now();
      if (msg.path && !disks.some((d) => d.path === msg.path)) disks.push({ name: msg.name || msg.path, path: msg.path });
      send();
    } else if (msg.t === 'usb') {
      // a hub or a dock shows up as several devices at once: the first one
      const n = ++plugs;
      const at = Date.now();
      setTimeout(() => {
        if (n !== plugs) return;
        const disk = mountAt >= at - 3000; // it mounted: a USB stick, seen as one (`usb`) instead
        plug = { n, name: msg.name || '', class: disk ? 'Volume' : '', in: true };
        send();
      }, PLUG_WAIT);
    } else if (msg.t === 'wins') {
      last = msg;
      send();
    }
  };

  const start = (helper) => {
    if (stopped) return;
    // stdin stays open: the helper quits when it closes, Capri gone
    child = spawn(helper, [String(process.pid)], { stdio: ['pipe', 'pipe', 'pipe'] });
    readline.createInterface({ input: child.stdout }).on('line', onLine);
    child.stderr.on('data', (d) => console.error('[capri] window watch:', String(d).trim()));
    child.on('error', (err) => console.error('[capri] window watch:', err.message));
    child.on('exit', () => {
      child = null;
      if (!stopped && restarts++ < 3) setTimeout(() => start(helper), 3000);
    });
  };

  macHelper().then((helper) => {
    if (helper) start(helper);
    else console.error('[capri] no macOS window helper: run `npm run build:mac-helper` (needs Xcode command line tools)');
  });
  return {
    stop() {
      stopped = true;
      child?.kill();
    },
    refresh: send,
    // --dev: as if the helper said it ({ t: 'app' | 'usb' | 'mount' | 'space', ... })
    inject: onLine,
  };
}

module.exports = { startWindowWatch };
