import { useCallback, useEffect, useRef, useState } from 'react';
import { track } from '@/analytics';
import { isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { relaunch } from '@tauri-apps/plugin-process';
import { api } from '../api';
import type { UpdaterSnapshot, UpdaterStatus } from '../types';
import { useUpdateCheck } from './updateCheckPref';
import { getAutoDownload } from './autoDownloadPref';

// While the app stays open, re-check for updates this often. The timer calls
// with manual=true so the backend's once-per-process guard doesn't swallow it.
const RECHECK_EVERY_MS = 4 * 60 * 60 * 1000;

const IDLE: UpdaterSnapshot = { status: 'idle', version: null, progress: null, lastCheckedAt: null };

export type { UpdaterStatus };

export interface UpdaterState extends UpdaterSnapshot {
  /** Manual re-check (Settings → About). */
  check: () => void;
  /** Start downloading + installing the available update. */
  download: () => void;
  restart: () => Promise<void>;
}

// The backend owns the whole update lifecycle (src-tauri/src/updater.rs): the
// check and the download run in the app process and every transition is
// broadcast as `updater:state`, so the banner — and a transfer in flight —
// survive any window closing, and all windows always agree. This hook is the
// frontend half: mirror that snapshot, fire the launch/periodic checks, and
// auto-download when the pref says so. Flow: idle → checking → available →
// downloading → ready (the download still only starts when asked — by the
// user or the auto-download pref).
export function useUpdater(): UpdaterState {
  const [snapshot, setSnapshot] = useState<UpdaterSnapshot>(IDLE);
  const [updateCheck] = useUpdateCheck();

  // Adopt the process's current state (a window opened mid-download sees it
  // immediately instead of waiting for the next broadcast), then follow the
  // broadcasts. The bootstrap fetch only applies if no event beat it to us —
  // an event always carries newer state than a fetch captured earlier.
  const seenEventRef = useRef(false);
  useEffect(() => {
    if (!isTauri()) return; // dev / dev:mock — no Tauri IPC available
    let disposed = false;
    let unlisten: (() => void) | undefined;
    api.updaterStatus()
      .then((s) => {
        if (!disposed && !seenEventRef.current) setSnapshot(s);
      })
      .catch(() => {});
    void listen<UpdaterSnapshot>('updater:state', (e) => {
      seenEventRef.current = true;
      setSnapshot(e.payload);
    }).then((un) => {
      if (disposed) un();
      else unlisten = un;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  // Launch check: every window asks, the backend runs it once per process and
  // answers the rest with the current state.
  useEffect(() => {
    if (!isTauri() || updateCheck === 'off') return;
    void api.updaterCheck(false).then((s) => setSnapshot(s)).catch(() => {});
  }, [updateCheck]);

  // Periodic re-check while the app is open (same pref as the launch check).
  useEffect(() => {
    if (!isTauri() || updateCheck === 'off') return;
    const id = window.setInterval(() => {
      void api.updaterCheck(true).then(setSnapshot).catch(() => {});
    }, RECHECK_EVERY_MS);
    return () => window.clearInterval(id);
  }, [updateCheck]);

  // Auto-download: when the pref is on, a found update starts transferring
  // without waiting for a click. Fired once per availability — every window
  // may fire it, the backend no-ops all but the first.
  const autoDownloadRef = useRef(false);
  useEffect(() => {
    if (snapshot.status === 'idle' || snapshot.status === 'error') {
      autoDownloadRef.current = false;
      return;
    }
    if (snapshot.status !== 'available' || autoDownloadRef.current || getAutoDownload() !== 'on') {
      return;
    }
    autoDownloadRef.current = true;
    void api.updaterDownload().then(setSnapshot).catch(() => {});
  }, [snapshot.status]);

  const trackedRef = useRef(false);
  useEffect(() => {
    if (snapshot.status === 'ready' && !trackedRef.current) {
      trackedRef.current = true;
      track('update_applied');
    }
  }, [snapshot.status]);

  const check = useCallback(() => {
    void api.updaterCheck(true)
      .then((s) => setSnapshot(s))
      .catch((err) => {
        console.error('updater: check failed', err);
        setSnapshot((s) => ({ ...s, status: 'error' }));
      });
  }, []);

  const download = useCallback(() => {
    void api.updaterDownload()
      .then((s) => setSnapshot(s))
      .catch((err) => {
        console.error('updater: download failed', err);
        setSnapshot((s) => ({ ...s, status: 'error' }));
      });
  }, []);

  return { ...snapshot, check, download, restart: relaunch };
}
