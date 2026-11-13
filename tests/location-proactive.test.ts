import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { ObservationCursorExpired } from '../src/ports/proactivity.ts';
import {
  createOwnTracksObservationProvider,
  haversineMeters,
  parseOwnTracksEvent,
  type GeofenceZone,
} from '../src/providers/location/owntracks.ts';

const HOME_ZONE: GeofenceZone = {
  id: 'home',
  label: 'Home',
  lat: 37.7749,
  lon: -122.4194,
  radiusMeters: 150,
  triggerOn: 'both',
};

const OFFICE_ZONE: GeofenceZone = {
  id: 'office',
  label: 'Office',
  lat: 37.7897,
  lon: -122.4014,
  radiusMeters: 120,
  triggerOn: 'enter',
};

describe('haversineMeters', () => {
  test('returns 0 for identical coordinates and accurate geodesic distance', () => {
    assert.equal(haversineMeters(37.7749, -122.4194, 37.7749, -122.4194), 0);

    const oneDegreeLat = haversineMeters(0, 0, 1, 0);
    assert.ok(oneDegreeLat > 111_000 && oneDegreeLat < 111_400);

    const ab = haversineMeters(HOME_ZONE.lat, HOME_ZONE.lon, OFFICE_ZONE.lat, OFFICE_ZONE.lon);
    const ba = haversineMeters(OFFICE_ZONE.lat, OFFICE_ZONE.lon, HOME_ZONE.lat, HOME_ZONE.lon);
    assert.equal(ab, ba);
    assert.ok(ab > 2200 && ab < 2400);
  });
});

describe('parseOwnTracksEvent', () => {
  test('validates location and transition payloads from objects and JSON strings', () => {
    const location = parseOwnTracksEvent(
      JSON.stringify({
        _type: 'location',
        lat: 37.7749,
        lon: -122.4194,
        acc: 12,
        tst: 1700000000,
        tid: 'ph',
      }),
    );
    assert.equal(location._type, 'location');
    assert.equal(location.lat, 37.7749);
    assert.equal(location.lon, -122.4194);
    assert.equal(location.acc, 12);
    assert.equal(location.tst, 1700000000);
    assert.equal(location.tid, 'ph');

    const transition = parseOwnTracksEvent({
      _type: 'transition',
      lat: 37.7749,
      lon: -122.4194,
      acc: 8,
      tst: 1700000100,
      tid: 'ph',
      event: 'enter',
      desc: 'Home',
    });
    assert.equal(transition._type, 'transition');
    assert.equal(transition.event, 'enter');
    assert.equal(transition.desc, 'Home');
  });

  test('rejects invalid payloads and out-of-range coordinates', () => {
    assert.throws(() => parseOwnTracksEvent('not-json'));
    assert.throws(() =>
      parseOwnTracksEvent({ _type: 'beacon', lat: 37.77, lon: -122.41, tst: 1700000000 }),
    );
    assert.throws(() =>
      parseOwnTracksEvent({ _type: 'location', lat: 91, lon: -122.41, tst: 1700000000 }),
    );
    assert.throws(() =>
      parseOwnTracksEvent({ _type: 'location', lat: 37.77, lon: -181, tst: 1700000000 }),
    );
    assert.throws(() =>
      parseOwnTracksEvent({
        _type: 'location',
        lat: 37.77,
        lon: -122.41,
        acc: -1,
        tst: 1700000000,
      }),
    );
    assert.throws(() =>
      parseOwnTracksEvent({ _type: 'transition', lat: 37.77, lon: -122.41, tst: 1700000000 }),
    );
    assert.throws(() =>
      parseOwnTracksEvent({
        _type: 'transition',
        lat: 37.77,
        lon: -122.41,
        tst: 1700000000,
        event: 'hover',
      }),
    );
  });
});

describe('createOwnTracksObservationProvider', () => {
  test('emits enter and exit transitions and avoids duplicates on repeated inside points', async () => {
    const provider = createOwnTracksObservationProvider({
      zones: [HOME_ZONE],
      maxAccuracyMeters: 50,
    });

    const initialSources = await provider.sources();
    assert.equal(initialSources.length, 1);
    const token0 = initialSources[0].changeToken;
    assert.ok(typeof token0 === 'string' && token0.length === 64);

    const outside1 = provider.ingest({
      _type: 'location',
      lat: 37.79,
      lon: -122.4,
      acc: 15,
      tst: 1700000000,
      tid: 'ph',
    });
    assert.equal(outside1.accepted, true);
    assert.equal(outside1.transitions.length, 0);
    assert.equal((await provider.sources())[0].changeToken, token0);

    const enter = provider.ingest({
      _type: 'location',
      lat: 37.7749,
      lon: -122.4194,
      acc: 10,
      tst: 1700000060,
      tid: 'ph',
    });
    assert.equal(enter.accepted, true);
    assert.equal(enter.transitions.length, 1);
    assert.equal(enter.transitions[0].data.zoneId, 'home');
    assert.equal(enter.transitions[0].data.transition, 'enter');
    assert.equal(provider.zoneStates().home, true);

    const token1 = (await provider.sources())[0].changeToken;
    assert.notEqual(token1, token0);

    const insideRepeat = provider.ingest({
      _type: 'location',
      lat: 37.775,
      lon: -122.4195,
      acc: 10,
      tst: 1700000120,
      tid: 'ph',
    });
    assert.equal(insideRepeat.accepted, true);
    assert.equal(insideRepeat.transitions.length, 0);
    assert.equal((await provider.sources())[0].changeToken, token1);

    const exit = provider.ingest({
      _type: 'location',
      lat: 37.79,
      lon: -122.4,
      acc: 12,
      tst: 1700000180,
      tid: 'ph',
    });
    assert.equal(exit.accepted, true);
    assert.equal(exit.transitions.length, 1);
    assert.equal(exit.transitions[0].data.zoneId, 'home');
    assert.equal(exit.transitions[0].data.transition, 'exit');
    assert.equal(provider.zoneStates().home, false);

    const token2 = (await provider.sources())[0].changeToken;
    assert.notEqual(token2, token1);
  });

  test('ignores low-accuracy fixes without mutating zone state or changeToken', async () => {
    const provider = createOwnTracksObservationProvider({
      zones: [HOME_ZONE],
      maxAccuracyMeters: 30,
    });

    const tokenBefore = (await provider.sources())[0].changeToken;

    const rejected = provider.ingest({
      _type: 'location',
      lat: 37.7749,
      lon: -122.4194,
      acc: 31,
      tst: 1700000000,
      tid: 'ph',
    });
    assert.equal(rejected.accepted, false);
    assert.equal(rejected.reason, 'low_accuracy');
    assert.equal(rejected.transitions.length, 0);
    assert.equal(provider.zoneStates().home, false);
    assert.equal((await provider.sources())[0].changeToken, tokenBefore);

    const boundaryAccepted = provider.ingest({
      _type: 'location',
      lat: 37.7749,
      lon: -122.4194,
      acc: 30,
      tst: 1700000060,
      tid: 'ph',
    });
    assert.equal(boundaryAccepted.accepted, true);
    assert.equal(boundaryAccepted.transitions.length, 1);
    assert.equal(provider.zoneStates().home, true);
  });

  test('respects zone triggerOn modes and OwnTracks transition events', () => {
    const exitOnlyZone: GeofenceZone = {
      ...HOME_ZONE,
      id: 'warehouse',
      label: 'Warehouse',
      triggerOn: 'exit',
    };
    const provider = createOwnTracksObservationProvider({
      zones: [OFFICE_ZONE, exitOnlyZone],
      maxAccuracyMeters: 100,
    });

    const enterOffice = provider.ingest({
      _type: 'location',
      lat: OFFICE_ZONE.lat,
      lon: OFFICE_ZONE.lon,
      acc: 10,
      tst: 1700000000,
    });
    assert.equal(enterOffice.transitions.length, 1);
    assert.equal(enterOffice.transitions[0].data.zoneId, 'office');
    assert.equal(enterOffice.transitions[0].data.transition, 'enter');

    const exitOffice = provider.ingest({
      _type: 'location',
      lat: 37.75,
      lon: -122.45,
      acc: 10,
      tst: 1700000060,
    });
    assert.equal(exitOffice.transitions.length, 0);
    assert.equal(provider.zoneStates().office, false);

    const reenterOffice = provider.ingest({
      _type: 'location',
      lat: OFFICE_ZONE.lat,
      lon: OFFICE_ZONE.lon,
      acc: 10,
      tst: 1700000120,
    });
    assert.equal(reenterOffice.transitions.length, 1);
    assert.equal(reenterOffice.transitions[0].data.transition, 'enter');

    const enterWarehouse = provider.ingest({
      _type: 'transition',
      lat: exitOnlyZone.lat,
      lon: exitOnlyZone.lon,
      acc: 10,
      tst: 1700000180,
      event: 'enter',
      desc: 'Warehouse',
    });
    assert.equal(enterWarehouse.transitions.length, 0);
    assert.equal(provider.zoneStates().warehouse, true);

    const leaveWarehouse = provider.ingest({
      _type: 'transition',
      lat: exitOnlyZone.lat,
      lon: exitOnlyZone.lon,
      acc: 10,
      tst: 1700000240,
      event: 'leave',
      desc: 'Warehouse',
    });
    assert.equal(leaveWarehouse.transitions.length, 1);
    assert.equal(leaveWarehouse.transitions[0].data.zoneId, 'warehouse');
    assert.equal(leaveWarehouse.transitions[0].data.transition, 'exit');
    assert.equal(provider.zoneStates().warehouse, false);
  });

  test('produces deterministic versions and changeTokens across identical runs', async () => {
    const events = [
      {
        _type: 'location',
        lat: HOME_ZONE.lat,
        lon: HOME_ZONE.lon,
        acc: 5,
        tst: 1700000000,
        tid: 'a1',
      },
      { _type: 'location', lat: 37.8, lon: -122.4, acc: 5, tst: 1700000060, tid: 'a1' },
    ];
    const p1 = createOwnTracksObservationProvider({ zones: [HOME_ZONE], maxAccuracyMeters: 50 });
    const p2 = createOwnTracksObservationProvider({ zones: [HOME_ZONE], maxAccuracyMeters: 50 });

    for (const event of events) {
      p1.ingest(event);
      p2.ingest(event);
    }

    const s1 = await p1.sources();
    const s2 = await p2.sources();
    assert.equal(s1[0].changeToken, s2[0].changeToken);
    assert.equal(s1[0].revision, s2[0].revision);

    const b1 = await p1.read('transitions', {}, new AbortController().signal);
    const b2 = await p2.read('transitions', {}, new AbortController().signal);
    assert.deepEqual(b1, b2);
  });

  test('masks exact coordinates when privacyMaskCoords is true', async () => {
    const exactLat = 37.7749123;
    const exactLon = -122.4194456;

    const maskedProvider = createOwnTracksObservationProvider({
      zones: [HOME_ZONE],
      maxAccuracyMeters: 50,
      privacyMaskCoords: true,
    });
    const unmaskedProvider = createOwnTracksObservationProvider({
      zones: [HOME_ZONE],
      maxAccuracyMeters: 50,
      privacyMaskCoords: false,
    });

    maskedProvider.ingest({
      _type: 'location',
      lat: exactLat,
      lon: exactLon,
      acc: 8,
      tst: 1700000000,
      tid: 'ph',
    });
    unmaskedProvider.ingest({
      _type: 'location',
      lat: exactLat,
      lon: exactLon,
      acc: 8,
      tst: 1700000000,
      tid: 'ph',
    });

    const maskedBatch = await maskedProvider.read('transitions', {}, new AbortController().signal);
    const maskedData = maskedBatch.records[0].data;
    assert.equal('lat' in maskedData, false);
    assert.equal('lon' in maskedData, false);
    assert.equal(maskedData.coordsMasked, true);
    assert.equal(JSON.stringify(maskedData).includes(String(exactLat)), false);
    assert.equal(JSON.stringify(maskedData).includes(String(exactLon)), false);

    const unmaskedBatch = await unmaskedProvider.read(
      'transitions',
      {},
      new AbortController().signal,
    );
    const unmaskedData = unmaskedBatch.records[0].data;
    assert.equal(unmaskedData.lat, exactLat);
    assert.equal(unmaskedData.lon, exactLon);
  });

  test('supports cursor pagination, since/asOf filtering, ids lookup, and abort/cursor errors', async () => {
    const provider = createOwnTracksObservationProvider({
      zones: [HOME_ZONE],
      maxAccuracyMeters: 50,
      pageSize: 3,
    });

    for (let i = 0; i < 7; i += 1) {
      const inside = i % 2 === 0;
      provider.ingest({
        _type: 'location',
        lat: inside ? HOME_ZONE.lat : 37.81,
        lon: inside ? HOME_ZONE.lon : -122.45,
        acc: 10,
        tst: 1700000000 + i * 60,
        tid: 'ph',
      });
    }

    const controller = new AbortController();
    const page1 = await provider.read('transitions', {}, controller.signal);
    assert.equal(page1.records.length, 3);
    assert.ok(page1.nextCursor);

    const page2 = await provider.read(
      'transitions',
      { cursor: page1.nextCursor },
      controller.signal,
    );
    assert.equal(page2.records.length, 3);
    assert.ok(page2.nextCursor);

    const page3 = await provider.read(
      'transitions',
      { cursor: page2.nextCursor },
      controller.signal,
    );
    assert.equal(page3.records.length, 1);
    assert.equal(page3.nextCursor, undefined);

    const allIds = [...page1.records, ...page2.records, ...page3.records].map(
      (record) => record.id,
    );
    assert.equal(new Set(allIds).size, 7);

    const sinceIso = new Date((1700000000 + 4 * 60) * 1000).toISOString();
    const sinceBatch = await provider.read('transitions', { since: sinceIso }, controller.signal);
    assert.equal(sinceBatch.records.length, 3);
    assert.ok(sinceBatch.records.every((record) => Number(record.data.tst) >= 1700000240));

    const asOfIso = new Date((1700000000 + 2 * 60) * 1000).toISOString();
    const asOfBatch = await provider.read('transitions', { asOf: asOfIso }, controller.signal);
    assert.equal(asOfBatch.records.length, 3);
    assert.ok(asOfBatch.records.every((record) => Number(record.data.tst) <= 1700000120));

    const byIds = await provider.read(
      'transitions',
      { ids: [allIds[1], 'missing-record-id'] },
      controller.signal,
    );
    assert.equal(byIds.records.length, 2);
    assert.equal(byIds.records[0].available, true);
    assert.equal(byIds.records[0].id, allIds[1]);
    assert.equal(byIds.records[1].available, false);
    assert.equal(byIds.records[1].version, 'unavailable');

    await assert.rejects(
      provider.read('transitions', { cursor: 'bad-cursor' }, controller.signal),
      ObservationCursorExpired,
    );
    await assert.rejects(
      provider.read('transitions', { cursor: '1700000000:999' }, controller.signal),
      ObservationCursorExpired,
    );
    await assert.rejects(provider.read('unknown-source', {}, controller.signal));
    await assert.rejects(
      provider.read('transitions', { revision: 'stale-revision' }, controller.signal),
    );

    const aborted = new AbortController();
    aborted.abort(new Error('Aborted by test'));
    await assert.rejects(provider.read('transitions', {}, aborted.signal));
  });

  test('rejects duplicate zone IDs in configuration', () => {
    assert.throws(() =>
      createOwnTracksObservationProvider({
        zones: [HOME_ZONE, { ...OFFICE_ZONE, id: HOME_ZONE.id }],
        maxAccuracyMeters: 50,
      }),
    );
  });
});
