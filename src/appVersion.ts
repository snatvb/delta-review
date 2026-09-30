// The one place the frontend reads the app version. Injected at build time
// from package.json (vite.config.ts `define`), which is also what
// tauri.conf.json resolves — bump package.json and every surface updates.
export const APP_VERSION: string = __APP_VERSION__;
