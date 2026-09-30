/// <reference types="vite/client" />

/** App version injected at build time from package.json (see vite.config.ts). */
declare const __APP_VERSION__: string;

interface ImportMetaEnv {
  /** Dev-only flag: install the fixture IPC backend (src/dev/mockBackend.ts). */
  readonly VITE_MOCK_IPC?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
