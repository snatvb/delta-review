import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ isTauri: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: vi.fn() }));
vi.mock('../api', () => ({
  api: { updaterStatus: vi.fn(), updaterCheck: vi.fn(), updaterDownload: vi.fn() },
}));

import { isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { api } from '../api';
import type { UpdaterSnapshot, UpdaterStatus } from '../types';
import { useUpdater } from './useUpdater';
import { setUpdateCheck } from './updateCheckPref';
import { setAutoDownload } from './autoDownloadPref';

const snap = (status: UpdaterStatus, extra: Partial<UpdaterSnapshot> = {}): UpdaterSnapshot => ({
  status,
  version: ['available', 'downloading', 'ready'].includes(status) ? '9.9.9' : null,
  progress: status === 'ready' ? 1 : status === 'downloading' ? 0.5 : null,
  lastCheckedAt: 1234,
  ...extra,
});

describe('useUpdater', () => {
  let onEvent: ((payload: UpdaterSnapshot) => void) | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    onEvent = undefined;
    setUpdateCheck('on');
    setAutoDownload('off');
    vi.mocked(isTauri).mockReturnValue(true);
    vi.mocked(api.updaterStatus).mockResolvedValue(snap('idle'));
    vi.mocked(api.updaterCheck).mockResolvedValue(snap('idle'));
    vi.mocked(api.updaterDownload).mockResolvedValue(snap('downloading'));
    vi.mocked(listen).mockImplementation(
      async (_name, cb) => {
        onEvent = (payload) => (cb as (arg: unknown) => void)({ event: 'updater:state', id: 0, payload });
        return () => {};
      },
    );
  });

  afterEach(() => vi.useRealTimers());

  it('never checks when update checks are turned off, and checks once turned back on', async () => {
    setUpdateCheck('off');
    renderHook(() => useUpdater());
    await act(async () => {});
    expect(api.updaterCheck).not.toHaveBeenCalled();

    act(() => setUpdateCheck('on'));
    await waitFor(() => expect(api.updaterCheck).toHaveBeenCalledWith(false));
  });

  it('never touches the backend outside Tauri', () => {
    vi.mocked(isTauri).mockReturnValue(false);
    const { result } = renderHook(() => useUpdater());
    expect(result.current.status).toBe('idle');
    expect(api.updaterStatus).not.toHaveBeenCalled();
    expect(api.updaterCheck).not.toHaveBeenCalled();
  });

  it('adopts the backend snapshot on mount, then follows updater:state events', async () => {
    const available = snap('available', { version: '2.0.0' });
    // A skipped launch check returns the backend's current state unchanged.
    vi.mocked(api.updaterStatus).mockResolvedValue(available);
    vi.mocked(api.updaterCheck).mockResolvedValue(available);
    const { result } = renderHook(() => useUpdater());
    await waitFor(() => expect(result.current.status).toBe('available'));
    expect(result.current.version).toBe('2.0.0');

    act(() => onEvent?.(snap('downloading')));
    expect(result.current.status).toBe('downloading');
    expect(result.current.progress).toBe(0.5);

    act(() => onEvent?.(snap('ready')));
    expect(result.current.status).toBe('ready');
  });

  it('waits for the user when auto-download is off', async () => {
    const available = snap('available');
    vi.mocked(api.updaterStatus).mockResolvedValue(available);
    vi.mocked(api.updaterCheck).mockResolvedValue(available);
    const { result } = renderHook(() => useUpdater());
    await waitFor(() => expect(result.current.status).toBe('available'));
    expect(api.updaterDownload).not.toHaveBeenCalled();
  });

  it('auto-downloads a found update when the pref is on', async () => {
    const available = snap('available');
    vi.mocked(api.updaterStatus).mockResolvedValue(available);
    vi.mocked(api.updaterCheck).mockResolvedValue(available);
    setAutoDownload('on');
    renderHook(() => useUpdater());
    await waitFor(() => expect(api.updaterDownload).toHaveBeenCalledOnce());
  });

  it('download() drives the backend and reflects the ready snapshot', async () => {
    const available = snap('available');
    vi.mocked(api.updaterStatus).mockResolvedValue(available);
    vi.mocked(api.updaterCheck).mockResolvedValue(available);
    vi.mocked(api.updaterDownload).mockResolvedValue(snap('ready'));
    const { result } = renderHook(() => useUpdater());
    await waitFor(() => expect(result.current.status).toBe('available'));

    act(() => result.current.download());
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(api.updaterDownload).toHaveBeenCalledOnce();
  });

  it('manual check surfaces a failed check as an error', async () => {
    vi.mocked(api.updaterCheck).mockRejectedValue(new Error('network'));
    const { result } = renderHook(() => useUpdater());
    await act(async () => result.current.check());
    expect(result.current.status).toBe('error');
  });

  it('re-checks periodically while the app is open', async () => {
    vi.useFakeTimers();
    renderHook(() => useUpdater());
    // Launch check (manual=false), still exactly one call after mount settles.
    await act(async () => {});
    expect(api.updaterCheck).toHaveBeenCalledTimes(1);

    await act(async () => vi.advanceTimersByTimeAsync(4 * 60 * 60 * 1000));
    expect(api.updaterCheck).toHaveBeenCalledWith(true);
    expect(api.updaterCheck).toHaveBeenCalledTimes(2);
  });
});
