// Ambient window/global augmentations shared across the app. Kept in one
// place rather than re-declaring `Window` per file.
export {}

declare global {
  interface Window {
    /**
     * Injected by the OS shell at serve time — see src/lib/endpoints/index.js.
     * The ICE-related fields (iceServersFallback/stunUrls/turn/googleStunFallback)
     * are an optional escape hatch read by src/lib/collab/webrtc/call/ice.ts.
     */
    __VULOS_ENDPOINTS__?: {
      cloud?: string
      lan?: string
      /** explicit full RTCIceServer[] override, used verbatim */
      iceServersFallback?: RTCIceServer[]
      /** STUN server URLs (comma-split already applied) */
      stunUrls?: string[]
      /** TURN server config */
      turn?: { urls?: string[] | string; username?: string; credential?: string }
      /** legacy opt-in flag for the public Google STUN fallback */
      googleStunFallback?: boolean
    } | null
  }
}
