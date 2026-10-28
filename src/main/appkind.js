'use strict';

// What kind of app is in front, from its bundle id (macOS) or its name: 'browser', 'code' (editors,
// IDEs and terminals: where Claude Code runs), 'chat' or 'other'.

const BY_ID = {
  browser: [
    'com.apple.Safari', 'com.apple.SafariTechnologyPreview', 'com.google.Chrome', 'com.google.Chrome.beta',
    'com.google.Chrome.canary', 'org.chromium.Chromium', 'org.mozilla.firefox', 'org.mozilla.firefoxdeveloperedition',
    'org.mozilla.nightly', 'company.thebrowser.Browser', 'company.thebrowser.dia', 'com.brave.Browser',
    'com.microsoft.edgemac', 'com.operasoftware.Opera', 'com.operasoftware.OperaGX', 'com.vivaldi.Vivaldi',
    'app.zen-browser.zen', 'com.kagi.kagimacOS', 'ai.perplexity.comet', 'org.torproject.torbrowser',
  ],
  code: [
    'com.microsoft.VSCode', 'com.microsoft.VSCodeInsiders', 'com.vscodium', 'com.todesktop.230313mzl4w4u92',
    'com.exafunction.windsurf', 'dev.zed.Zed', 'dev.zed.Zed-Preview', 'com.apple.dt.Xcode', 'com.sublimetext.4',
    'com.panic.Nova', 'com.apple.Terminal', 'com.googlecode.iterm2', 'dev.warp.Warp-Stable', 'com.mitchellh.ghostty',
    'net.kovidgoyal.kitty', 'org.alacritty', 'com.github.wez.wezterm', 'co.zeit.hyper', 'com.google.antigravity',
    'com.google.antigravity-ide', 'com.github.GitHubClient', 'com.t3tools.t3code', 'ai.opencode.desktop',
  ],
  chat: [
    'com.tinyspeck.slackmacgap', 'com.hnc.Discord', 'ru.keepcoder.Telegram', 'org.telegram.desktop',
    'net.whatsapp.WhatsApp', 'desktop.WhatsApp', 'com.apple.MobileSMS', 'com.microsoft.teams2', 'com.microsoft.teams',
    'us.zoom.xos', 'com.facebook.archon', 'org.whispersystems.signal-desktop', 'com.anthropic.claudefordesktop',
    'com.openai.chat', 'com.google.GeminiMacOS', 'com.apple.FaceTime', 'im.riot.app', 'com.viber.osx',
  ],
};
const PREFIXES = { code: ['com.jetbrains.', 'com.google.android.studio'] };
const BY_NAME = [
  ['browser', /\b(safari|chrome|chromium|firefox|arc|brave|edge|opera|vivaldi|zen|orion)\b/i],
  ['code', /\b(code|cursor|windsurf|zed|xcode|intellij|pycharm|webstorm|goland|rider|clion|sublime|terminal|iterm|warp|ghostty|kitty|alacritty|wezterm|hyper|antigravity|powershell|windowsterminal)\b/i],
  ['chat', /\b(slack|discord|telegram|whatsapp|messages|teams|zoom|signal|messenger|claude|chatgpt|element|viber)\b/i],
];

function appKind({ bundleId = '', name = '' } = {}) {
  for (const [kind, ids] of Object.entries(BY_ID)) if (ids.includes(bundleId)) return kind;
  for (const [kind, prefixes] of Object.entries(PREFIXES)) if (prefixes.some((p) => bundleId.startsWith(p))) return kind;
  for (const [kind, re] of BY_NAME) if (re.test(name)) return kind;
  return 'other';
}

module.exports = { appKind };
