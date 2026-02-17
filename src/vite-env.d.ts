/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_IMH_LICENSE_SECRET: string
  readonly VITE_APP_VERSION: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
