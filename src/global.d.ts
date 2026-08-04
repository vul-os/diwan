// Ambient window/global augmentations shared across the app. Kept in one
// place rather than re-declaring `Window` per file.
export {}

declare global {
  interface Window {
    /** Injected by the OS shell at serve time — see src/lib/endpoints/index.js. */
    __VULOS_ENDPOINTS__?: { cloud?: string; lan?: string } | null
  }
}
