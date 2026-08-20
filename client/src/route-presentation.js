export function routesForTier(activityTier, areaRoutes, detailedRoutes) {
  return activityTier === "area" ? areaRoutes : detailedRoutes;
}

export function persistentRouteLabel(route, placement) {
  return Boolean(route?.label && placement?.safe);
}
