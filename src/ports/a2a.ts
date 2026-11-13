export type A2ACapability =
  'calendar:freebusy' | 'schedule:propose' | 'errand:coordinate' | 'status:ping';

export interface TrustedPeer {
  peerId: string;
  displayName: string;
  publicKeyPem: string;
  allowedCapabilities: A2ACapability[];
}

export interface A2AEnvelope<T = unknown> {
  version: 1;
  senderId: string;
  recipientId: string;
  capability: A2ACapability;
  payload: T;
  timestampMs: number;
  nonce: string;
  signature: string;
}

export type A2AVerificationFailureReason =
  | 'unknown_peer'
  | 'recipient_mismatch'
  | 'capability_denied'
  | 'timestamp_skew'
  | 'replay_detected'
  | 'invalid_signature'
  | 'invalid_envelope';

export type A2AVerificationResult<T = unknown> =
  | {
      ok: true;
      untrustedData: true;
      senderId: string;
      peer: TrustedPeer;
      capability: A2ACapability;
      payload: T;
      timestampMs: number;
      nonce: string;
    }
  | {
      ok: false;
      untrustedData: true;
      reason: A2AVerificationFailureReason;
      senderId?: string;
    };

export interface TimeWindow {
  startMs: number;
  endMs: number;
}

export interface NegotiateMutualSlotsInput {
  selfBusy: TimeWindow[];
  peerBusy: TimeWindow[];
  windowStartMs: number;
  windowEndMs: number;
  durationMinutes: number;
}

export interface TrustedA2APort {
  readonly selfId: string;
  signEnvelope<T = unknown>(
    capability: A2ACapability,
    payload: T,
    recipientId: string,
  ): A2AEnvelope<T>;
  verifyEnvelope<T = unknown>(envelope: A2AEnvelope<T>): A2AVerificationResult<T>;
  negotiateMutualSlots(input: NegotiateMutualSlotsInput): TimeWindow[];
}
