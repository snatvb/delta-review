#!/usr/bin/env node
import { readFileSync } from 'node:fs';

export function buildLatestJson({ version, platforms, pubDate, notes = '' }) {
  if (!platforms || typeof platforms !== 'object' || Object.keys(platforms).length === 0) {
    throw new Error('at least one platform entry is required');
  }
  const manifest = {
    version,
    notes,
    pub_date: pubDate,
    platforms: {},
  };
  for (const [key, entry] of Object.entries(platforms)) {
    if (!entry?.signature || !entry?.url) {
      throw new Error(`platform ${key} needs both signature and url`);
    }
    manifest.platforms[key] = { signature: entry.signature, url: entry.url };
  }
  return manifest;
}

function parseArgs(argv) {
  const out = { sig: {}, url: {} };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (value === undefined) {
      throw new Error(`${key} requires a value`);
    }
    if (key === '--sig' || key === '--url') {
      const eq = value.indexOf('=');
      if (eq === -1) {
        throw new Error(`${key} expects PLATFORM=VALUE`);
      }
      const platform = value.slice(0, eq);
      const val = value.slice(eq + 1);
      if (key === '--sig') {
        out.sig[platform] = readFileSync(val, 'utf8').trim();
      } else {
        out.url[platform] = val;
      }
    } else {
      out[key.replace(/^--/, '')] = value;
    }
  }
  return out;
}

// CLI:
//   node gen-latest-json.mjs --version X --pub-date D [--notes N]
//     --sig darwin-aarch64=app.tar.gz.sig --url darwin-aarch64=https://...
//     --sig windows-x86_64=setup.exe.sig --url windows-x86_64=https://...
//     --sig linux-x86_64=appimage.tar.gz.sig --url linux-x86_64=https://...
if (import.meta.url === `file://${process.argv[1]}`) {
  const a = parseArgs(process.argv.slice(2));
  const platforms = {};
  for (const key of Object.keys(a.sig)) {
    platforms[key] = { signature: a.sig[key], url: a.url[key] };
  }
  for (const key of Object.keys(a.url)) {
    platforms[key] ??= { signature: undefined, url: a.url[key] };
  }
  const manifest = buildLatestJson({
    version: a.version,
    platforms,
    pubDate: a['pub-date'],
    notes: a.notes ?? '',
  });
  process.stdout.write(JSON.stringify(manifest, null, 2) + '\n');
}
