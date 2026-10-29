'use strict';

// Her life on the Mac: the music you play, sent to the overlay, and her menu's entries for it.
//   'capri:music' { playing, app, track, artist } | { denied: true, app }
// The app in front ('capri:app-switch') comes from the window watch's helper (windows.js). What she
// feels of your computer (charger, battery, network, CPU, games, USB) is pc.js, on every platform:
// on macOS the helper's games, disks and devices reach it through the window watch's snapshot.

const readline = require('node:readline');
const { spawn } = require('node:child_process');

const MAC = process.platform === 'darwin';

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
  state = { overlay, config, send, music: null };
  refreshMusic();
  return { stop: stopMacLife };
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

module.exports = { startMacLife, stopMacLife, trayActions, trayItems };
