import { projectRoot } from "./project-root.mjs";

const collator=new Intl.Collator(undefined,{numeric:true,sensitivity:"base"});
function naturalCompare(a, b) { return collator.compare(String(a),String(b)); }

function activityLabel(event) {
  const {_checkpoint,...payload} = event.payload || {};
  if (event.type === "map.upsert") return `Project map ${payload.projectTitle || "updated"}`;
  if (event.type === "activity.log") return payload.message || "Activity recorded";
  if (event.type === "area.upsert") return `Area ${payload.ownerTitle || payload.title || payload.id} updated`;
  if (event.type === "area.remove") return `Area ${payload.id} removed: ${payload.reason || "no longer exists"}`;
  if (event.type === "entity.upsert") return `${payload.ownerLabel || payload.label || payload.id} → ${payload.status || "updated"}`;
  if (event.type === "entity.remove") return `Entity ${payload.id} removed: ${payload.reason || "no longer exists"}`;
  if (event.type === "relation.upsert") return `Relation ${payload.from} → ${payload.to}`;
  if (event.type === "relation.remove") return `Relation ${payload.id} removed`;
  if (event.type === "work.upsert") return `Work ${payload.title || payload.id} → ${payload.status || "updated"}`;
  return event.type;
}

export function reduceEvents(events, errors = [], base = null, {retainWorkTargets=false} = {}) {
  let map = base?.map ? {...base.map} : null;
  const areas = new Map((base?.areas || []).map(item=>[item.id,item]));
  const entities = new Map((base?.entities || []).map(item=>[item.id,item]));
  const relations = new Map((base?.relations || []).map(item=>[item.id,item]));
  const work = new Map((base?._rawWork || base?.work || []).map(item=>[item.id,item]));
  const activity = [...(base?.activity || [])].reverse();

  for (const event of events) {
    const payload = event.payload || {};

    if (event.type === "map.upsert") {
      map = { ...(map || {}), ...payload, actor: event.actor, updatedAt: event.ts };
    }

    if (event.type === "area.upsert") {
      const id = String(payload.id);
      const next={ ...(areas.get(id) || {}), ...payload, id, actor: event.actor, updatedAt: event.ts };
      if(payload.x===null&&payload.y===null){delete next.x;delete next.y;}
      areas.set(id,next);
    }

    if (event.type === "area.remove") {
      const id = String(payload.id);
      const removedEntityIds = [];
      areas.delete(id);
      for (const [entityId, entity] of entities) {
        if (entity.areaId === id) {
          entities.delete(entityId);
          removedEntityIds.push(entityId);
        }
      }
      for (const [relationId, relation] of relations) {
        if (removedEntityIds.includes(relation.from) || removedEntityIds.includes(relation.to)) relations.delete(relationId);
      }
    }

    if (event.type === "entity.upsert") {
      const id = String(payload.id);
      const next={ ...(entities.get(id) || {}), ...payload, id, actor: event.actor, updatedAt: event.ts };
      for(const key of ["ownerAreaId","ownerParentId"])if(payload[key]===null)delete next[key];
      if(payload.x===null&&payload.y===null){delete next.x;delete next.y;}
      entities.set(id,next);
    }

    if (event.type === "entity.remove") {
      const id = String(payload.id);
      entities.delete(id);
      for (const [relationId, relation] of relations) {
        if (relation.from === id || relation.to === id) relations.delete(relationId);
      }
    }

    if (event.type === "relation.upsert") {
      const id = String(payload.id || `${payload.from}->${payload.to}`);
      relations.set(id, { ...(relations.get(id) || {}), ...payload, id, actor: event.actor, updatedAt: event.ts });
    }

    if (event.type === "relation.remove") relations.delete(String(payload.id));

    if (event.type === "work.upsert") {
      const id = String(payload.id);
      work.set(id, { ...(work.get(id) || {}), ...payload, id, actor: event.actor, updatedAt: event.ts });
    }

    activity.push({
      id: event.id,
      ts: event.ts,
      actor: event.actor,
      type: event.type,
      level: payload.level || "info",
      message: activityLabel(event),
    });
  }

  const areaList = [...areas.values()].sort((a, b) => Number(a.order || 0) - Number(b.order || 0) || naturalCompare(a.title, b.title));
  const entityList = [...entities.values()].sort((a, b) => Number(a.order || 0) - Number(b.order || 0) || naturalCompare(a.label, b.label));
  const relationList = [...relations.values()];
  const entityIds = new Set(entityList.map((entity) => entity.id));
  const workList = [...work.values()].map((item) => ({
    ...item,
    targets: (item.targets || []).filter((id) => entityIds.has(id)),
  })).sort((a, b) => naturalCompare(a.title, b.title));
  const activeWork = workList.filter((item) => ["active", "blocked", "planned"].includes(item.status));
  const activeEntityIds = [...new Set(activeWork.filter((item) => item.status === "active").flatMap((item) => item.targets || []))];

  return {
    revision: (base?.revision || 0) + events.length,
    ...(retainWorkTargets?{_rawWork:[...work.values()]}:{}),
    updatedAt: events.at(-1)?.ts || base?.updatedAt || null,
    parseErrors: errors.filter((error) => error.kind === "parse"),
    validationErrors: errors.filter((error) => error.kind !== "parse"),
    storeErrors: errors,
    map: map || {
      projectTitle: projectRoot.split(/[\\/]/).filter(Boolean).at(-1) || "Project",
      projectSummary: "",
      language: "",
      layoutIntent: "domain",
      layoutDirection: "AUTO",
      keyFlows: [],
      unresolvedQuestions: [],
    },
    areas: areaList,
    entities: entityList,
    relations: relationList,
    work: workList,
    activeEntityIds,
    semantic: areaList.length > 0 || entityList.length > 0,
    activity: activity.slice(-80).reverse(),
    summary: {
      areaCount: areaList.length,
      entityCount: entityList.length,
      activeWork: activeWork.filter((item) => item.status === "active").length,
      agents: [...new Set([...(base?.summary?.agents||[]),...events.map((event) => event.actor).filter(Boolean)])],
    },
  };
}
