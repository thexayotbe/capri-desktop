'use strict';

// Her life on the Mac: what she feels of your computer, sent to the overlay.
//   'capri:music' { playing, app, track, artist } | { denied: true, app }
//   'capri:pc'    { key, ... }: charger-in | charger-out | battery-low (percent) | net-down | net-up |
//                 cpu-hot (load) | game-start (app) | game-end (app) | usb-in (name) | device-in (name)
// The app in front itself ('capri:app-switch') comes from the window watch's helper (windows.js);
// main.js hands its app switches, quits, USB devices and disks to frontApp() / helperEvent() here.

const os = require('node:os');
const readline = require('node:readline');
const { spawn, execFile } = require('node:child_process');
const { powerMonitor, net } = require('electron');

const { isGame } = require('./appkind');

const MAC = process.platform === 'darwin';
const GAME_AGAIN = 10 * 60000; // the same game coming back to the front: game-start again only after this
const USB_HUSH = 8000; // a USB stick: its disk showing up right after isn't another device

// ---------- small osascript (JXA) watcher, one long-lived process ----------

// Spotify and Music, every 2 s, only when they're already running (an Apple event to an app that
// isn't would launch it). The first time, macOS asks whether Capri may control them; a no is
// remembered until she's restarted.
const MUSIC_WATCH = `
ObjC.import('AppKit'); ObjC.import('unistd');
function run() {
  const players = [['com.spotify.client', 'Spotify'], ['com.apple.Music', 'Music']];
  const denied = {};
  let last = '';
  for (;;) {
    $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(2));
    if ($.getppid() === 1) return;
    let now = { playing: false };
    for (const [id, name] of players) {
      if (denied[id] || $.NSRunningApplication.runningApplicationsWithBundleIdentifier(id).count === 0) continue;
      try {
        const p = Application(id);
        if (!p.running()) continue; // quit since the check above: asking it anything would launch it again
        if (p.playerState() !== 'playing') continue;
        let track = '', artist = '';
        try { track = p.currentTrack.name(); artist = p.currentTrack.artist(); } catch (e) {}
        now = { playing: true, app: name, track: track, artist: artist };
        break;
      } catch (e) {
        if (e.errorNumber === -1743 || /-1743|not allowed|not authori/i.test(String(e))) {
          denied[id] = true;
          console.log(JSON.stringify({ denied: true, app: name }));
        }
      }
    }
    const key = JSON.stringify(now);
    if (key !== last) { last = key; console.log(key); }
  }
}`;

function jxa(script, args, onLine) {
  let child = null;
  let stopped = false;
  let restarts = 0;
  const start = () => {
    child = spawn('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script, ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    // JXA's console.log writes to stderr
    readline.createInterface({ input: child.stderr }).on('line', (line) => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        if (line.trim()) console.error('[capri] mac watch:', line.trim());
        return;
      }
      onLine(msg);
    });
    child.on('exit', () => {
      child = null;
      if (!stopped && restarts++ < 5) setTimeout(() => !stopped && start(), 5000);
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

// ---------- the charger, the battery, the network, the CPU ----------

function batteryPercent() {
  return new Promise((resolve) => {
    execFile('/usr/bin/pmset', ['-g', 'batt'], { timeout: 4000 }, (err, out) => {
      const m = !err && /(\d+)%/.exec(String(out));
      resolve(m ? Number(m[1]) : null);
    });
  });
}

function watchPc(send) {
  const timers = [];
  // the charger: powerMonitor's events (macOS and Windows), checked against the state so a resume doesn't repeat one
  let onBattery = powerMonitor.isOnBatteryPower();
  let lowSaid = false;
  const power = (battery) => {
    if (battery === onBattery) return;
    onBattery = battery;
    if (!battery) lowSaid = false;
    send({ key: battery ? 'charger-out' : 'charger-in' });
  };
  powerMonitor.on('on-ac', () => power(false));
  powerMonitor.on('on-battery', () => power(true));
  // the battery, every minute while on it (pmset, a Mac's own tool)
  if (MAC) {
    timers.push(setInterval(async () => {
      power(powerMonitor.isOnBatteryPower());
      if (!onBattery) return;
      const percent = await batteryPercent();
      if (percent === null) return;
      if (percent > 25) lowSaid = false;
      if (percent <= 15 && !lowSaid) {
        lowSaid = true;
        send({ key: 'battery-low', percent });
      }
    }, 60000));
  }
  // the network: twice the same answer before she says anything (Wi-Fi hiccups)
  let online = net.isOnline();
  let seen = online;
  timers.push(setInterval(() => {
    const now = net.isOnline();
    if (now === seen && now !== online) {
      online = now;
      send({ key: now ? 'net-up' : 'net-down' });
    }
    seen = now;
  }, 10000));
  // the CPU: the 1-minute load over the number of cores (always 0 on Windows: nothing there)
  if (process.platform !== 'win32') {
    const cores = os.cpus().length || 1;
    let hotSince = 0;
    let armed = true;
    timers.push(setInterval(() => {
      const load = os.loadavg()[0] / cores;
      if (load < 0.5) armed = true;
      if (load < 0.9) {
        hotSince = 0;
        return;
      }
      hotSince ||= Date.now();
      if (armed && Date.now() - hotSince > 45000) {
        armed = false;
        send({ key: 'cpu-hot', load: Math.round(load * 100) });
      }
    }, 15000));
  }
  return { stop: () => timers.forEach(clearInterval) };
}

// ---------- her menu ----------

const LABELS = {
  fr: { possessNow: 'Posséder l’écran', takeovers: 'Prendre l’écran de temps en temps', music: 'Danser sur ma musique' },
  en: { possessNow: 'Possess the screen', takeovers: 'Take over the screen now and then', music: 'Dance to my music' },
  es: { possessNow: 'Poseer la pantalla', takeovers: 'Tomar la pantalla de vez en cuando', music: 'Bailar con mi música' },
  pt: { possessNow: 'Possuir a tela', takeovers: 'Tomar a tela de vez em quando', music: 'Dançar com a minha música' },
  ru: { possessNow: 'Захватить экран', takeovers: 'Иногда захватывать экран', music: 'Танцевать под мою музыку' },
};

// ---------- wiring ----------

let state = null;

// overlay: () => her BrowserWindow; config: { load, save }
function startMacLife({ overlay, config }) {
  const send = (channel, payload) => {
    const win = overlay();
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  };
  state = { overlay, config, send, music: null, pc: null, game: null, games: new Map(), usbAt: -Infinity };
  state.pc = watchPc((payload) => send('capri:pc', payload));
  refreshMusic();
  return { stop: stopMacLife };
}

// The app in front changed (main.js, from the helper): a game coming up starts one.
function frontApp(evt) {
  if (!state || !evt || !isGame(evt)) return;
  const id = evt.bundleId || evt.name;
  if (state.game?.id === id) return;
  const now = Date.now();
  const again = now - (state.games.get(id) || -Infinity) < GAME_AGAIN;
  state.game = { id, name: evt.name };
  state.games.set(id, now);
  if (!again) state.send('capri:pc', { key: 'game-start', app: evt.name });
}

// The helper's other news: { t: 'quit' | 'usb' | 'mount', name, bundleId? }
function helperEvent(msg) {
  if (!state || !msg) return;
  if (msg.t === 'quit') {
    if (state.game && state.game.id === (msg.bundleId || msg.name)) {
      state.send('capri:pc', { key: 'game-end', app: state.game.name });
      state.game = null;
    }
  } else if (msg.t === 'usb') {
    // a device with several parts (a hub, a dock) shows up several times at once
    const now = Date.now();
    if (now - state.usbAt > 3000) state.send('capri:pc', { key: 'usb-in', name: msg.name });
    state.usbAt = now;
  } else if (msg.t === 'mount') {
    if (Date.now() - state.usbAt > USB_HUSH) state.send('capri:pc', { key: 'device-in', name: msg.name });
  }
}

function refreshMusic() {
  if (!state) return;
  const wanted = MAC && state.config.load().macMusic !== false;
  if (wanted && !state.music) {
    state.music = jxa(MUSIC_WATCH, [], (msg) => {
      console.log('[capri] music', JSON.stringify(msg)); // only when it changes
      state.send('capri:music', msg);
    });
  } else if (!wanted && state.music) {
    state.music.stop();
    state.music = null;
    state.send('capri:music', { playing: false });
  }
}

function stopMacLife() {
  if (!state) return;
  state.music?.stop();
  state.pc?.stop();
  state = null;
}

// Her menu's action: possess the screen now (with Teleport, Satellite...).
function trayActions(lang, { command }) {
  const t = LABELS[lang] || LABELS.en;
  return [{ label: t.possessNow, click: () => command('possessScreen') }];
}

// Her menu's toggles for all this. `lang`: resolved; `command(name)`: to the overlay; `update(patch)`: her config.
function trayItems(lang, { command, update }) {
  const t = LABELS[lang] || LABELS.en;
  const cfg = state?.config.load() || {};
  return [
    { label: t.takeovers, type: 'checkbox', checked: cfg.screenPossess !== false, click: (item) => update({ screenPossess: item.checked }) },
    ...(MAC ? [{
      label: t.music,
      type: 'checkbox',
      checked: cfg.macMusic !== false,
      click: (item) => {
        update({ macMusic: item.checked });
        refreshMusic();
      },
    }] : []),
  ];
}

module.exports = { startMacLife, stopMacLife, trayActions, trayItems, frontApp, helperEvent };
