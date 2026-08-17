const ACTIVE_WORK_STATUSES = new Set(["active", "blocked", "planned"]);

export function layoutFingerprint(snapshot) {
  return JSON.stringify([
    snapshot.map?.layoutDirection === "DOWN" ? "DOWN" : "RIGHT",
    snapshot.areas.map((area) => area.id),
    snapshot.entities.map((entity) => [entity.id, entity.areaId, entity.parentId || "", entity.kind || "component"]),
    (snapshot.relations || []).map((relation) => [relation.id, relation.from, relation.to, relation.status || "existing", relation.ownerLabel || relation.label || ""]),
    snapshot.work.filter((work) => ACTIVE_WORK_STATUSES.has(work.status)).map((work) => [work.id, work.status, work.provisional ? 1 : 0, ...(work.targets || [])]),
  ]);
}
