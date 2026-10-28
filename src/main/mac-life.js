'use strict';

// Her life on the Mac (behaviour stream): what she feels of your computer, sent to the overlay.
//   'capri:app-switch' { name, bundleId, category, fullscreen }   the app in front changed
//   'capri:music'      { playing, app, track, artist } | { denied: true, app }
//   'capri:pc'         { key: charger-in | charger-out | battery-low | net-down | net-up | cpu-hot, percent? }
// Music, the charger and the network work like this on any Mac; the app watch is a stand-in.
//
// OWN_APP_POLL: the platform stream sends 'capri:app-switch' itself (CONTRACT.md). Until that's merged,
// a little watcher here does (NSWorkspace through osascript, no permission needed). Set it to false
// (or run with CAPRI_APP_POLL=0) once platform's is in, so it isn't sent twice.

const os = require('node:os');
const readline = require('node:readline');
const { spawn, execFile } = require('node:child_process');
const { app, powerMonitor, net } = require('electron');

const MAC = process.platform === 'darwin';
const OWN_APP_POLL = MAC && process.env.CAPRI_APP_POLL !== '0';

// Several Capris side by side while testing (one per worktree): each its own settings and its own lock.
if (process.env.CAPRI_USER_DATA) app.setPath('userData', process.env.CAPRI_USER_DATA);

// ---------- what kind of app is in front ----------

const CATEGORY = {
  browser: [
    'com.apple.Safari', 'com.apple.SafariTechnologyPreview', 'com.google.Chrome', 'com.google.Chrome.canary',
    'org.chromium.Chromium', 'org.mozilla.firefox', 'org.mozilla.firefoxdeveloperedition', 'com.brave.Browser',
    'com.microsoft.edgemac', 'company.thebrowser.Browser', 'company.thebrowser.dia', 'com.operasoftware.Opera',
    'com.vivaldi.Vivaldi', 'app.zen-browser.zen', 'com.kagi.kagimacOS', 'org.torproject.torbrowser', 'com.openai.atlas',
  ],
  code: [
    'com.microsoft.VSCode', 'com.microsoft.VSCodeInsiders', 'com.todesktop.230313mzl4w4u92', 'com.exafunction.windsurf',
    'com.apple.dt.Xcode', 'dev.zed.Zed', 'dev.zed.Zed-Preview', 'com.sublimetext.4', 'com.sublimetext.3', 'com.panic.Nova',
    'com.apple.Terminal', 'com.googlecode.iterm2', 'dev.warp.Warp-Stable', 'com.mitchellh.ghostty', 'net.kovidgoyal.kitty',
    'io.alacritty', 'com.github.wez.wezterm', 'com.google.android.studio', 'com.t3tools.t3code', 'com.google.antigravity',
  ],
  chat: [
    'com.tinyspeck.slackmacgap', 'com.hnc.Discord', 'ru.keepcoder.Telegram', 'org.telegram.desktop', 'net.whatsapp.WhatsApp',
    'desktop.WhatsApp', 'com.apple.MobileSMS', 'com.microsoft.teams2', 'com.microsoft.teams', 'us.zoom.xos',
    'com.facebook.archon', 'org.whispersystems.signal-desktop', 'com.viber.osx', 'com.skype.skype', 'im.riot.app',
    'com.apple.FaceTime', 'com.anthropic.claudefordesktop', 'com.openai.chat',
  ],
};
const BY_NAME = [
  ['code', /\b(code|cursor|xcode|intellij|pycharm|webstorm|goland|rider|clion|android studio|zed|sublime|nova|terminal|iterm|warp|ghostty|kitty|alacritty|wezterm|vim|emacs)\b/i],
  ['browser', /\b(safari|chrome|chromium|firefox|brave|edge|arc|opera|vivaldi|zen|orion|browser)\b/i],
  ['chat', /\b(slack|discord|telegram|whatsapp|messages|teams|zoom|messenger|signal|viber|skype|element)\b/i],
];

function categorize(bundleId = '', name = '') {
  for (const [category, ids] of Object.entries(CATEGORY)) {
    if (ids.includes(bundleId)) return category;
  }
  if (/^com\.jetbrains\./.test(bundleId)) return 'code';
  for (const [category, re] of BY_NAME) {
    if (re.test(name)) return category;
  }
  return 'other';
}

// ---------- small osascript (JXA) watchers, one long-lived process each ----------

// The app in front, once a second, said only when it changes; and whether it covers a whole screen
// (window bounds need no permission, their titles would).
const APP_WATCH = `
ObjC.import('AppKit'); ObjC.import('CoreGraphics'); ObjC.import('unistd');
function fullscreen(pid) {
  try {
    const list = ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, $.kCGNullWindowID));
    const screens = $.NSScreen.screens;
    for (let i = 0; i < list.count; i++) {
      const w = list.objectAtIndex(i);
      if (w.objectForKey('kCGWindowOwnerPID').js !== pid || w.objectForKey('kCGWindowLayer').js !== 0) continue;
      const b = w.objectForKey('kCGWindowBounds');
      const ww = b.objectForKey('Width').js, wh = b.objectForKey('Height').js;
      for (let j = 0; j < screens.count; j++) {
        const f = screens.objectAtIndex(j).frame;
        if (ww >= f.size.width && wh >= f.size.height) return true;
      }
    }
  } catch (e) {}
  return false;
}
function run(argv) {
  const self = Number(argv[0]);
  const ws = $.NSWorkspace.sharedWorkspace;
  let lastKey = '';
  let lastFs = null;
  let n = 0;
  for (;;) {
    $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(1));
    if ($.getppid() === 1) return;
    const a = ws.frontmostApplication;
    if (!a || a.isNil()) continue;
    const pid = a.processIdentifier;
    if (pid === self) continue;
    const id = a.bundleIdentifier.isNil() ? '' : a.bundleIdentifier.js;
    const name = a.localizedName.isNil() ? '' : a.localizedName.js;
    // a new app in front; or every 5 s the same one again, in case it went fullscreen since
    const key = id + '|' + name;
    const changed = key !== lastKey;
    if (!changed && ++n % 5) continue;
    const fs = fullscreen(pid);
    if (!changed && fs === lastFs) continue;
    lastKey = key;
    lastFs = fs;
    n = 0;
    console.log(JSON.stringify({ name: name, bundleId: id, fullscreen: fs }));
  }
}`;

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
  state = { overlay, config, send, app: null, music: null, pc: null, lastApp: null };
  state.pc = watchPc((payload) => send('capri:pc', payload));
  if (OWN_APP_POLL) {
    state.app = jxa(APP_WATCH, [String(process.pid)], (msg) => {
      const evt = { name: msg.name, bundleId: msg.bundleId, category: categorize(msg.bundleId, msg.name), fullscreen: Boolean(msg.fullscreen) };
      state.lastApp = evt;
      send('capri:app-switch', evt);
    });
  }
  refreshMusic();
  return { stop: stopMacLife };
}

function refreshMusic() {
  if (!state) return;
  const wanted = MAC && state.config.load().macMusic !== false;
  if (wanted && !state.music) {
    state.music = jxa(MUSIC_WATCH, [], (msg) => state.send('capri:music', msg));
  } else if (!wanted && state.music) {
    state.music.stop();
    state.music = null;
    state.send('capri:music', { playing: false });
  }
}

function stopMacLife() {
  if (!state) return;
  state.app?.stop();
  state.music?.stop();
  state.pc?.stop();
  state = null;
}

// Her menu's entries for all this. `lang`: resolved; `command(name)`: to the overlay; `update(patch)`: her config.
function trayItems(lang, { command, update }) {
  const t = LABELS[lang] || LABELS.en;
  const cfg = state?.config.load() || {};
  return [
    { label: t.possessNow, click: () => command('possessScreen') },
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

module.exports = { startMacLife, stopMacLife, trayItems, categorize, OWN_APP_POLL, lastApp: () => state?.lastApp || null };
