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
  /**
   * @param {string} message
   * @param {{ code?: string, attempts?: number }} [detail]
   */
  constructor(message, detail = {}) {
    super(message)
    this.name = 'SignalingError'
    /** @type {string} */
    this.code = detail.code || 'SIGNALING_ERROR'
    /** @type {number|undefined} */
    this.attempts = detail.attempts
  }
}

/**
 * Thrown when a relay deposit cannot be completed (network failure, server
 * rejection, or a signing failure).
 */
export class RelayDepositError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: string, status?: number }} [detail]
   */
  constructor(message, detail = {}) {
    super(message)
    this.name = 'RelayDepositError'
    /** @type {string} */
    this.code = detail.code || 'RELAY_DEPOSIT_ERROR'
    /** @type {number|undefined} — HTTP status when available */
    this.status = detail.status
  }
}

/**
 * Thrown when no reachable endpoint can be found after probing all candidates.
 */
export class EndpointError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: string, candidates?: string[] }} [detail]
   */
  constructor(message, detail = {}) {
    super(message)
    this.name = 'EndpointError'
    /** @type {string} */
    this.code = detail.code || 'ENDPOINT_ERROR'
    /** @type {string[]|undefined} */
    this.candidates = detail.candidates
  }
}

/**
 * Thrown when a fabric session operation fails (e.g. ICE negotiation fatal
 * error, or the P2P and relay paths both fail).
 */
export class FabricError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: string, peerId?: string }} [detail]
   */
  constructor(message, detail = {}) {
    super(message)
    this.name = 'FabricError'
    /** @type {string} */
    this.code = detail.code || 'FABRIC_ERROR'
    /** @type {string|undefined} */
    this.peerId = detail.peerId
  }
}
