import test from 'node:test';
import assert from 'node:assert/strict';
import { ShipmentRepository, parseShipmentInput, ValidationError } from '../src/domain/shipments.js';
import { QuoteService } from '../src/domain/quoteService.js';

test('repository generates the requested number of shipments with unique ids', () => {
  const repo = new ShipmentRepository({ count: 200 });
  assert.equal(repo.size, 200);
  const ids = new Set(repo.all().map((row) => row.id));
  assert.equal(ids.size, 200);
});

test('generation is deterministic for a fixed seed and clock', () => {
  const now = () => 1700000000000;
  const a = new ShipmentRepository({ count: 25, seed: 7, now });
  const b = new ShipmentRepository({ count: 25, seed: 7, now });
  assert.deepEqual(a.all(), b.all());
});

test('different seeds produce different data', () => {
  const a = new ShipmentRepository({ count: 25, seed: 1 });
  const b = new ShipmentRepository({ count: 25, seed: 2 });
  assert.notDeepEqual(a.all(), b.all());
});

test('origin and destination always differ', () => {
  const repo = new ShipmentRepository({ count: 300, seed: 11 });
  for (const row of repo.all()) {
    assert.notEqual(row.originPort, row.destinationPort);
  }
});

test('query filters by status', () => {
  const repo = new ShipmentRepository({ count: 200, seed: 3 });
  const postponed = repo.query({ status: 'DELAYED' });
  assert.equal(postponed.every((row) => row.status === 'DELAYED'), true);
  assert.equal(postponed.length, repo.all().filter((row) => row.status === 'DELAYED').length);
});

test('attentionOnly selects delayed, held and anchored shipments', () => {
  const repo = new ShipmentRepository({ count: 300, seed: 4 });
  const rows = repo.query({ attentionOnly: true });
  const allowed = new Set(['DELAYED', 'CUSTOMS_HOLD', 'AT_ANCHORAGE']);
  assert.equal(rows.every((row) => allowed.has(row.status)), true);
});

test('query combines filters conjunctively', () => {
  const repo = new ShipmentRepository({ count: 400, seed: 5 });
  const rows = repo.query({ cargoClass: 'refrigerated', status: 'IN_TRANSIT' });
  assert.equal(rows.every((row) => row.cargoClass === 'refrigerated' && row.status === 'IN_TRANSIT'), true);
});

test('free text query is case insensitive across fields', () => {
  const repo = new ShipmentRepository({ count: 100, seed: 6 });
  const target = repo.all()[10];
  const rows = repo.query({ q: target.vessel.toLowerCase() });
  assert.equal(rows.some((row) => row.id === target.id), true);
});

test('update bumps the version and preserves id and createdAt', () => {
  const repo = new ShipmentRepository({ count: 5, seed: 8, now: () => 1000 });
  const original = repo.all()[0];
  const updated = repo.update(original.id, { status: 'DELIVERED' });
  assert.equal(updated.id, original.id);
  assert.equal(updated.createdAt, original.createdAt);
  assert.equal(updated.version, original.version + 1);
  assert.equal(updated.status, 'DELIVERED');
});

test('update of a missing shipment returns undefined', () => {
  const repo = new ShipmentRepository({ count: 5 });
  assert.equal(repo.update('SHP-999999', { status: 'DELIVERED' }), undefined);
});

test('remove deletes a shipment', () => {
  const repo = new ShipmentRepository({ count: 3 });
  const target = repo.all()[0];
  assert.equal(repo.remove(target.id), true);
  assert.equal(repo.get(target.id), undefined);
  assert.equal(repo.remove(target.id), false);
});

test('insert refuses a duplicate id', () => {
  const repo = new ShipmentRepository({ count: 2 });
  const existing = repo.all()[0];
  assert.equal(repo.insert(existing), null);
});

test('facets count every shipment exactly once per dimension', () => {
  const repo = new ShipmentRepository({ count: 250, seed: 9 });
  const facets = repo.facets();
  const statusTotal = Object.values(facets.byStatus).reduce((sum, n) => sum + n, 0);
  assert.equal(statusTotal, 250);
  assert.equal(Object.values(facets.byCargo).reduce((sum, n) => sum + n, 0), 250);
});

test('valid input is normalised', () => {
  const parsed = parseShipmentInput({
    originPort: 'SGSIN',
    destinationPort: 'NLRTM',
    cargoClass: 'container',
    pieces: '5',
    weightKg: '1200.5'
  });
  assert.equal(parsed.pieces, 5);
  assert.equal(parsed.weightKg, 1200.5);
  assert.equal(parsed.equipment, '40HC');
});

test('required fields are enforced', () => {
  assert.throws(() => parseShipmentInput({ originPort: 'SGSIN' }), ValidationError);
  assert.throws(() => parseShipmentInput(null), ValidationError);
});

test('unknown ports and cargo classes are rejected', () => {
  const base = { originPort: 'SGSIN', destinationPort: 'NLRTM', cargoClass: 'container', pieces: 1, weightKg: 100 };
  assert.throws(() => parseShipmentInput({ ...base, originPort: 'XXXXX' }), ValidationError);
  assert.throws(() => parseShipmentInput({ ...base, cargoClass: 'teapots' }), ValidationError);
});

test('matching origin and destination is rejected', () => {
  assert.throws(
    () => parseShipmentInput({ originPort: 'SGSIN', destinationPort: 'SGSIN', cargoClass: 'container', pieces: 1, weightKg: 100 }),
    ValidationError
  );
});

test('piece and weight bounds are enforced', () => {
  const base = { originPort: 'SGSIN', destinationPort: 'NLRTM', cargoClass: 'container', weightKg: 100 };
  assert.throws(() => parseShipmentInput({ ...base, pieces: 0 }), ValidationError);
  assert.throws(() => parseShipmentInput({ ...base, pieces: 2.5 }), ValidationError);
  assert.throws(() => parseShipmentInput({ ...base, pieces: 1001 }), ValidationError);
  assert.throws(() => parseShipmentInput({ ...base, pieces: 1, weightKg: 0 }), ValidationError);
  assert.throws(() => parseShipmentInput({ ...base, pieces: 1, weightKg: 40000 }), ValidationError);
});

test('temperature bounds are enforced only when present', () => {
  const base = { originPort: 'SGSIN', destinationPort: 'NLRTM', cargoClass: 'container', pieces: 1, weightKg: 100 };
  assert.doesNotThrow(() => parseShipmentInput({ ...base, temperatureC: null }));
  assert.throws(() => parseShipmentInput({ ...base, temperatureC: 100 }), ValidationError);
});

test('quote key buckets weight to avoid cache fragmentation', () => {
  const a = QuoteService.keyFor({ originPort: 'SGSIN', destinationPort: 'NLRTM', cargoClass: 'container', weightKg: 1000 });
  const b = QuoteService.keyFor({ originPort: 'SGSIN', destinationPort: 'NLRTM', cargoClass: 'container', weightKg: 1200 });
  const c = QuoteService.keyFor({ originPort: 'SGSIN', destinationPort: 'NLRTM', cargoClass: 'container', weightKg: 9000 });
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('great-circle distance and pricing vary by route', () => {
  const service = new QuoteService({ latencyMs: 0 });
  return Promise.all([
    service.quote({ originPort: 'SGSIN', destinationPort: 'NLRTM', cargoClass: 'container', weightKg: 1000 }),
    service.quote({ originPort: 'SGSIN', destinationPort: 'CNSHA', cargoClass: 'container', weightKg: 1000 })
  ]).then(([long, short]) => {
    assert.equal(long.cached.distanceKm > short.cached.distanceKm, true);
    assert.equal(long.cached.priceUsd > short.cached.priceUsd, true);
  });
});

test('cargo class multiplier raises the price', async () => {
  const service = new QuoteService({ latencyMs: 0 });
  const plain = await service.quote({ originPort: 'SGSIN', destinationPort: 'NLRTM', cargoClass: 'container', weightKg: 1000 });
  const project = await service.quote({ originPort: 'SGSIN', destinationPort: 'NLRTM', cargoClass: 'project-cargo', weightKg: 1000 });
  assert.equal(project.cached.priceUsd > plain.cached.priceUsd, true);
});
