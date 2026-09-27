import { appendEvents, createEvent, getSnapshot } from "./canvas-store.mjs";
import { semanticSignature } from "./semantic-signature.mjs";

const id = { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:>\\-]{0,127}$" };
const stringArray = { type: "array", items: { type: "string" } };
const entityStatus = { type: "string", enum: ["operational", "disabled", "problem", "planned"] };
const relationStatus = { type: "string", enum: ["existing", "planned"] };
const entityKind = { type: "string", enum: ["capability", "module", "service", "process", "store", "interface", "integration", "external", "component", "person"] };
const relationKind = { type: "string", enum: ["runtime", "data", "control", "event", "contract", "dependency"] };

const flowSchema = {
  type: "object", additionalProperties: false,
  properties: {
    id, title: { type: "string" }, trigger: { type: "string" }, outcome: { type: "string" },
    transitions: {type:"array",items:{type:"object",additionalProperties:false,properties:{relationId:id,condition:{type:"string"}},required:["relationId","condition"]}},
  },
  required: ["id", "title", "trigger", "outcome", "transitions"],
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
    id, areaId: { type: "string", maxLength: 128 }, parentId: { type: "string" }, label: { type: "string" }, kind: entityKind,
    status: entityStatus, path: { type: "string" }, purpose: { type: "string" }, note: { type: "string" },
    evidence: stringArray, order: { type: "number" }, technicalName: {type:"string"}, inputs:stringArray, outputs:stringArray, acceptanceCriteria:stringArray,
  },
  required: ["id", "areaId", "parentId", "label", "kind", "status", "path", "purpose", "note", "evidence", "order", "technicalName", "inputs", "outputs", "acceptanceCriteria"],
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

const reviewIssueSchema = {
  type: "object", additionalProperties: false,
  properties: {
    severity: { type: "string", enum: ["critical", "warning"] },
    scope: { type: "string", enum: ["map", "area", "entity", "relation", "flow"] },
    id: { type: "string" }, message: { type: "string" }, recommendation: { type: "string" },
  },
  required: ["severity", "scope", "id", "message", "recommendation"],
};

export const ARCHITECT_REVIEW_SCHEMA = {
  type: "object", additionalProperties: false,
  properties: {
    passed: { type: "boolean" }, summary: { type: "string" },
    answers: {
      type: "object", additionalProperties: false,
      properties: {
        project: { type: "string" }, composition: { type: "string" }, lifecycle: { type: "string" },
      },
      required: ["project", "composition", "lifecycle"],
    },
    issues: { type: "array", items: reviewIssueSchema },
  },
  required: ["passed", "summary", "answers", "issues"],
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

export function orderEntities(items) {
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

export function normalizeArchitecture(value,snapshot=getSnapshot()) {
  const next=structuredClone(value);
  const flowRelations=new Map([...snapshot.relations,...(next.relations||[])].filter(item=>!(next.removedRelationIds||[]).includes(item.id)).map(item=>[item.id,item]));
  for(const flow of next.keyFlows||[]) {
    const path=(flow.transitions||[]).map(item=>flowRelations.get(item.relationId));
    if(path.length&&path.every(Boolean)&&path.every((item,index)=>!index||path[index-1].to===item.from))flow.steps=[path[0].from,...path.map(item=>item.to)];
    else flow.steps ||= [];
  }
  for(const [key,items] of [["removedAreaIds",snapshot.areas],["removedEntityIds",snapshot.entities],["removedRelationIds",snapshot.relations]]) next[key]=(next[key]||[]).filter(id=>items.some(item=>item.id===id));
  if(snapshot.map?.skeleton)for(const [removed,kind] of [["removedAreaIds","areas"],["removedEntityIds","entities"],["removedRelationIds","relations"]])next[removed]=[...new Set([...next[removed],...snapshot[kind].filter(item=>!(next[kind]||[]).some(candidate=>candidate.id===item.id)&&!item.ownerLabel&&!item.ownerTitle&&!item.ownerGroup).map(item=>item.id)])];
  for(const original of snapshot.entities.filter(item=>item.ownerGroup||Object.hasOwn(item,"ownerParentId")||Object.hasOwn(item,"ownerAreaId"))) {
    if(original.ownerGroup){next.removedEntityIds=next.removedEntityIds.filter(id=>id!==original.id);if(!next.entities.some(item=>item.id===original.id))next.entities.push({...original});}
    const incoming=next.entities.find(item=>item.id===original.id);
    if(!incoming)continue;
    if(Object.hasOwn(original,"ownerParentId"))incoming.parentId=original.ownerParentId;
    if(Object.hasOwn(original,"ownerAreaId")||original.ownerGroup)incoming.areaId=original.ownerAreaId??original.areaId;
    if(incoming.parentId){const parent=next.entities.find(item=>item.id===incoming.parentId)||snapshot.entities.find(item=>item.id===incoming.parentId);if(parent)incoming.areaId=parent.areaId;}
    if(next.removedAreaIds.includes(incoming.areaId)){next.removedAreaIds=next.removedAreaIds.filter(id=>id!==incoming.areaId);const area=snapshot.areas.find(item=>item.id===incoming.areaId);if(area&&!next.areas.some(item=>item.id===area.id))next.areas.push({...area});}
  }
  const areas=[...new Set([...snapshot.areas.filter(item=>!next.removedAreaIds.includes(item.id)).map(item=>item.id),...next.areas.map(item=>item.id)])];
  const byId=new Map([...snapshot.entities,...next.entities].map(item=>[item.id,item]));
  for(let pass=0;pass<next.entities.length;pass++){let changed=false;for(const entity of next.entities)if(entity.kind!=="person"&&!entity.areaId&&entity.parentId&&byId.get(entity.parentId)?.areaId){entity.areaId=byId.get(entity.parentId).areaId;changed=true;}if(!changed)break;}
  const explicitlyOutside=id=>snapshot.entities.some(item=>item.id===id&&item.ownerAreaId==='');
  for(const entity of next.entities.filter(item=>item.kind==="external"&&!item.areaId&&!explicitlyOutside(item.id))) {const neighbors=new Set(next.relations.filter(relation=>[relation.from,relation.to].includes(entity.id)).map(relation=>byId.get(relation.from===entity.id?relation.to:relation.from)?.areaId).filter(Boolean));if(neighbors.size===1)entity.areaId=[...neighbors][0];}
  if(areas.length===1) for(const entity of next.entities) if(entity.kind!=="person"&&!entity.areaId&&!explicitlyOutside(entity.id))entity.areaId=areas[0];
  return next;
}

export function validateArchitecture(value, snapshot = getSnapshot()) {
  if (!value || !Array.isArray(value.areas) || !Array.isArray(value.entities) || !Array.isArray(value.relations)) throw new Error("Architect response is missing semantic arrays");
  uniqueIds(value.areas, "id"); uniqueIds(value.entities, "id"); uniqueIds(value.relations, "id");
  const removedAreas = new Set(value.removedAreaIds || []);
  const removedEntities = new Set(value.removedEntityIds || []);
  const areaIds = new Set([...snapshot.areas.filter((item) => !removedAreas.has(item.id)).map((item) => item.id), ...value.areas.map((item) => item.id)]);
  const entityIds = new Set([...snapshot.entities.filter((item) => !removedEntities.has(item.id) && !removedAreas.has(item.areaId)).map((item) => item.id), ...value.entities.map((item) => item.id)]);
  const entitiesById = new Map([...snapshot.entities, ...value.entities].map((item) => [item.id, item]));
  const remaining=[...entitiesById.values()].filter(entity=>entityIds.has(entity.id));
  for (const entity of remaining) {
    if (entity.kind === "person") {
      if (entity.areaId) throw new Error(`Person '${entity.id}' must stay outside project areas`);
      if (entity.parentId) throw new Error(`Person '${entity.id}' cannot have a parent entity`);
      if (entity.path) throw new Error(`Person '${entity.id}' cannot use a repository path as its identity`);
    } else if (entity.areaId && !areaIds.has(entity.areaId)) throw new Error(`Unknown entity area '${entity.areaId}'`);
    if (entity.parentId) {
      const parent = entitiesById.get(entity.parentId);
      if (!parent || removedEntities.has(parent.id)) throw new Error(`Unknown entity parent '${entity.parentId}'`);
      if (parent.areaId !== entity.areaId) throw new Error(`Entity parent '${entity.parentId}' belongs to another area`);
    }
  }
  orderEntities(remaining);
  const relationEndpoints = new Set();
  for (const relation of value.relations) {
    if (!entityIds.has(relation.from) || !entityIds.has(relation.to)) throw new Error(`Unknown relation endpoint '${relation.id}'`);
    relationEndpoints.add(relation.from); relationEndpoints.add(relation.to);

  }
  for (const entity of value.entities) if (entity.kind === "person" && !relationEndpoints.has(entity.id)) throw new Error(`Person '${entity.id}' must have at least one explanatory relation`);
  const allRelations=[...snapshot.relations.filter(item=>!(value.removedRelationIds||[]).includes(item.id) && !value.relations.some(next=>next.id===item.id)),...value.relations];
  for (const flow of value.keyFlows || []) {
    for(const step of flow.steps||[]) if(!entityIds.has(step)) throw new Error(`Unknown key-flow step '${step}'`);
    if(flow.transitions && flow.transitions.length!==Math.max(0,(flow.steps||[]).length-1)) throw new Error(`Key-flow '${flow.id}' has a wrong transition count`);
    for(let i=1;i<(flow.steps||[]).length;i++) {
      const candidates=allRelations.filter(relation=>relation.from===flow.steps[i-1]&&relation.to===flow.steps[i]);
      if(!candidates.length) throw new Error(`Key-flow '${flow.id}' is disconnected: ${flow.steps[i-1]} -> ${flow.steps[i]}`);
      if(flow.transitions && !candidates.some(relation=>relation.id===flow.transitions[i-1].relationId)) throw new Error(`Key-flow '${flow.id}' uses a wrong directed transition`);
      if(!flow.transitions && candidates.length>1) throw new Error(`Key-flow '${flow.id}' must identify its transition between parallel relations`);
    }
  }
  return value;
}

export function architectureEvents(value, { actor = "architect", refresh = false, language = "", knowledge, verification } = {}) {
  const snapshot = getSnapshot();
  validateArchitecture(value, snapshot);
  const events = [createEvent("map.upsert", { actor, payload: {
    projectTitle: value.projectTitle, projectSummary: value.projectSummary || "", layoutIntent: value.layoutIntent || "domain",skeleton:false,
    layoutDirection: value.layoutDirection || "AUTO", keyFlows: value.keyFlows || [], unresolvedQuestions: value.unresolvedQuestions || [],
    ...(language ? { language } : {}),
    ...(knowledge ? {knowledge, explanationProfile:knowledge.profile} : {}),
    ...(verification ? {verification} : {}),
  } })];
  for (const area of value.areas) events.push(createEvent("area.upsert", { actor, payload: area }));
  for (const entity of orderEntities(value.entities)) events.push(createEvent("entity.upsert", { actor, payload: {...entity,...(verification?{verification}:{})} }));
  for (const relation of value.relations) events.push(createEvent("relation.upsert", { actor, payload: {...relation,...(verification?{verification}:{})} }));
  if (refresh) {
    for (const relationId of value.removedRelationIds || []) events.push(createEvent("relation.remove", { actor, payload: { id: relationId, reason: "Architect refresh" } }));
    for (const entityId of value.removedEntityIds || []) events.push(createEvent("entity.remove", { actor, payload: { id: entityId, reason: "Architect refresh" } }));
    for (const areaId of value.removedAreaIds || []) events.push(createEvent("area.remove", { actor, payload: { id: areaId, reason: "Architect refresh" } }));
  }
  return events;
}

export function applyArchitecture(value, options = {}) {
  for(let attempt=0;attempt<3;attempt++) {
    const current=getSnapshot();
    if(options.expectedSignature && semanticSignature(current)!==options.expectedSignature) throw new Error("Карта или поправки владельца изменились во время построения. Сохранённый результат требует повторной сверки.");
    const events=architectureEvents(value,options);
    try {if(events.length)appendEvents(events,{expectedRevision:current.revision});return {events:events.length,snapshot:getSnapshot()};}
    catch(error) {if(error.code!=="STALE_REVISION" || attempt===2)throw error;}
  }
}

export function observerEvents(decision, context) {
  const snapshot = getSnapshot();
  const existingEntities = new Map(snapshot.entities.map((item) => [item.id, item]));
  const existingRelations = new Map(snapshot.relations.map((item) => [item.id, item]));
  const upserts = [];
  const removals = [];
  const changedEntities = new Map((decision.entityChanges || []).filter((change) => change.operation === "upsert").map((change) => [change.entityId, change]));
  const targets = [...new Set((decision.targetEntityIds || []).filter((target) => {
    const entity = existingEntities.get(target) || (context.verified && changedEntities.get(target));
    return entity && entity.kind !== "person";
  }))];
  const workEvent = createEvent("work.upsert", { actor: "observer", payload: {
    id: context.workId, title: decision.workTitle || "Agent work", status: context.terminalStatus || decision.workStatus,
    targets, note: decision.workSummary || "", provisional: targets.length === 0, session: context.session,
    ...(context.verified?{verification:context.verification||{state:"source-checked"},proposedChanges:null}:{}),
  } });
  if(!context.verified) {
    if((decision.entityChanges||[]).length || (decision.relationChanges||[]).length) Object.assign(workEvent.payload,{verification:{state:"pending",trigger:context.final?"checking":"turn-completion"},proposedChanges:decision});
    else if(context.final) Object.assign(workEvent.payload,{verification:null,proposedChanges:null});
    return [workEvent];
  }
  for (const change of decision.entityChanges || []) {
    const original = existingEntities.get(change.entityId);
    if (change.operation === "remove") {
      if (context.final && original && !original.ownerGroup) removals.push(createEvent("entity.remove", { actor: "observer", payload: { id: change.entityId, reason: change.reason || decision.workSummary } }));
      continue;
    }
    const parentId = original && Object.hasOwn(original, "ownerParentId") ? original.ownerParentId : change.parentId || "";
    const parent = existingEntities.get(parentId) || changedEntities.get(parentId);
    const areaId = parent ? parent.ownerAreaId ?? parent.areaId : original?.ownerAreaId ?? (original?.ownerGroup ? original.areaId : change.areaId);
    upserts.push(createEvent("entity.upsert", { actor: "observer", payload: {
      id: change.entityId, areaId, parentId, label: change.label,
      kind: change.kind || "component", status: change.status, path: change.path, purpose: change.purpose, note: change.note,
      evidence: change.evidence || [],...(context.verification?{verification:context.verification}:{}),
    } }));
  }
  for (const change of decision.relationChanges || []) {
    if (change.operation === "remove") {
      if (context.final && existingRelations.has(change.relationId)) removals.unshift(createEvent("relation.remove", { actor: "observer", payload: { id: change.relationId, reason: change.reason || decision.workSummary } }));
      continue;
    }
    upserts.push(createEvent("relation.upsert", { actor: "observer", payload: {
      id: change.relationId, from: change.from, to: change.to, label: change.label, kind: change.kind || "runtime",
      contract: change.contract || "", mechanism: change.mechanism || "", evidence: change.evidence || [], status: change.status,...(context.verification?{verification:context.verification}:{}),
    } }));
  }
  return [...upserts, workEvent, ...removals];
}

export function applyObserverDecision(decision, context) {
  for(let attempt=0;attempt<3;attempt++) {
    const current=getSnapshot();
    if(context.expectedSignature && semanticSignature(current)!==context.expectedSignature) throw new Error("Устройство карты изменилось во время проверки; требуется новая сверка");
    const events=observerEvents(decision,context);
    try {appendEvents(events,{expectedRevision:current.revision});return {events:events.length,snapshot:getSnapshot()};}
    catch(error) {if(error.code!=="STALE_REVISION" || attempt===2)throw error;}
  }
}
