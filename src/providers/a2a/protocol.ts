import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';
import type {
  A2ACapability,
  A2AEnvelope,
  A2AVerificationResult,
  NegotiateMutualSlotsInput,
  TimeWindow,
  TrustedA2APort,
  TrustedPeer,
} from '../../ports/a2a.ts';

export interface A2AKeyPair {
  publicKeyPem: string;
  privateKeyPem: string;
}

export interface TrustedA2AProtocolOptions {
  selfId: string;
  privateKeyPem: string;
  peers: TrustedPeer[];
  maxSkewMs?: number;
  now?: () => number;
}

const DEFAULT_MAX_SKEW_MS = 5 * 60_000;
const ED25519_SIGNATURE_BYTES = 64;
const VALID_CAPABILITIES = new Set<A2ACapability>([
  'calendar:freebusy',
  'schedule:propose',
  'errand:coordinate',
  'status:ping',
]);

export function generateA2AKeyPair(): A2AKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { publicKeyPem: publicKey, privateKeyPem: privateKey };
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? 'null' : canonicalize(item))).join(',')}]`;
  }
  const withToJson = value as { toJSON?: () => unknown };
  if (typeof withToJson.toJSON === 'function') {
    return canonicalize(withToJson.toJSON());
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const entries: string[] = [];
  for (const key of keys) {
    const entry = record[key];
    if (entry === undefined || typeof entry === 'function' || typeof entry === 'symbol') {
      continue;
    }
    entries.push(`${JSON.stringify(key)}:${canonicalize(entry)}`);
  }
  return `{${entries.join(',')}}`;
}

function signingBytes(envelope: Omit<A2AEnvelope<unknown>, 'signature'>): Buffer {
  return Buffer.from(
    canonicalize({
      version: envelope.version,
      senderId: envelope.senderId,
      recipientId: envelope.recipientId,
      capability: envelope.capability,
      payload: envelope.payload,
      timestampMs: envelope.timestampMs,
      nonce: envelope.nonce,
    }),
    'utf8',
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isValidCapability(value: unknown): value is A2ACapability {
  return typeof value === 'string' && VALID_CAPABILITIES.has(value as A2ACapability);
}

export function negotiateMutualSlots(input: NegotiateMutualSlotsInput): TimeWindow[] {
  const { selfBusy, peerBusy, windowStartMs, windowEndMs, durationMinutes } = input;
  if (
    !Number.isFinite(windowStartMs) ||
    !Number.isFinite(windowEndMs) ||
    !Number.isFinite(durationMinutes) ||
    durationMinutes <= 0 ||
    windowEndMs <= windowStartMs
  ) {
    return [];
  }
  const durationMs = durationMinutes * 60_000;
  if (windowEndMs - windowStartMs < durationMs) {
    return [];
  }
  const clamped: TimeWindow[] = [];
  for (const interval of [...selfBusy, ...peerBusy]) {
    if (!Number.isFinite(interval.startMs) || !Number.isFinite(interval.endMs)) {
      continue;
    }
    const startMs = Math.max(windowStartMs, interval.startMs);
    const endMs = Math.min(windowEndMs, interval.endMs);
    if (endMs > startMs) {
      clamped.push({ startMs, endMs });
    }
  }
  clamped.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  const merged: TimeWindow[] = [];
  for (const interval of clamped) {
    const previous = merged.at(-1);
    if (previous && interval.startMs <= previous.endMs) {
      previous.endMs = Math.max(previous.endMs, interval.endMs);
    } else {
      merged.push({ startMs: interval.startMs, endMs: interval.endMs });
    }
  }
  const freeSlots: TimeWindow[] = [];
  let cursor = windowStartMs;
  for (const busy of merged) {
    if (busy.startMs - cursor >= durationMs) {
      freeSlots.push({ startMs: cursor, endMs: busy.startMs });
    }
    cursor = Math.max(cursor, busy.endMs);
  }
  if (windowEndMs - cursor >= durationMs) {
    freeSlots.push({ startMs: cursor, endMs: windowEndMs });
  }
  return freeSlots;
}

export function createTrustedA2AProtocol(options: TrustedA2AProtocolOptions): TrustedA2APort {
  const maxSkewMs = options.maxSkewMs ?? DEFAULT_MAX_SKEW_MS;
  const now = options.now ?? (() => Date.now());
  let cachedPrivateKey: KeyObject | undefined;
  const seenNonces = new Map<string, number>();

  const peerMap = new Map<
    string,
    {
      peer: TrustedPeer;
      capabilities: Set<A2ACapability>;
      publicKey?: KeyObject;
    }
  >();
  for (const peer of options.peers) {
    peerMap.set(peer.peerId, {
      peer: {
        ...peer,
        allowedCapabilities: [...peer.allowedCapabilities],
      },
      capabilities: new Set(peer.allowedCapabilities),
    });
  }

  function getPrivateKey(): KeyObject {
    if (!cachedPrivateKey) {
      cachedPrivateKey = createPrivateKey(options.privateKeyPem);
    }
    return cachedPrivateKey;
  }

  function pruneExpiredNonces(currentMs: number): void {
    for (const [key, timestampMs] of seenNonces) {
      if (currentMs - timestampMs > maxSkewMs) {
        seenNonces.delete(key);
      }
    }
  }

  return {
    selfId: options.selfId,

    signEnvelope<T = unknown>(
      capability: A2ACapability,
      payload: T,
      recipientId: string,
    ): A2AEnvelope<T> {
      const unsigned: Omit<A2AEnvelope<T>, 'signature'> = {
        version: 1,
        senderId: options.selfId,
        recipientId,
        capability,
        payload,
        timestampMs: now(),
        nonce: randomBytes(16).toString('base64url'),
      };
      const signature = sign(null, signingBytes(unsigned), getPrivateKey()).toString('base64url');
      return {
        ...unsigned,
        signature,
      };
    },

    verifyEnvelope<T = unknown>(envelope: A2AEnvelope<T>): A2AVerificationResult<T> {
      if (typeof envelope !== 'object' || envelope === null) {
        return { ok: false, untrustedData: true, reason: 'invalid_envelope' };
      }
      const rawSenderId = (envelope as { senderId?: unknown }).senderId;
      const senderId = isNonEmptyString(rawSenderId) ? rawSenderId : undefined;
      if (
        envelope.version !== 1 ||
        !senderId ||
        !isNonEmptyString(envelope.recipientId) ||
        !isValidCapability(envelope.capability) ||
        !isNonEmptyString(envelope.nonce) ||
        !isNonEmptyString(envelope.signature) ||
        typeof envelope.timestampMs !== 'number' ||
        !Number.isFinite(envelope.timestampMs)
      ) {
        return {
          ok: false,
          untrustedData: true,
          reason: 'invalid_envelope',
          ...(senderId ? { senderId } : {}),
        };
      }
      if (envelope.recipientId !== options.selfId) {
        return {
          ok: false,
          untrustedData: true,
          reason: 'recipient_mismatch',
          senderId: envelope.senderId,
        };
      }
      const peerEntry = peerMap.get(envelope.senderId);
      if (!peerEntry) {
        return {
          ok: false,
          untrustedData: true,
          reason: 'unknown_peer',
          senderId: envelope.senderId,
        };
      }
      if (!peerEntry.capabilities.has(envelope.capability)) {
        return {
          ok: false,
          untrustedData: true,
          reason: 'capability_denied',
          senderId: envelope.senderId,
        };
      }
      const currentMs = now();
      if (Math.abs(currentMs - envelope.timestampMs) > maxSkewMs) {
        return {
          ok: false,
          untrustedData: true,
          reason: 'timestamp_skew',
          senderId: envelope.senderId,
        };
      }
      pruneExpiredNonces(currentMs);
      const replayKey = `${envelope.senderId}\0${envelope.nonce}`;
      if (seenNonces.has(replayKey)) {
        return {
          ok: false,
          untrustedData: true,
          reason: 'replay_detected',
          senderId: envelope.senderId,
        };
      }
      let validSignature = false;
      try {
        if (!peerEntry.publicKey) {
          peerEntry.publicKey = createPublicKey(peerEntry.peer.publicKeyPem);
        }
        const signatureBuffer = Buffer.from(envelope.signature, 'base64url');
        if (signatureBuffer.length === ED25519_SIGNATURE_BYTES) {
          validSignature = verify(
            null,
            signingBytes(envelope),
            peerEntry.publicKey,
            signatureBuffer,
          );
        }
      } catch {
        validSignature = false;
      }
      if (!validSignature) {
        return {
          ok: false,
          untrustedData: true,
          reason: 'invalid_signature',
          senderId: envelope.senderId,
        };
      }
      seenNonces.set(replayKey, envelope.timestampMs);
      return {
        ok: true,
        untrustedData: true,
        senderId: envelope.senderId,
        peer: {
          ...peerEntry.peer,
          allowedCapabilities: [...peerEntry.peer.allowedCapabilities],
        },
        capability: envelope.capability,
        payload: envelope.payload,
        timestampMs: envelope.timestampMs,
        nonce: envelope.nonce,
      };
    },

    negotiateMutualSlots,
  };
}
