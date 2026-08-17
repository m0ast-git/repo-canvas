import { appendEvents, createEvent, getSnapshot } from "./canvas-store.mjs";

const id = { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:>\\-]{0,127}$" };
const stringArray = { type: "array", items: { type: "string" } };
const entityStatus = { type: "string", enum: ["operational", "disabled", "problem", "planned"] };
const relationStatus = { type: "string", enum: ["existing", "planned"] };
const entityKind = { type: "string", enum: ["capability", "module", "service", "process", "store", "interface", "integration", "external", "component"] };
const relationKind = { type: "string", enum: ["runtime", "data", "control", "event", "contract", "dependency"] };

const flowSchema = {
  type: "object", additionalProperties: false,
  properties: {
    id, title: { type: "string" }, trigger: { type: "string" }, outcome: { type: "string" }, steps: { type: "array", items: id },
  },
  required: ["id", "title", "trigger", "outcome", "steps"],
};

const areaSchema = {
  type: "object", additionalProperties: false,
  properties: {
    id, title: { type: "string" }, note: { type: "string" }, color: { type: "string" }, evidence: stringArray, order: { type: "number" },
  },
  required: ["id", "title", "note", "color", "evidence", "order"],
};

const entitySchema = {
  type: "object", additionalProperties: false,
  properties: {
    id, areaId: id, parentId: { type: "string" }, label: { type: "string" }, kind: entityKind,
    status: entityStatus, path: { type: "string" }, purpose: { type: "string" }, note: { type: "string" },
    evidence: stringArray, order: { type: "number" },
  },
  required: ["id", "areaId", "parentId", "label", "kind", "status", "path", "purpose", "note", "evidence", "order"],
};

const relationSchema = {
  type: "object", additionalProperties: false,
  properties: {
    id, from: id, to: id, label: { type: "string" }, kind: relationKind,
    contract: { type: "string" }, mechanism: { type: "string" }, evidence: stringArray, status: relationStatus,
  },
  required: ["id", "from", "to", "label", "kind", "contract", "mechanism", "evidence", "status"],
};

export const ARCHITECT_OUTPUT_SCHEMA = {
  type: "object", additionalProperties: false,
  properties: {
    projectTitle: { type: "string" }, projectSummary: { type: "string" },
    layoutIntent: { type: "string", enum: ["flow", "hierarchy", "core", "domain", "clustered", "hybrid"] },
    layoutDirection: { type: "string", enum: ["RIGHT", "DOWN", "AUTO"] },
    keyFlows: { type: "array", items: flowSchema }, unresolvedQuestions: stringArray,
    areas: { type: "array", items: areaSchema }, entities: { type: "array", items: entitySchema }, relations: { type: "array", items: relationSchema },
    removedAreaIds: { type: "array", items: id }, removedEntityIds: { type: "array", items: id }, removedRelationIds: { type: "array", items: id },
  },
  required: ["projectTitle", "projectSummary", "layoutIntent", "layoutDirection", "keyFlows", "unresolvedQuestions", "areas", "entities", "relations", "removedAreaIds", "removedEntityIds", "removedRelationIds"],
};

const entityChangeSchema = {
  type: "object", additionalProperties: false,
  properties: {
    operation: { type: "string", enum: ["upsert", "remove"] }, entityId: id, areaId: { type: "string" }, parentId: { type: "string" },
    label: { type: "string" }, kind: entityKind, status: entityStatus, path: { type: "string" }, purpose: { type: "string" }, note: { type: "string" },
    evidence: stringArray, reason: { type: "string" },
  },
  required: ["operation", "entityId", "areaId", "parentId", "label", "kind", "status", "path", "purpose", "note", "evidence", "reason"],
};

const relationChangeSchema = {
  type: "object", additionalProperties: false,
  properties: {
    operation: { type: "string", enum: ["upsert", "remove"] }, relationId: id,
    from: { type: "string" }, to: { type: "string" }, label: { type: "string" }, kind: relationKind,
    contract: { type: "string" }, mechanism: { type: "string" }, evidence: stringArray,
    status: relationStatus, reason: { type: "string" },
  },
  required: ["operation", "relationId", "from", "to", "label", "kind", "contract", "mechanism", "evidence", "status", "reason"],
};

export const OBSERVER_OUTPUT_SCHEMA = {
  type: "object", additionalProperties: false,
  properties: {
    workTitle: { type: "string" }, workSummary: { type: "string" },
    workStatus: { type: "string", enum: ["active", "blocked", "done", "stopped"] },
    targetEntityIds: { type: "array", items: id }, entityChanges: { type: "array", items: entityChangeSchema }, relationChanges: { type: "array", items: relationChangeSchema },
  },
  required: ["workTitle", "workSummary", "workStatus", "targetEntityIds", "entityChanges", "relationChanges"],
};

function uniqueIds(items, field) {
  const values = items.map((item) => item[field]);
  if (new Set(values).size !== values.length) throw new Error(`Duplicate ${field} in model response`);
}

function orderEntities(items) {
  const pending = new Map(items.map((item) => [item.id, item]));
  const ordered = [];
  while (pending.size) {
    const ready = [...pending.values()].filter((item) => !item.parentId || !pending.has(item.parentId));
    if (!ready.length) throw new Error("Entity parent hierarchy contains a cycle");
    ready.sort((a, b) => Number(a.order || 0) - Number(b.order || 0));
    for (const item of ready) { ordered.push(item); pending.delete(item.id); }
  }
  return ordered;
}

export function validateArchitecture(value, snapshot = getSnapshot()) {
  if (!value || !Array.isArray(value.areas) || !Array.isArray(value.entities) || !Array.isArray(value.relations)) throw new Error("Architect response is missing semantic arrays");
  uniqueIds(value.areas, "id"); uniqueIds(value.entities, "id"); uniqueIds(value.relations, "id");
  const removedAreas = new Set(value.removedAreaIds || []);
  const removedEntities = new Set(value.removedEntityIds || []);
  const areaIds = new Set([...snapshot.areas.filter((item) => !removedAreas.has(item.id)).map((item) => item.id), ...value.areas.map((item) => item.id)]);
  const entityIds = new Set([...snapshot.entities.filter((item) => !removedEntities.has(item.id) && !removedAreas.has(item.areaId)).map((item) => item.id), ...value.entities.map((item) => item.id)]);
  const entitiesById = new Map([...snapshot.entities, ...value.entities].map((item) => [item.id, item]));
  for (const entity of value.entities) {
    if (!areaIds.has(entity.areaId)) throw new Error(`Unknown entity area '${entity.areaId}'`);
    if (entity.parentId) {
      const parent = entitiesById.get(entity.parentId);
      if (!parent || removedEntities.has(parent.id)) throw new Error(`Unknown entity parent '${entity.parentId}'`);
      if (parent.areaId !== entity.areaId) throw new Error(`Entity parent '${entity.parentId}' belongs to another area`);
    }
  }
  orderEntities(value.entities);
  for (const relation of value.relations) if (!entityIds.has(relation.from) || !entityIds.has(relation.to)) throw new Error(`Unknown relation endpoint '${relation.id}'`);
  for (const flow of value.keyFlows || []) for (const step of flow.steps || []) if (!entityIds.has(step)) throw new Error(`Unknown key-flow step '${step}'`);
  return value;
}

export function architectureEvents(value, { actor = "architect", refresh = false } = {}) {
  const snapshot = getSnapshot();
  validateArchitecture(value, snapshot);
  const events = [createEvent("map.upsert", { actor, payload: {
    projectTitle: value.projectTitle, projectSummary: value.projectSummary || "", layoutIntent: value.layoutIntent || "domain",
    layoutDirection: value.layoutDirection || "AUTO", keyFlows: value.keyFlows || [], unresolvedQuestions: value.unresolvedQuestions || [],
  } })];
  for (const area of value.areas) events.push(createEvent("area.upsert", { actor, payload: area }));
  for (const entity of orderEntities(value.entities)) events.push(createEvent("entity.upsert", { actor, payload: entity }));
  for (const relation of value.relations) events.push(createEvent("relation.upsert", { actor, payload: relation }));
  if (refresh) {
    for (const relationId of value.removedRelationIds || []) events.push(createEvent("relation.remove", { actor, payload: { id: relationId, reason: "Architect refresh" } }));
    for (const entityId of value.removedEntityIds || []) events.push(createEvent("entity.remove", { actor, payload: { id: entityId, reason: "Architect refresh" } }));
    for (const areaId of value.removedAreaIds || []) events.push(createEvent("area.remove", { actor, payload: { id: areaId, reason: "Architect refresh" } }));
  }
  return events;
}

export function applyArchitecture(value, options = {}) {
  const events = architectureEvents(value, options);
  if (events.length) appendEvents(events);
  return { events: events.length, snapshot: getSnapshot() };
}

export function observerEvents(decision, context) {
  const snapshot = getSnapshot();
  const existingEntities = new Map(snapshot.entities.map((item) => [item.id, item]));
  const existingRelations = new Map(snapshot.relations.map((item) => [item.id, item]));
  const upserts = [];
  const removals = [];
  const targets = [...new Set((decision.targetEntityIds || []).filter((target) => existingEntities.has(target) || decision.entityChanges?.some((change) => change.operation === "upsert" && change.entityId === target)))];
  const workEvent = createEvent("work.upsert", { actor: "observer", payload: {
    id: context.workId, title: decision.workTitle || "Agent work", status: decision.workStatus,
    targets, note: decision.workSummary || "", provisional: targets.length === 0, session: context.session,
  } });
  for (const change of decision.entityChanges || []) {
    if (change.operation === "remove") {
      if (context.final && existingEntities.has(change.entityId)) removals.push(createEvent("entity.remove", { actor: "observer", payload: { id: change.entityId, reason: change.reason || decision.workSummary } }));
      continue;
    }
    upserts.push(createEvent("entity.upsert", { actor: "observer", payload: {
      id: change.entityId, areaId: change.areaId, parentId: change.parentId || "", label: change.label,
      kind: change.kind || "component", status: change.status, path: change.path, purpose: change.purpose, note: change.note,
      evidence: change.evidence || [],
    } }));
  }
  for (const change of decision.relationChanges || []) {
    if (change.operation === "remove") {
      if (context.final && existingRelations.has(change.relationId)) removals.unshift(createEvent("relation.remove", { actor: "observer", payload: { id: change.relationId, reason: change.reason || decision.workSummary } }));
      continue;
    }
    upserts.push(createEvent("relation.upsert", { actor: "observer", payload: {
      id: change.relationId, from: change.from, to: change.to, label: change.label, kind: change.kind || "runtime",
      contract: change.contract || "", mechanism: change.mechanism || "", evidence: change.evidence || [], status: change.status,
    } }));
  }
  return [...upserts, workEvent, ...removals];
}

export function applyObserverDecision(decision, context) {
  const events = observerEvents(decision, context);
  appendEvents(events);
  return { events: events.length, snapshot: getSnapshot() };
}
