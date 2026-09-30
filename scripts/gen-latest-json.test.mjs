import { describe, expect, it } from 'vitest';
import { buildLatestJson } from './gen-latest-json.mjs';

describe('buildLatestJson', () => {
  it('assembles a multi-platform manifest', () => {
    const m = buildLatestJson({
      version: '0.17.0',
      pubDate: '2026-09-30T00:00:00Z',
      notes: 'See the release page.',
      platforms: {
        'darwin-aarch64': {
          signature: 'SIG_MAC',
          url: 'https://github.com/snatvb/delta-review/releases/download/v0.17.0/Delta.app.tar.gz',
        },
        'windows-x86_64': {
          signature: 'SIG_WIN',
          url: 'https://github.com/snatvb/delta-review/releases/download/v0.17.0/Delta_0.17.0_x64-setup.exe',
        },
        'linux-x86_64': {
          signature: 'SIG_LINUX',
          url: 'https://github.com/snatvb/delta-review/releases/download/v0.17.0/Delta_0.17.0_amd64.AppImage',
        },
      },
    });
    expect(m.version).toBe('0.17.0');
    expect(m.pub_date).toBe('2026-09-30T00:00:00Z');
    expect(m.notes).toBe('See the release page.');
    expect(m.platforms['darwin-aarch64']).toEqual({
      signature: 'SIG_MAC',
      url: 'https://github.com/snatvb/delta-review/releases/download/v0.17.0/Delta.app.tar.gz',
    });
    expect(m.platforms['windows-x86_64'].signature).toBe('SIG_WIN');
    expect(m.platforms['linux-x86_64'].signature).toBe('SIG_LINUX');
  });

  it('still works for a single platform', () => {
    const m = buildLatestJson({
      version: '1.0.0',
      pubDate: 'd',
      platforms: { 'darwin-aarch64': { signature: 's', url: 'u' } },
    });
    expect(m.notes).toBe('');
    expect(Object.keys(m.platforms)).toEqual(['darwin-aarch64']);
  });

  it('rejects empty platform sets and incomplete entries', () => {
    expect(() => buildLatestJson({ version: '1.0.0', pubDate: 'd', platforms: {} })).toThrow();
    expect(() =>
      buildLatestJson({
        version: '1.0.0',
        pubDate: 'd',
        platforms: { 'darwin-aarch64': { signature: 's' } },
      }),
    ).toThrow();
    expect(() => buildLatestJson({ version: '1.0.0', pubDate: 'd' })).toThrow();
  });
});
