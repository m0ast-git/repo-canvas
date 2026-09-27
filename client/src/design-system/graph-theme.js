export const AREA_TOKENS = Object.freeze({
  olive: "var(--rc-area-olive)",
  leaf: "var(--rc-area-leaf)",
  teal: "var(--rc-area-teal)",
});

export const NEUTRAL_EDGE = "var(--rc-edge-neutral)";

// The caller supplies stable area IDs. Array order and selection are irrelevant.
export function sourceAreaId(sourceId, nodesById) {
  const visited = new Set();
  let node = nodesById.get(sourceId);
  while (node && !visited.has(node.id)) {
    visited.add(node.id);
    const owner = Object.hasOwn(node.data || {}, "areaId") ? node.data.areaId : node.areaId;
    if (owner !== undefined) return owner;
    node = nodesById.get(node.parentId);
  }
  return null;
}

export function sourceEdgeColor(sourceId, nodesById, areasById) {
  const owner = sourceAreaId(sourceId, nodesById);
  if (owner == null) return NEUTRAL_EDGE;
  const area = areasById.get(owner);
  const color = area?.color || AREA_TOKENS[area?.colorKey];
  if (!color) throw new RangeError("Области " + owner + " не назначен цвет");
  return color;
}

export function describeEdge(edge, nodesById, areasById) {
  const source = nodesById.get(edge.source);
  const target = nodesById.get(edge.target);
  const area = areasById.get(sourceAreaId(edge.source, nodesById));
  const name = node => node?.data?.title || node?.title || node?.id || "Неизвестный элемент";
  if (edge.bidirectional) {
    const otherArea = areasById.get(sourceAreaId(edge.target, nodesById));
    const owners = [...new Set([area?.title || "вне областей", otherArea?.title || "вне областей"])];
    return name(source) + " ↔ " + name(target) + ". Взаимообмен. Области: " + owners.join(" / ") + ".";
  }
  return name(source) + " → " + name(target) + ". Источник: " + (area?.title || "вне областей") + ".";
}

// Rounded orthogonal waypoints, also usable with the existing libavoid router.
export function roundedRoute(input, radius = 32) {
  const points=[];
  for(const point of input||[]) {
    if(points.length&&Math.hypot(point.x-points.at(-1).x,point.y-points.at(-1).y)<.01)continue;
    while(points.length>1) {
      const a=points.at(-2),b=points.at(-1);
      if(!((Math.abs(a.x-b.x)<.01&&Math.abs(b.x-point.x)<.01)||(Math.abs(a.y-b.y)<.01&&Math.abs(b.y-point.y)<.01)))break;
      points.pop();
    }
    points.push(point);
  }
  if (!points?.length) return "";
  const parts = ["M " + points[0].x + " " + points[0].y];
  for (let i = 1; i < points.length - 1; i += 1) {
    const a = points[i - 1], b = points[i], c = points[i + 1];
    const incoming = Math.hypot(b.x - a.x, b.y - a.y);
    const outgoing = Math.hypot(c.x - b.x, c.y - b.y);
    const r = Math.min(radius, incoming / 2, outgoing / 2);
    const before = { x: b.x + (a.x - b.x) * r / Math.max(1, incoming), y: b.y + (a.y - b.y) * r / Math.max(1, incoming) };
    const after = { x: b.x + (c.x - b.x) * r / Math.max(1, outgoing), y: b.y + (c.y - b.y) * r / Math.max(1, outgoing) };
    parts.push("L " + before.x + " " + before.y + " Q " + b.x + " " + b.y + " " + after.x + " " + after.y);
  }
  if (points.length > 1) parts.push("L " + points.at(-1).x + " " + points.at(-1).y);
  return parts.join(" ");
}

// Match the arrow to the available straight approach, not an unrelated zoom floor.
export function routeInk(points, zoom=1, selected=false) {
  const width=selected?2:Math.max(1,Math.min(1.6,1.6*zoom));
  const length=(a,b)=>a&&b?Math.hypot(a.x-b.x,a.y-b.y):0;
  const start=points?.[0],end=points?.at(-1);
  const next=points?.find(point=>length(start,point)>.01),previous=points?.findLast(point=>length(end,point)>.01);
  const approach=Math.min(length(start,next),length(end,previous))*zoom;
  return {width,arrow:Math.max(.5,Math.min(7,10*zoom,approach*.45))};
}
