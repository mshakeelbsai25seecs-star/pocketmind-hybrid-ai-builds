/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_POCKETMIND_GIT_SHA?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
