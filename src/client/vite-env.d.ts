/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly DEBUG_CHAT_WS?: string;
  /** The package version the bundle was built from, defined in `vite.config.ts`. */
  readonly FF_APP_VERSION?: string;
}
