export const ENTITY_STATUSES = new Set(["operational", "disabled", "problem", "planned"]);
export const WORK_STATUSES = new Set(["planned", "active", "blocked", "done", "stopped"]);
export const ACTIVITY_LEVELS = new Set(["info", "success", "warning", "error"]);
export const SESSION_SURFACES = new Set([
  "codex-app", "claude-app", "kimi-app", "codex-cli", "claude-cli", "kimi-cli", "qwen-cli", "grok-cli",
]);
export const EVENT_TYPES = new Set([
  "area.upsert", "area.remove", "entity.upsert", "entity.remove",
  "relation.upsert", "relation.remove", "work.upsert",
  "activity.log",
]);
const EVENT_FIELDS = new Set(["v", "id", "ts", "type", "actor", "payload"]);

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:>\-]{0,127}$/;

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireString(errors, value, field, { max = 4000, id = false } = {}) {
  if (typeof value !== "string" || !value.trim()) {
    errors.push(`${field} must be a non-empty string`);
    return;
  }
  if (value.length > max) errors.push(`${field} exceeds ${max} characters`);
  if (id && (!IDENTIFIER.test(value) || value.includes("::"))) {
    errors.push(`${field} must be a stable identifier without whitespace or '::'`);
  }
}

function optionalString(errors, value, field, max = 4000) {
  if (value === undefined) return;
  if (typeof value !== "string") errors.push(`${field} must be a string`);
  else if (value.length > max) errors.push(`${field} exceeds ${max} characters`);
}

function requireStatus(errors, value, field, allowed) {
  if (!allowed.has(value)) errors.push(`${field} has unsupported value '${String(value)}'`);
}

function requireFiniteNumber(errors, value, field, { integer = false, min = null } = {}) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    errors.push(`${field} must be a finite number`);
    return;
  }
  if (integer && !Number.isInteger(value)) errors.push(`${field} must be an integer`);
  if (min !== null && value < min) errors.push(`${field} must be at least ${min}`);
}

function requireIdList(errors, value, field, { allowEmpty = false } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    errors.push(`${field} must be ${allowEmpty ? "an" : "a non-empty"} array`);
    return;
  }
  const seen = new Set();
  value.forEach((item, index) => {
    requireString(errors, item, `${field}[${index}]`, { max: 128, id: true });
    if (seen.has(item)) errors.push(`${field} contains duplicate '${item}'`);
    seen.add(item);
  });
}

function optionalStringList(errors, value, field) {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    errors.push(`${field} must be an array`);
    return;
  }
  value.forEach((item, index) => optionalString(errors, item, `${field}[${index}]`, 500));
}

function validateSessionLocator(errors, value) {
  if (value === undefined) return;
  if (!plainObject(value)) {
    errors.push("payload.session must be an object");
    return;
  }
  requireStatus(errors, value.kind, "payload.session.kind", SESSION_SURFACES);
  const idRequired = value.kind !== "kimi-app";
  if (idRequired) requireString(errors, value.id, "payload.session.id", { max: 160, id: true });
  else optionalString(errors, value.id, "payload.session.id", 160);
  optionalString(errors, value.title, "payload.session.title", 240);
  optionalString(errors, value.cwd, "payload.session.cwd", 1000);
  if (value.pid !== undefined) requireFiniteNumber(errors, value.pid, "payload.session.pid", { integer: true, min: 1 });
}

export function validateEvent(event) {
  const errors = [];
  if (!plainObject(event)) return ["event must be an object"];
  for (const field of Object.keys(event)) if (!EVENT_FIELDS.has(field)) errors.push(`unknown event field '${field}'`);
  if (event.v !== 1) errors.push(`unsupported event version '${String(event.v)}'`);
  requireString(errors, event.id, "id", { max: 160, id: true });
  requireString(errors, event.ts, "ts", { max: 64 });
  if (typeof event.ts === "string" && Number.isNaN(Date.parse(event.ts))) errors.push("ts must be an RFC3339 timestamp");
  requireString(errors, event.type, "type", { max: 80 });
  if (typeof event.type === "string" && !EVENT_TYPES.has(event.type)) errors.push(`unknown event type '${event.type}'`);
  requireString(errors, event.actor, "actor", { max: 64, id: true });
  if (!plainObject(event.payload)) {
    errors.push("payload must be an object");
    return errors;
  }

  const payload = event.payload;
  if (event.type === "area.upsert") {
    requireString(errors, payload.id, "payload.id", { max: 128, id: true });
    requireString(errors, payload.title, "payload.title", { max: 240 });
    optionalString(errors, payload.note, "payload.note", 2000);
    for (const field of ["x", "y", "width", "height", "order"]) {
      if (payload[field] !== undefined) requireFiniteNumber(errors, payload[field], `payload.${field}`);
    }
  } else if (event.type === "area.remove") {
    requireString(errors, payload.id, "payload.id", { max: 128, id: true });
    optionalString(errors, payload.reason, "payload.reason", 2000);
  } else if (event.type === "entity.upsert") {
    requireString(errors, payload.id, "payload.id", { max: 128, id: true });
    requireString(errors, payload.areaId, "payload.areaId", { max: 128, id: true });
    requireString(errors, payload.label, "payload.label", { max: 240 });
    requireStatus(errors, payload.status, "payload.status", ENTITY_STATUSES);
    optionalString(errors, payload.path, "payload.path", 1000);
    optionalString(errors, payload.purpose, "payload.purpose", 2000);
    optionalString(errors, payload.note, "payload.note", 2000);
    optionalStringList(errors, payload.inputs, "payload.inputs");
    optionalStringList(errors, payload.outputs, "payload.outputs");
    optionalStringList(errors, payload.dependsOn, "payload.dependsOn");
    for (const field of ["x", "y", "order"]) if (payload[field] !== undefined) requireFiniteNumber(errors, payload[field], `payload.${field}`);
  } else if (event.type === "entity.remove") {
    requireString(errors, payload.id, "payload.id", { max: 128, id: true });
    optionalString(errors, payload.reason, "payload.reason", 2000);
  } else if (event.type === "relation.upsert") {
    requireString(errors, payload.id, "payload.id", { max: 128, id: true });
    requireString(errors, payload.from, "payload.from", { max: 128, id: true });
    requireString(errors, payload.to, "payload.to", { max: 128, id: true });
    optionalString(errors, payload.label, "payload.label", 240);
    if (!new Set(["existing", "planned"]).has(payload.status)) errors.push(`payload.status has unsupported value '${String(payload.status)}'`);
  } else if (event.type === "relation.remove") {
    requireString(errors, payload.id, "payload.id", { max: 128, id: true });
    optionalString(errors, payload.reason, "payload.reason", 2000);
  } else if (event.type === "work.upsert") {
    requireString(errors, payload.id, "payload.id", { max: 128, id: true });
    requireString(errors, payload.title, "payload.title", { max: 240 });
    requireStatus(errors, payload.status, "payload.status", WORK_STATUSES);
    requireIdList(errors, payload.targets, "payload.targets", { allowEmpty: payload.provisional === true });
    optionalString(errors, payload.note, "payload.note", 2000);
    validateSessionLocator(errors, payload.session);
  } else if (event.type === "activity.log") {
    requireString(errors, payload.message, "payload.message", { max: 4000 });
    if (payload.level !== undefined) requireStatus(errors, payload.level, "payload.level", ACTIVITY_LEVELS);
  }
  return errors;
}

export function validateEventSequence(eventsWithLines) {
  const errors = [];
  const eventIds = new Set();
  const areas = new Set();
  const entities = new Set();
  const entityAreas = new Map();

  for (const { event, line } of eventsWithLines) {
    if (eventIds.has(event.id)) errors.push({ line, id: event.id, message: "duplicate event id" });
    eventIds.add(event.id);
    if (event.type === "area.upsert") areas.add(event.payload.id);
    if (event.type === "area.remove") {
      areas.delete(event.payload.id);
      for (const [entityId, areaId] of entityAreas) {
        if (areaId === event.payload.id) {
          entities.delete(entityId);
          entityAreas.delete(entityId);
        }
      }
    }
    if (event.type === "entity.upsert") {
      entities.add(event.payload.id);
      entityAreas.set(event.payload.id, event.payload.areaId);
      if (!areas.has(event.payload.areaId)) errors.push({ line, id: event.id, message: `entity area '${event.payload.areaId}' does not exist` });
    }
    if (event.type === "entity.remove") {
      entities.delete(event.payload.id);
      entityAreas.delete(event.payload.id);
    }
    if (event.type === "relation.upsert") {
      if (!entities.has(event.payload.from)) errors.push({ line, id: event.id, message: `relation source '${event.payload.from}' does not exist` });
      if (!entities.has(event.payload.to)) errors.push({ line, id: event.id, message: `relation target '${event.payload.to}' does not exist` });
    }
    if (event.type === "work.upsert") {
      for (const target of event.payload.targets) if (!entities.has(target)) errors.push({ line, id: event.id, message: `work target '${target}' does not exist` });
    }
  }
  return errors;
}
