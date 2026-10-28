#!/usr/bin/env node
// Builds src/main/mac/capri-helper (macOS only): the small Swift program that tells Capri where
// the other windows are and which app is in front. One universal binary (Apple Silicon + Intel),
// macOS 12 and later. Needs the Xcode command line tools (xcode-select --install).
//
//   node scripts/build-mac-helper.js           build it
//   node scripts/build-mac-helper.js --if-stale  only if it's missing or older than its source

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const DIR = path.join(__dirname, '..', 'src', 'main', 'mac');
const SOURCE = path.join(DIR, 'capri-helper.swift');
const BINARY = path.join(DIR, 'capri-helper');
const ARCHS = ['arm64', 'x86_64'];

function stale() {
  try {
    return fs.statSync(BINARY).mtimeMs < fs.statSync(SOURCE).mtimeMs;
  } catch {
    return true;
  }
}

function build() {
  if (process.platform !== 'darwin') throw new Error('the macOS helper only builds on macOS');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'capri-helper-'));
  try {
    const parts = ARCHS.map((arch) => {
      const out = path.join(tmp, `capri-helper-${arch}`);
      execFileSync('xcrun', ['swiftc', '-O', '-target', `${arch}-apple-macos12.0`, '-o', out, SOURCE], { stdio: 'inherit' });
      return out;
    });
    execFileSync('xcrun', ['lipo', '-create', '-output', BINARY, ...parts], { stdio: 'inherit' });
    fs.chmodSync(BINARY, 0o755);
    // an ad-hoc signature: Apple Silicon won't run an unsigned binary
    execFileSync('codesign', ['--force', '--sign', '-', BINARY], { stdio: 'inherit' });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return BINARY;
}

module.exports = { build, stale, BINARY, SOURCE };

if (require.main === module) {
  if (process.argv.includes('--if-stale') && !stale()) process.exit(0);
  console.log('built', path.relative(process.cwd(), build()));
}
