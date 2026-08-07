/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the RegReview API. Defaults to http://localhost:8787 locally. */
  readonly VITE_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
