import assert from 'node:assert/strict';
import test from 'node:test';
import type { A2AEnvelope } from '../src/ports/a2a.ts';
import {
  createTrustedA2AProtocol,
  generateA2AKeyPair,
  negotiateMutualSlots,
} from '../src/providers/a2a/protocol.ts';

test('Ed25519 sign and verify round-trip enforces untrustedData and canonical JSON', () => {
  const aliceKeys = generateA2AKeyPair();
  const bobKeys = generateA2AKeyPair();

  assert.match(aliceKeys.publicKeyPem, /BEGIN PUBLIC KEY/);
  assert.match(aliceKeys.privateKeyPem, /BEGIN PRIVATE KEY/);

  let clock = 1_700_000_000_000;
  const alice = createTrustedA2AProtocol({
    selfId: 'alice',
    privateKeyPem: aliceKeys.privateKeyPem,
    peers: [
      {
        peerId: 'bob',
        displayName: 'Bob',
        publicKeyPem: bobKeys.publicKeyPem,
        allowedCapabilities: ['calendar:freebusy', 'status:ping'],
      },
    ],
    now: () => clock,
  });

  const bob = createTrustedA2AProtocol({
    selfId: 'bob',
    privateKeyPem: bobKeys.privateKeyPem,
    peers: [
      {
        peerId: 'alice',
        displayName: 'Alice',
        publicKeyPem: aliceKeys.publicKeyPem,
        allowedCapabilities: ['calendar:freebusy', 'schedule:propose'],
      },
    ],
    now: () => clock,
  });

  const envelope = alice.signEnvelope(
    'schedule:propose',
    {
      meeting: 'Coffee',
      nested: { b: 2, a: 1 },
      slots: [{ startMs: 1000, endMs: 2000 }],
    },
    'bob',
  );

  const reorderedPayloadEnvelope: A2AEnvelope<{
    slots: Array<{ endMs: number; startMs: number }>;
    nested: { a: number; b: number };
    meeting: string;
  }> = {
    ...envelope,
    payload: {
      slots: [{ endMs: 2000, startMs: 1000 }],
      nested: { a: 1, b: 2 },
      meeting: 'Coffee',
    },
  };

  const verified = bob.verifyEnvelope(reorderedPayloadEnvelope);
  assert.equal(verified.ok, true);
  assert.equal(verified.untrustedData, true);
  if (verified.ok) {
    assert.equal(verified.senderId, 'alice');
    assert.equal(verified.peer.displayName, 'Alice');
    assert.equal(verified.capability, 'schedule:propose');
    assert.deepEqual(verified.payload, reorderedPayloadEnvelope.payload);
    assert.equal(verified.timestampMs, clock);
    assert.equal(verified.nonce, envelope.nonce);
  }
});

test('tampered payload fails verification without poisoning the nonce cache', () => {
  const aliceKeys = generateA2AKeyPair();
  const bobKeys = generateA2AKeyPair();
  const clock = 1_700_000_000_000;

  const alice = createTrustedA2AProtocol({
    selfId: 'alice',
    privateKeyPem: aliceKeys.privateKeyPem,
    peers: [],
    now: () => clock,
  });
  const bob = createTrustedA2AProtocol({
    selfId: 'bob',
    privateKeyPem: bobKeys.privateKeyPem,
    peers: [
      {
        peerId: 'alice',
        displayName: 'Alice',
        publicKeyPem: aliceKeys.publicKeyPem,
        allowedCapabilities: ['errand:coordinate'],
      },
    ],
    now: () => clock,
  });

  const envelope = alice.signEnvelope('errand:coordinate', { item: 'Milk', qty: 1 }, 'bob');
  const tampered: A2AEnvelope<{ item: string; qty: number }> = {
    ...envelope,
    payload: { item: 'Milk', qty: 99 },
  };

  const tamperedResult = bob.verifyEnvelope(tampered);
  assert.equal(tamperedResult.ok, false);
  assert.equal(tamperedResult.untrustedData, true);
  if (!tamperedResult.ok) {
    assert.equal(tamperedResult.reason, 'invalid_signature');
  }

  const originalResult = bob.verifyEnvelope(envelope);
  assert.equal(originalResult.ok, true);
  assert.equal(originalResult.untrustedData, true);
});

test('replay nonce is rejected on duplicate envelope delivery', () => {
  const aliceKeys = generateA2AKeyPair();
  const bobKeys = generateA2AKeyPair();
  let clock = 1_700_000_000_000;

  const alice = createTrustedA2AProtocol({
    selfId: 'alice',
    privateKeyPem: aliceKeys.privateKeyPem,
    peers: [],
    now: () => clock,
  });
  const bob = createTrustedA2AProtocol({
    selfId: 'bob',
    privateKeyPem: bobKeys.privateKeyPem,
    peers: [
      {
        peerId: 'alice',
        displayName: 'Alice',
        publicKeyPem: aliceKeys.publicKeyPem,
        allowedCapabilities: ['status:ping'],
      },
    ],
    maxSkewMs: 60_000,
    now: () => clock,
  });

  const envelope = alice.signEnvelope('status:ping', { ok: true }, 'bob');
  const first = bob.verifyEnvelope(envelope);
  assert.equal(first.ok, true);
  assert.equal(first.untrustedData, true);

  clock += 10_000;
  const replay = bob.verifyEnvelope(envelope);
  assert.equal(replay.ok, false);
  assert.equal(replay.untrustedData, true);
  if (!replay.ok) {
    assert.equal(replay.reason, 'replay_detected');
  }
});

test('stale and far-future timestamps outside maxSkewMs are rejected', () => {
  const aliceKeys = generateA2AKeyPair();
  const bobKeys = generateA2AKeyPair();
  let aliceClock = 1_700_000_000_000;
  let bobClock = 1_700_000_000_000;

  const alice = createTrustedA2AProtocol({
    selfId: 'alice',
    privateKeyPem: aliceKeys.privateKeyPem,
    peers: [],
    now: () => aliceClock,
  });
  const bob = createTrustedA2AProtocol({
    selfId: 'bob',
    privateKeyPem: bobKeys.privateKeyPem,
    peers: [
      {
        peerId: 'alice',
        displayName: 'Alice',
        publicKeyPem: aliceKeys.publicKeyPem,
        allowedCapabilities: ['status:ping'],
      },
    ],
    maxSkewMs: 30_000,
    now: () => bobClock,
  });

  const staleEnvelope = alice.signEnvelope('status:ping', { seq: 1 }, 'bob');
  bobClock = aliceClock + 30_001;
  const staleResult = bob.verifyEnvelope(staleEnvelope);
  assert.equal(staleResult.ok, false);
  assert.equal(staleResult.untrustedData, true);
  if (!staleResult.ok) {
    assert.equal(staleResult.reason, 'timestamp_skew');
  }

  aliceClock = bobClock + 30_001;
  const futureEnvelope = alice.signEnvelope('status:ping', { seq: 2 }, 'bob');
  const futureResult = bob.verifyEnvelope(futureEnvelope);
  assert.equal(futureResult.ok, false);
  assert.equal(futureResult.untrustedData, true);
  if (!futureResult.ok) {
    assert.equal(futureResult.reason, 'timestamp_skew');
  }
});

test('unauthorized capability, unknown peer, recipient mismatch, and malformed envelopes are rejected with untrustedData', () => {
  const aliceKeys = generateA2AKeyPair();
  const bobKeys = generateA2AKeyPair();
  const malloryKeys = generateA2AKeyPair();
  const clock = 1_700_000_000_000;

  const alice = createTrustedA2AProtocol({
    selfId: 'alice',
    privateKeyPem: aliceKeys.privateKeyPem,
    peers: [],
    now: () => clock,
  });
  const mallory = createTrustedA2AProtocol({
    selfId: 'mallory',
    privateKeyPem: malloryKeys.privateKeyPem,
    peers: [],
    now: () => clock,
  });
  const bob = createTrustedA2AProtocol({
    selfId: 'bob',
    privateKeyPem: bobKeys.privateKeyPem,
    peers: [
      {
        peerId: 'alice',
        displayName: 'Alice',
        publicKeyPem: aliceKeys.publicKeyPem,
        allowedCapabilities: ['status:ping'],
      },
    ],
    now: () => clock,
  });

  const unauthorized = alice.signEnvelope('errand:coordinate', { task: 'buy' }, 'bob');
  const unauthorizedResult = bob.verifyEnvelope(unauthorized);
  assert.equal(unauthorizedResult.ok, false);
  assert.equal(unauthorizedResult.untrustedData, true);
  if (!unauthorizedResult.ok) {
    assert.equal(unauthorizedResult.reason, 'capability_denied');
  }

  const unknown = mallory.signEnvelope('status:ping', {}, 'bob');
  const unknownResult = bob.verifyEnvelope(unknown);
  assert.equal(unknownResult.ok, false);
  assert.equal(unknownResult.untrustedData, true);
  if (!unknownResult.ok) {
    assert.equal(unknownResult.reason, 'unknown_peer');
  }

  const wrongRecipient = alice.signEnvelope('status:ping', {}, 'charlie');
  const wrongRecipientResult = bob.verifyEnvelope(wrongRecipient);
  assert.equal(wrongRecipientResult.ok, false);
  assert.equal(wrongRecipientResult.untrustedData, true);
  if (!wrongRecipientResult.ok) {
    assert.equal(wrongRecipientResult.reason, 'recipient_mismatch');
  }

  const malformedResult = bob.verifyEnvelope({
    ...alice.signEnvelope('status:ping', {}, 'bob'),
    version: 2 as 1,
  });
  assert.equal(malformedResult.ok, false);
  assert.equal(malformedResult.untrustedData, true);
  if (!malformedResult.ok) {
    assert.equal(malformedResult.reason, 'invalid_envelope');
  }
});

test('negotiateMutualSlots finds overlapping free slots sorted chronologically', () => {
  const hour = 60 * 60_000;
  const minute = 60_000;
  const dayStart = 1_700_000_000_000;
  const windowStartMs = dayStart + 9 * hour;
  const windowEndMs = dayStart + 17 * hour;

  const slots = negotiateMutualSlots({
    selfBusy: [
      { startMs: dayStart + 10 * hour, endMs: dayStart + 11 * hour },
      { startMs: dayStart + 8 * hour, endMs: dayStart + 9 * hour + 15 * minute },
      { startMs: dayStart + 14 * hour, endMs: dayStart + 15 * hour + 30 * minute },
    ],
    peerBusy: [
      { startMs: dayStart + 10 * hour + 30 * minute, endMs: dayStart + 12 * hour },
      { startMs: dayStart + 12 * hour + 20 * minute, endMs: dayStart + 13 * hour },
      { startMs: dayStart + 16 * hour + 45 * minute, endMs: dayStart + 18 * hour },
    ],
    windowStartMs,
    windowEndMs,
    durationMinutes: 30,
  });

  assert.deepEqual(slots, [
    { startMs: dayStart + 9 * hour + 15 * minute, endMs: dayStart + 10 * hour },
    { startMs: dayStart + 13 * hour, endMs: dayStart + 14 * hour },
    { startMs: dayStart + 15 * hour + 30 * minute, endMs: dayStart + 16 * hour + 45 * minute },
  ]);

  const keys = generateA2AKeyPair();
  const protocol = createTrustedA2AProtocol({
    selfId: 'self',
    privateKeyPem: keys.privateKeyPem,
    peers: [],
  });

  assert.deepEqual(
    protocol.negotiateMutualSlots({
      selfBusy: [{ startMs: windowStartMs, endMs: windowEndMs }],
      peerBusy: [],
      windowStartMs,
      windowEndMs,
      durationMinutes: 30,
    }),
    [],
  );

  assert.deepEqual(
    protocol.negotiateMutualSlots({
      selfBusy: [],
      peerBusy: [],
      windowStartMs,
      windowEndMs,
      durationMinutes: 0,
    }),
    [],
  );

  assert.deepEqual(
    protocol.negotiateMutualSlots({
      selfBusy: [],
      peerBusy: [],
      windowStartMs,
      windowEndMs: windowStartMs + 60 * minute,
      durationMinutes: 60,
    }),
    [{ startMs: windowStartMs, endMs: windowStartMs + 60 * minute }],
  );
});
