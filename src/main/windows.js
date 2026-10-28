'use strict';

// Feeds the overlay with the position of the other windows, so Capri can sit on them.
// Windows: a small PowerShell helper does the Win32 calls; we turn its physical pixels into the
// overlay's coordinates. macOS: a small Swift helper (mac/capri-helper.swift) reads them from
// CGWindowList, already in points, and also says which app is in front.

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { spawn } = require('node:child_process');
const { app, screen } = require('electron');

// in the installed app they sit next to the app archive (asarUnpack), where they can be run
const unpacked = (file) => file.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
const SCRIPT = unpacked(path.join(__dirname, 'windows.ps1'));
const HELPER = unpacked(path.join(__dirname, 'mac', 'capri-helper'));
const BUILD_HELPER = path.join(__dirname, '..', '..', 'scripts', 'build-mac-helper.js');

// Only what overlaps Capri's screen, in her window's coordinates.
function onHerScreen(wins, bounds) {
  return wins.filter((w) => w.x < bounds.width && w.x + w.w > 0 && w.y < bounds.height && w.y + w.h > 0);
}

function startWindowWatch({ overlay, onUpdate, onApp = () => {}, onSpace = () => {}, onOther = () => {} }) {
  if (process.platform === 'darwin') return startMacWatch({ overlay, onUpdate, onApp, onSpace, onOther });
  if (process.platform !== 'win32') return { stop() {} };

  let child = null;
  let stopped = false;
  let restarts = 0;

  const handle = overlay.getNativeWindowHandle();
  const self = handle.length >= 8 ? handle.readBigUInt64LE(0) : BigInt(handle.readUInt32LE(0));

  const toOverlay = (win, bounds) => {
    const dip = screen.screenToDipRect(null, { x: win.x, y: win.y, width: win.w, height: win.h });
    return { id: win.id, x: dip.x - bounds.x, y: dip.y - bounds.y, w: dip.width, h: dip.height, max: win.max };
  };

  const start = () => {
    child = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', SCRIPT, String(self), String(process.pid),
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });

    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      let snap;
      try {
        snap = JSON.parse(line);
      } catch {
        return;
      }
      if (overlay.isDestroyed()) return;
      const bounds = overlay.getBounds();
      const wins = onHerScreen(snap.wins.map((w) => toOverlay(w, bounds)), bounds);
      onUpdate({ fg: snap.fg, taskbar: Boolean(snap.taskbar), wins });
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

function startMacWatch({ overlay, onUpdate, onApp, onSpace, onOther }) {
  let child = null;
  let stopped = false;
  let restarts = 0;

  const toOverlay = (win, bounds) => ({
    id: win.id, x: win.x - bounds.x, y: win.y - bounds.y, w: win.w, h: win.h, max: isMax(win), owner: win.owner, pid: win.pid,
  });

  const onLine = (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (overlay.isDestroyed()) return;
    if (msg.t === 'app') onApp({ name: msg.name, bundleId: msg.bundleId, pid: msg.pid, fullscreen: Boolean(msg.fullscreen) });
    else if (msg.t === 'space') onSpace();
    else if (msg.t === 'quit' || msg.t === 'usb' || msg.t === 'mount') onOther(msg); // apps quitting, devices, disks
    else if (msg.t === 'wins') {
      const bounds = overlay.getBounds();
      const wins = onHerScreen(msg.wins.map((w) => toOverlay(w, bounds)), bounds);
      onUpdate({ fg: msg.fg, taskbar: false, wins });
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
  };
}

module.exports = { startWindowWatch };
