export function routesForTier(activityTier, areaRoutes, detailedRoutes) {
  if (activityTier !== "area") return detailedRoutes;
  // Work is live state, not structural detail. Keep its tether visible at every
  // zoom level so an active session never disappears from the overview.
  const workRoutes = detailedRoutes.filter((route) => route.type === "work");
  return workRoutes.length ? [...areaRoutes, ...workRoutes] : areaRoutes;
}

export function persistentRouteLabel(route, placement) {
  return Boolean(route?.label && placement?.safe);
}

export function routeVisualKind(route) {
  if (route?.type === "work") return "live-work";
  if (route?.status === "planned") return "planned";
  return "confirmed";
}

function initialDirection(route) {
  const start = route?.points?.[0]; const next = route?.points?.find((point, index) => index > 0 && (Math.abs(point.x - start.x) > .01 || Math.abs(point.y - start.y) > .01));
  if (!start || !next) return null;
  const horizontal = Math.abs(next.x - start.x) >= Math.abs(next.y - start.y);
  return { start, next, axis: horizontal ? "x" : "y", sign: horizontal ? Math.sign(next.x - start.x) || 1 : Math.sign(next.y - start.y) || 1, length: Math.hypot(next.x - start.x, next.y - start.y) };
}

export function sharedTrunkRoutes(routes, maxBranches = 4) {
  const groups = new Map();
  for (const route of routes || []) {
    if (route.type !== "relation" || !(route.relations || []).length) continue;
    const direction = initialDirection(route); if (!direction) continue;
    const key = `${route.source}|${route.color}|${direction.axis}|${direction.sign}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ route, direction });
  }
  const trunks = [];
  for (const [key, entries] of groups) {
    if (entries.length < 2 || entries.length > maxBranches) continue;
    const start = entries[0].direction.start;
    if (entries.some((entry) => Math.hypot(entry.direction.start.x - start.x, entry.direction.start.y - start.y) > 6)) continue;
    const length = Math.max(24, Math.min(72, ...entries.map((entry) => entry.direction.length * .72)));
    const direction = entries[0].direction;
    const end = direction.axis === "x" ? { x: start.x + direction.sign * length, y: start.y } : { x: start.x, y: start.y + direction.sign * length };
    const relations = [...new Map(entries.flatMap((entry) => entry.route.relations || []).map((relation) => [relation.id, relation])).values()];
    trunks.push({
      id: `trunk:${key}:${relations.map((relation) => relation.id).join(",")}`,
      source: entries[0].route.source,
      target: entries[0].route.target,
      type: "trunk",
      status: "existing",
      label: "",
      color: entries[0].route.color,
      sourceAreaId: entries[0].route.sourceAreaId,
      targetAreaId: entries[0].route.targetAreaId,
      points: [start, end],
      relations,
      shared: true,
    });
  }
  return trunks;
}
