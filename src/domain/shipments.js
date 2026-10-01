const CARGO_CLASSES = [
  'container',
  'refrigerated',
  'bulk',
  'breakbulk',
  'hazmat',
  'vehicle-carrier',
  'project-cargo',
  'livestock'
];

const STATUSES = [
  'SCHEDULED',
  'LOADING',
  'IN_TRANSIT',
  'AT_ANCHORAGE',
  'DELAYED',
  'CUSTOMS_HOLD',
  'DISCHARGING',
  'DELIVERED'
];

const PORTS = [
  { code: 'SGSIN', name: 'Singapore', region: 'APAC', lon: 103.82, lat: 1.26 },
  { code: 'NLRTM', name: 'Rotterdam', region: 'EMEA', lon: 4.48, lat: 51.92 },
  { code: 'DEHAM', name: 'Hamburg', region: 'EMEA', lon: 9.99, lat: 53.55 },
  { code: 'CNSHA', name: 'Shanghai', region: 'APAC', lon: 121.47, lat: 31.23 },
  { code: 'INNSA', name: 'Nhava Sheva', region: 'APAC', lon: 72.95, lat: 18.95 },
  { code: 'AEJEA', name: 'Jebel Ali', region: 'MEA', lon: 55.03, lat: 25.01 },
  { code: 'USLAX', name: 'Los Angeles', region: 'AMER', lon: -118.26, lat: 33.74 },
  { code: 'BRSSZ', name: 'Santos', region: 'AMER', lon: -46.31, lat: -23.98 },
  { code: 'ZADUR', name: 'Durban', region: 'MEA', lon: 31.05, lat: -29.87 },
  { code: 'KRPUS', name: 'Busan', region: 'APAC', lon: 129.07, lat: 35.18 }
];

const EQUIPMENT = ['40HC', '40GP', '20GP', '45HC', '20RF', '40RF'];

export class ValidationError extends Error {
  constructor(message, field) {
    super(message);
    this.name = 'ValidationError';
    this.status = 400;
    this.code = 'E_VALIDATION';
    if (field) this.field = field;
  }
}

function hashSeed(seed) {
  let value = seed >>> 0;
  return () => {
    value = (value + 0x6d2b79f5) >>> 0;
    let t = value;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(rand, list) {
  return list[Math.floor(rand() * list.length)];
}

export class ShipmentRepository {
  constructor({ count = 500, seed = 42, now = () => Date.now() } = {}) {
    this.now = now;
    this.rand = hashSeed(seed);
    this.items = new Map();
    this.seq = 100000;
    for (let i = 0; i < count; i += 1) {
      const shipment = this.generate();
      this.items.set(shipment.id, shipment);
    }
  }

  generate(overrides = {}) {
    const rand = this.rand;
    const origin = pick(rand, PORTS);
    let destination = pick(rand, PORTS);
    if (destination.code === origin.code) {
      destination = PORTS[(PORTS.indexOf(origin) + 3) % PORTS.length];
    }
    this.seq += 1;
    const now = this.now();
    return {
      id: `SHP-${this.seq}`,
      reference: overrides.reference ?? `PO-${Math.floor(rand() * 899999) + 100000}`,
      vessel: overrides.vessel ?? `${pick(rand, ['MV', 'MSC', 'CMA', 'ONE', 'HAP', 'EVG'])} ${pick(rand, ['Meridian', 'Nordic Star', 'Baltic Trader', 'Cape Horizon', 'Ionian Wave', 'Malabar Express', 'Levant Runner'])}`,
      imo: overrides.imo ?? String(9000000 + Math.floor(rand() * 999999)),
      status: overrides.status ?? pick(rand, STATUSES),
      cargoClass: overrides.cargoClass ?? pick(rand, CARGO_CLASSES),
      equipment: overrides.equipment ?? pick(rand, EQUIPMENT),
      originPort: overrides.originPort ?? origin.code,
      destinationPort: overrides.destinationPort ?? destination.code,
      pieces: overrides.pieces ?? 1 + Math.floor(rand() * 40),
      weightKg: overrides.weightKg ?? 500 + Math.floor(rand() * 24000),
      volumeCbm: overrides.volumeCbm ?? Number((1 + rand() * 60).toFixed(2)),
      temperatureC: overrides.temperatureC ?? (overrides.cargoClass === 'refrigerated' ? Number((-20 + rand() * 8).toFixed(1)) : null),
      eta: overrides.eta ?? new Date(now + Math.floor((rand() * 96 - 12) * 3600000)).toISOString(),
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
      version: 1
    };
  }

  get size() {
    return this.items.size;
  }

  all() {
    return [...this.items.values()];
  }

  get(id) {
    return this.items.get(id);
  }

  insert(shipment) {
    if (this.items.has(shipment.id)) return null;
    this.items.set(shipment.id, shipment);
    return shipment;
  }

  update(id, patch) {
    const existing = this.items.get(id);
    if (existing === undefined) return undefined;
    const next = {
      ...existing,
      ...patch,
      id: existing.id,
      createdAt: existing.createdAt,
      version: existing.version + 1,
      updatedAt: new Date(this.now()).toISOString()
    };
    this.items.set(id, next);
    return next;
  }

  remove(id) {
    return this.items.delete(id);
  }

  query({ status, cargoClass, originPort, destinationPort, attentionOnly, q } = {}) {
    let rows = this.all();
    if (status) rows = rows.filter((row) => row.status === status);
    if (cargoClass) rows = rows.filter((row) => row.cargoClass === cargoClass);
    if (originPort) rows = rows.filter((row) => row.originPort === originPort);
    if (destinationPort) rows = rows.filter((row) => row.destinationPort === destinationPort);
    if (attentionOnly) {
      rows = rows.filter((row) => row.status === 'DELAYED' || row.status === 'CUSTOMS_HOLD' || row.status === 'AT_ANCHORAGE');
    }
    if (q) {
      const needle = String(q).toLowerCase();
      rows = rows.filter((row) =>
        [row.id, row.reference, row.vessel, row.imo, row.originPort, row.destinationPort, row.cargoClass, row.status]
          .map((value) => String(value ?? '').toLowerCase())
          .some((value) => value.includes(needle))
      );
    }
    return rows;
  }

  facets() {
    const byStatus = {};
    const byCargo = {};
    const byOrigin = {};
    const byDestination = {};
    for (const row of this.items.values()) {
      byStatus[row.status] = (byStatus[row.status] || 0) + 1;
      byCargo[row.cargoClass] = (byCargo[row.cargoClass] || 0) + 1;
      byOrigin[row.originPort] = (byOrigin[row.originPort] || 0) + 1;
      byDestination[row.destinationPort] = (byDestination[row.destinationPort] || 0) + 1;
    }
    return { byStatus, byCargo, byOrigin, byDestination };
  }
}

export function parseShipmentInput(body) {
  if (body === null || typeof body !== 'object') {
    throw new ValidationError('request body must be a JSON object');
  }
  const required = ['originPort', 'destinationPort', 'cargoClass', 'pieces', 'weightKg'];
  for (const field of required) {
    if (body[field] === undefined || body[field] === null || body[field] === '') {
      throw new ValidationError(`${field} is required`, field);
    }
  }
  if (!PORTS.some((port) => port.code === body.originPort)) {
    throw new ValidationError(`unknown originPort: ${body.originPort}`, 'originPort');
  }
  if (!PORTS.some((port) => port.code === body.destinationPort)) {
    throw new ValidationError(`unknown destinationPort: ${body.destinationPort}`, 'destinationPort');
  }
  if (body.originPort === body.destinationPort) {
    throw new ValidationError('originPort and destinationPort must differ', 'destinationPort');
  }
  if (!CARGO_CLASSES.includes(body.cargoClass)) {
    throw new ValidationError(`unknown cargoClass: ${body.cargoClass}`, 'cargoClass');
  }
  const pieces = Number(body.pieces);
  const weightKg = Number(body.weightKg);
  if (!Number.isInteger(pieces) || pieces < 1 || pieces > 1000) {
    throw new ValidationError('pieces must be an integer between 1 and 1000', 'pieces');
  }
  if (!Number.isFinite(weightKg) || weightKg <= 0 || weightKg > 30000) {
    throw new ValidationError('weightKg must be between 0 and 30000', 'weightKg');
  }
  if (body.temperatureC !== undefined && body.temperatureC !== null) {
    const temperature = Number(body.temperatureC);
    if (!Number.isFinite(temperature) || temperature < -40 || temperature > 40) {
      throw new ValidationError('temperatureC must be between -40 and 40', 'temperatureC');
    }
  }
  return {
    originPort: body.originPort,
    destinationPort: body.destinationPort,
    cargoClass: body.cargoClass,
    pieces,
    weightKg,
    volumeCbm: body.volumeCbm === undefined ? undefined : Number(body.volumeCbm),
    equipment: body.equipment ?? '40HC',
    temperatureC: body.temperatureC === undefined ? null : Number(body.temperatureC)
  };
}

export function allowedPatchFields() {
  return ['status', 'cargoClass', 'pieces', 'weightKg', 'volumeCbm', 'equipment', 'temperatureC', 'eta', 'destinationPort'];
}

export { CARGO_CLASSES, STATUSES, PORTS, EQUIPMENT };
