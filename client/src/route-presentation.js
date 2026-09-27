import { routeSourceArea } from "./design-system/project-theme.js";

export function persistentRouteLabel(route, placement) {
  return Boolean(route?.label && route?.labelPinned && placement?.safe);
}

export function routeVisualKind(route, entities = new Map(), areaStatuses = new Map()) {
  if (!route) return "confirmed";
  if (route?.status === "planned") return "planned";
  // A task's association with its target is not an implemented dependency.
  if (route?.type === "work") return "work-association";
  for (const endpoint of ["source", "target"]) {
    if (areaStatuses.get(routeSourceArea(route, entities, endpoint)) === "planned") return "planned";
    const id = route?.[endpoint] || "";
    if (id.startsWith("entity:") && entities.get(id.slice(7))?.status === "planned") return "planned";
  }
  return "confirmed";
}
