/**
 * errors.js — Diwan's first-party WebRTC/fabric structured error types.
 *
 * Exported from the barrel so consumers can instanceof-check:
 *
 *   import { SignalingError, RelayDepositError, EndpointError } from '../lib/collab/webrtc/index.js'
 *   try { ... } catch (err) {
 *     if (err instanceof SignalingError) { ... }
 *   }
 */

/**
 * Thrown when the signaling transport cannot be established or is permanently
 * unavailable (e.g. budget exhausted and no recovery path).
 */
export class SignalingError extends Error {
  code: string
  attempts: number | undefined
  constructor(message: string, detail: { code?: string; attempts?: number } = {}) {
    super(message)
    this.name = 'SignalingError'
    this.code = detail.code || 'SIGNALING_ERROR'
    this.attempts = detail.attempts
  }
}

/**
 * Thrown when a relay deposit cannot be completed (network failure, server
 * rejection, or a signing failure).
 */
export class RelayDepositError extends Error {
  code: string
  /** HTTP status when available */
  status: number | undefined
  constructor(message: string, detail: { code?: string; status?: number } = {}) {
    super(message)
    this.name = 'RelayDepositError'
    this.code = detail.code || 'RELAY_DEPOSIT_ERROR'
    this.status = detail.status
  }
}

/**
 * Thrown when no reachable endpoint can be found after probing all candidates.
 */
export class EndpointError extends Error {
  code: string
  candidates: string[] | undefined
  constructor(message: string, detail: { code?: string; candidates?: string[] } = {}) {
    super(message)
    this.name = 'EndpointError'
    this.code = detail.code || 'ENDPOINT_ERROR'
    this.candidates = detail.candidates
  }
}

/**
 * Thrown when a fabric session operation fails (e.g. ICE negotiation fatal
 * error, or the P2P and relay paths both fail).
 */
export class FabricError extends Error {
  code: string
  peerId: string | undefined
  constructor(message: string, detail: { code?: string; peerId?: string } = {}) {
    super(message)
    this.name = 'FabricError'
    this.code = detail.code || 'FABRIC_ERROR'
    this.peerId = detail.peerId
  }
}
