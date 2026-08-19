export const CURRENT_WORK_STATUSES = new Set(["active", "blocked", "planned"]);
export const LIVE_WORK_MS = 5 * 60_000;
export const STALE_WORK_MS = 15 * 60_000;

function timestamp(value) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

export function workFreshness(work, now = Date.now()) {
  if (!CURRENT_WORK_STATUSES.has(work?.status)) return "terminal";
  const updatedAt = timestamp(work.updatedAt || work.startedAt || work.createdAt);
  if (!updatedAt) return "stale";
  const age = Math.max(0, now - updatedAt);
  if (age <= LIVE_WORK_MS) return "live";
  if (age <= STALE_WORK_MS) return "recent";
  return "stale";
}

export function isCurrentWork(work, now = Date.now()) {
  return workFreshness(work, now) === "live";
}

export function currentWork(snapshot, now = Date.now()) {
  return (snapshot?.work || []).filter((work) => isCurrentWork(work, now));
}

export function graphHierarchy(snapshot) {
  const direct = new Map();
  for (const entity of snapshot?.entities || []) {
    if (!entity.parentId) continue;
    if (!direct.has(entity.parentId)) direct.set(entity.parentId, []);
    direct.get(entity.parentId).push(entity.id);
  }
  const descendants = new Map();
  function visit(id, visiting = new Set()) {
    if (descendants.has(id)) return descendants.get(id);
    if (visiting.has(id)) return new Set();
    const branch = new Set(visiting); branch.add(id);
    const result = new Set();
    for (const child of direct.get(id) || []) {
      result.add(child);
      for (const nested of visit(child, branch)) result.add(nested);
    }
    descendants.set(id, result);
    return result;
  }
  for (const entity of snapshot?.entities || []) visit(entity.id);
  return { direct, descendants };
}

export function graphItemMoveIds(snapshot, nodeId, now = Date.now()) {
  const [kind, ...parts] = String(nodeId || "").split(":");
  const id = parts.join(":");
  const affected = new Set([nodeId]);
  const affectedEntities = new Set();
  const hierarchy = graphHierarchy(snapshot);

  if (kind === "area") {
    for (const entity of snapshot?.entities || []) {
      if (entity.kind === "person" || entity.areaId !== id) continue;
      affected.add(`entity:${entity.id}`);
      affectedEntities.add(entity.id);
    }
  } else if (kind === "entity") {
    affectedEntities.add(id);
    for (const child of hierarchy.descendants.get(id) || []) {
      affected.add(`entity:${child}`);
      affectedEntities.add(child);
    }
  }

  for (const work of currentWork(snapshot, now)) {
    if ((work.targets || []).some((target) => affectedEntities.has(target))) affected.add(`work:${work.id}`);
  }
  return affected;
}
