import ELK from "elkjs/lib/elk-api.js";
import elkWorkerUrl from "elkjs/lib/elk-worker.min.js?url";
import { init as initLibavoid, routeEdges as routeLibavoidEdges } from "@mr_mint/elkjs-libavoid";

const elk = new ELK({ workerUrl: elkWorkerUrl });
const libavoidWasmUrl = new URL("../../node_modules/libavoid-js/dist/libavoid.wasm", import.meta.url).href;
let libavoidReady;
function ensureLibavoid() { if (!libavoidReady) libavoidReady = initLibavoid(libavoidWasmUrl).catch((error) => { libavoidReady = null; throw error; }); return libavoidReady; }
const ENTITY_W = 244;
const ENTITY_H = 122;
const PERSON_W = 176;
const PERSON_H = 164;
const WORK_W = 196;
const WORK_H = 66;
const AREA_HEADER_H = 100;
const CLEARANCE = 18;
const LIBAVOID_OPTIONS = Object.freeze({
  routingType: "orthogonal",
  segmentPenalty: 20,
  crossingPenalty: 70,
  fixedSharedPathPenalty: 50,
  reverseDirectionPenalty: 24,
  portDirectionPenalty: 100,
  shapeBufferDistance: 14,
  idealNudgingDistance: 12,
  nudgeOrthogonalSegmentsConnectedToShapes: true,
  nudgeOrthogonalTouchingColinearSegments: true,
  performUnifyingNudgingPreprocessingStep: false,
  nudgeSharedPathsWithCommonEndPoint: true,
  selfLoopHandling: "fallback",
});

const palette = ["#e88962", "#5fae93", "#d49a43", "#8d79b8", "#cf6f76", "#5d97b3", "#ae865d", "#6fa36b", "#b7789f", "#7a91c4", "#c37d4a", "#53a0a0"];

function stableColor(area, index) {
  if (/^#[0-9a-f]{6}$/i.test(area.color || "")) return area.color;
  let hash = 0;
  for (const character of String(area.id)) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return palette[(hash + index) % palette.length];
}

function cleanOptions(options) {
  return Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined));
}

function entityTree(areaEntities) {
  const ids = new Set(areaEntities.map((item) => item.id));
  const children = new Map();
  for (const entity of areaEntities) {
    const parentId = entity.parentId && ids.has(entity.parentId) ? entity.parentId : "";
    if (!children.has(parentId)) children.set(parentId, []);
    children.get(parentId).push(entity);
  }
  for (const items of children.values()) items.sort((a, b) => Number(a.order || 0) - Number(b.order || 0) || String(a.label).localeCompare(String(b.label)));
  return children;
}

function elkEntity(entity, tree, direction) {
  const nested = tree.get(entity.id) || [];
  if (!nested.length) return { id: entity.id, width: ENTITY_W, height: ENTITY_H };
  return {
    id: entity.id,
    children: nested.map((child) => elkEntity(child, tree, direction)),
    layoutOptions: cleanOptions({
      "elk.algorithm": "layered",
      "elk.direction": direction,
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.padding": "[top=82,left=28,bottom=30,right=28]",
      "elk.spacing.nodeNode": "54",
      "elk.layered.spacing.nodeNodeBetweenLayers": "76",
    }),
  };
}

function collectEntityGeometry(node, parentX, parentY, output, depth = 0) {
  const x = parentX + Number(node.x || 0);
  const y = parentY + Number(node.y || 0);
  output.set(node.id, { x, y, width: Number(node.width || ENTITY_W), height: Number(node.height || ENTITY_H), depth, group: Boolean(node.children?.length) });
  for (const child of node.children || []) collectEntityGeometry(child, x, y, output, depth + 1);
}

async function layoutArea(area, entities, relations, direction) {
  const tree = entityTree(entities);
  const entityIds = new Set(entities.map((item) => item.id));
  const graph = {
    id: `area-layout:${area.id}`,
    layoutOptions: cleanOptions({
      "elk.algorithm": "layered",
      "elk.hierarchyHandling": "INCLUDE_CHILDREN",
      "elk.direction": direction,
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.padding": `[top=${AREA_HEADER_H},left=34,bottom=38,right=34]`,
      "elk.spacing.nodeNode": "70",
      "elk.spacing.edgeEdge": "34",
      "elk.spacing.edgeNode": "38",
      "elk.spacing.edgeLabel": "20",
      "elk.layered.spacing.nodeNodeBetweenLayers": "112",
      "elk.layered.spacing.edgeEdgeBetweenLayers": "36",
      "elk.layered.spacing.edgeNodeBetweenLayers": "44",
      "elk.layered.mergeEdges": "false",
      "elk.layered.nodePlacement.favorStraightEdges": "true",
    }),
    children: (tree.get("") || []).map((entity) => elkEntity(entity, tree, direction)),
    edges: relations.filter((relation) => entityIds.has(relation.from) && entityIds.has(relation.to)).map((relation) => ({
      id: relation.id, sources: [relation.from], targets: [relation.to],
      labels: relation.label ? [{ text: relation.label, width: Math.min(220, Math.max(72, relation.label.length * 7 + 28)), height: 28 }] : [],
    })),
  };
  if (!graph.children.length) return { width: 520, height: 260, entities: new Map() };
  const result = await elk.layout(graph);
  const geometry = new Map();
  for (const child of result.children || []) collectEntityGeometry(child, 0, 0, geometry);
  return { width: Math.max(520, Number(result.width || 520)), height: Math.max(260, Number(result.height || 260)), entities: geometry };
}

function rootAlgorithm(intent) {
  if (intent === "core") return "radial";
  if (intent === "clustered") return "stress";
  if (intent === "domain" || intent === "hybrid") return "rectpacking";
  return "layered";
}

async function layoutAreas(snapshot, areaLayouts, direction) {
  const areaByEntity = new Map(snapshot.entities.map((entity) => [entity.id, entity.areaId]));
  const aggregate = new Map();
  for (const relation of snapshot.relations || []) {
    const from = areaByEntity.get(relation.from); const to = areaByEntity.get(relation.to);
    if (!from || !to || from === to) continue;
    const key = `${from}->${to}`;
    if (!aggregate.has(key)) aggregate.set(key, { from, to });
  }
  const algorithm = rootAlgorithm(snapshot.map?.layoutIntent || "domain");
  const root = {
    id: "root",
    layoutOptions: cleanOptions({
      "elk.algorithm": algorithm,
      "elk.direction": algorithm === "layered" ? direction : undefined,
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.spacing.nodeNode": "160",
      "elk.layered.spacing.nodeNodeBetweenLayers": "210",
      "elk.spacing.componentComponent": "160",
      "elk.aspectRatio": "1.45",
      "elk.padding": "[top=90,left=90,bottom=90,right=90]",
    }),
    children: snapshot.areas.map((area) => ({ id: area.id, width: areaLayouts.get(area.id).width, height: areaLayouts.get(area.id).height })),
    edges: [...aggregate.entries()].map(([id, item]) => ({ id, sources: [item.from], targets: [item.to] })),
  };
  const result = root.children.length ? await elk.layout(root) : root;
  return new Map((result.children || []).map((item) => [item.id, { x: Number(item.x || 0), y: Number(item.y || 0), width: item.width, height: item.height }]));
}

function mapBounds(rects) {
  const values = [...rects.values()];
  return {
    left: Math.min(0, ...values.map((rect) => rect.x)), top: Math.min(0, ...values.map((rect) => rect.y)),
    right: Math.max(1200, ...values.map((rect) => rect.x + rect.width)), bottom: Math.max(800, ...values.map((rect) => rect.y + rect.height)),
  };
}

function placePeople(snapshot, areaRects, entityRects) {
  const people = snapshot.entities.filter((entity) => entity.kind === "person");
  if (!people.length) return new Map();
  const bounds = mapBounds(areaRects); const byId = new Map(snapshot.entities.map((entity) => [entity.id, entity]));
  const targetRects = (personId) => (snapshot.relations || []).filter((relation) => relation.from === personId || relation.to === personId).map((relation) => {
    const otherId = relation.from === personId ? relation.to : relation.from; const direct = entityRects.get(otherId);
    if (direct) return direct; const area = areaRects.get(byId.get(otherId)?.areaId); return area || null;
  }).filter(Boolean);
  const lanes = new Map(["left", "right", "top", "bottom"].map((side) => [side, []]));
  for (const person of people) {
    const targets = targetRects(person.id); const centers = targets.map(center);
    const anchor = centers.length ? { x: centers.reduce((sum, point) => sum + point.x, 0) / centers.length, y: centers.reduce((sum, point) => sum + point.y, 0) / centers.length } : { x: bounds.left, y: bounds.top };
    const distances = [
      ["left", Math.abs(anchor.x - bounds.left)], ["right", Math.abs(bounds.right - anchor.x)],
      ["top", Math.abs(anchor.y - bounds.top)], ["bottom", Math.abs(bounds.bottom - anchor.y)],
    ].sort((a, b) => a[1] - b[1]);
    lanes.get(distances[0][0]).push({ person, anchor });
  }
  const result = new Map(); const gap = 34; const margin = 96;
  const placeLane = (side, entries) => {
    const horizontal = side === "top" || side === "bottom"; entries.sort((a, b) => horizontal ? a.anchor.x - b.anchor.x : a.anchor.y - b.anchor.y);
    let cursor = horizontal ? bounds.left : bounds.top;
    for (const { person, anchor } of entries) {
      const preferred = horizontal ? anchor.x - PERSON_W / 2 : anchor.y - PERSON_H / 2;
      const along = Math.max(cursor, preferred); cursor = along + (horizontal ? PERSON_W : PERSON_H) + gap;
      const rect = horizontal
        ? { x: along, y: side === "top" ? bounds.top - PERSON_H - margin : bounds.bottom + margin, width: PERSON_W, height: PERSON_H, depth: 0, group: false, person: true }
        : { x: side === "left" ? bounds.left - PERSON_W - margin : bounds.right + margin, y: along, width: PERSON_W, height: PERSON_H, depth: 0, group: false, person: true };
      if (Number.isFinite(Number(person.x)) && Number.isFinite(Number(person.y))) { rect.x = Number(person.x); rect.y = Number(person.y); }
      result.set(person.id, rect);
    }
  };
  for (const [side, entries] of lanes) placeLane(side, entries);
  return result;
}

function ancestors(entities) {
  const byId = new Map(entities.map((entity) => [entity.id, entity]));
  const top = new Map();
  const depth = new Map();
  for (const entity of entities) {
    let current = entity; let d = 0; const seen = new Set([entity.id]);
    while (current.parentId && byId.has(current.parentId) && !seen.has(current.parentId)) { seen.add(current.parentId); current = byId.get(current.parentId); d += 1; }
    top.set(entity.id, current.id); depth.set(entity.id, d);
  }
  return { byId, top, depth };
}

function center(rect) { return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }; }

function boxesOverlap(a, b, gap = 0) {
  return a.x - gap < b.x + b.width && a.x + a.width + gap > b.x && a.y - gap < b.y + b.height && a.y + a.height + gap > b.y;
}

function workPositions(snapshot, entityRects, areaRects) {
  const positions = new Map(); const placed = [];
  const obstacles = [
    ...entityRects.values(),
    ...areaRects.values().map((rect) => ({ x: rect.x + 18, y: rect.y + 14, width: Math.min(560, rect.width - 36), height: AREA_HEADER_H - 20 })),
  ];
  for (const work of (snapshot.work || []).filter((item) => ["active", "blocked", "planned"].includes(item.status))) {
    const targets = (work.targets || []).map((id) => entityRects.get(id)).filter(Boolean);
    const anchor = targets.length ? {
      x: Math.min(...targets.map((rect) => rect.x)), y: Math.min(...targets.map((rect) => rect.y)),
      right: Math.max(...targets.map((rect) => rect.x + rect.width)), bottom: Math.max(...targets.map((rect) => rect.y + rect.height)),
    } : { x: 180, y: 180, right: 180, bottom: 180 };
    const centerX = (anchor.x + anchor.right) / 2; const centerY = (anchor.y + anchor.bottom) / 2;
    const candidates = [];
    const horizontal = [...targets].sort((a, b) => a.x - b.x);
    for (let index = 1; index < horizontal.length; index += 1) {
      const left = horizontal[index - 1]; const right = horizontal[index]; const free = right.x - (left.x + left.width);
      if (free >= WORK_W + CLEARANCE * 2) candidates.push({ x: left.x + left.width + (free - WORK_W) / 2, y: centerY - WORK_H / 2 });
    }
    const vertical = [...targets].sort((a, b) => a.y - b.y);
    for (let index = 1; index < vertical.length; index += 1) {
      const top = vertical[index - 1]; const bottom = vertical[index]; const free = bottom.y - (top.y + top.height);
      if (free >= WORK_H + CLEARANCE * 2) candidates.push({ x: centerX - WORK_W / 2, y: top.y + top.height + (free - WORK_H) / 2 });
    }
    for (let ring = 0; ring < 10; ring += 1) {
      const distance = CLEARANCE + 28 + ring * 44; const shift = Math.ceil(ring / 2) * (WORK_H + 24) * (ring % 2 ? 1 : -1);
      candidates.push(
        { x: anchor.right + distance, y: centerY - WORK_H / 2 + shift },
        { x: anchor.x - WORK_W - distance, y: centerY - WORK_H / 2 + shift },
        { x: centerX - WORK_W / 2 + shift, y: anchor.bottom + distance },
        { x: centerX - WORK_W / 2 + shift, y: anchor.y - WORK_H - distance },
      );
    }
    const fits = (candidate) => {
      const rect = { ...candidate, width: WORK_W, height: WORK_H };
      return !obstacles.some((item) => boxesOverlap(rect, item, 18)) && !placed.some((item) => boxesOverlap(rect, item, 22));
    };
    let selected = candidates.find(fits);
    if (!selected) {
      const farRight = Math.max(180, ...obstacles.map((rect) => rect.x + rect.width)) + 80;
      selected = { x: farRight, y: 180 + placed.length * (WORK_H + 30) };
      while (!fits(selected)) selected.y += WORK_H + 30;
    }
    const rect = { ...selected, width: WORK_W, height: WORK_H }; positions.set(work.id, rect); placed.push(rect);
  }
  return positions;
}

function simplify(points) {
  const compact = points.filter((point, index) => index === 0 || Math.hypot(point.x - points[index - 1].x, point.y - points[index - 1].y) > .5);
  return compact.filter((point, index) => {
    if (index === 0 || index === compact.length - 1) return true;
    const a = compact[index - 1]; const b = compact[index + 1];
    return !((Math.abs(a.x - point.x) < .5 && Math.abs(point.x - b.x) < .5) || (Math.abs(a.y - point.y) < .5 && Math.abs(point.y - b.y) < .5));
  });
}

function localFallback(edge, boxes) {
  const source = boxes.get(edge.source); const target = boxes.get(edge.target); if (!source || !target) return null;
  const routeBase = { sourceBase: { x: source.x, y: source.y }, targetBase: { x: target.x, y: target.y } };
  const a = center(source); const b = center(target); const horizontal = Math.abs(b.x - a.x) >= Math.abs(b.y - a.y);
  if (horizontal) {
    const direction = b.x >= a.x ? 1 : -1; const start = { x: direction > 0 ? source.x + source.width : source.x, y: a.y }; const end = { x: direction > 0 ? target.x : target.x + target.width, y: b.y }; const midX = (start.x + end.x) / 2;
    return { ...edge, ...routeBase, points: simplify([start, { x: midX, y: start.y }, { x: midX, y: end.y }, end]), fallback: true };
  }
  const direction = b.y >= a.y ? 1 : -1; const start = { x: a.x, y: direction > 0 ? source.y + source.height : source.y }; const end = { x: b.x, y: direction > 0 ? target.y : target.y + target.height }; const midY = (start.y + end.y) / 2;
  return { ...edge, ...routeBase, points: simplify([start, { x: start.x, y: midY }, { x: end.x, y: midY }, end]), fallback: true };
}

function sameRect(a, b) { return Math.abs(a.x - b.x) < .01 && Math.abs(a.y - b.y) < .01 && Math.abs(a.width - b.width) < .01 && Math.abs(a.height - b.height) < .01; }

async function routeEdges(edges, boxes, obstacles) {
  const routable = edges.filter((edge) => boxes.has(edge.source) && boxes.has(edge.target));
  if (!routable.length) return [];
  const children = []; const registered = new Map();
  for (const [id, rect] of boxes) { children.push({ id, x: rect.x, y: rect.y, width: rect.width, height: rect.height }); registered.set(id, rect); }
  obstacles.forEach((obstacle, index) => {
    let id = String(obstacle.id || `obstacle-${index}`); const current = registered.get(id);
    if (current && sameRect(current, obstacle)) return;
    if (current) id = `obstacle:${index}:${id}`;
    children.push({ id, x: obstacle.x, y: obstacle.y, width: obstacle.width, height: obstacle.height }); registered.set(id, obstacle);
  });
  let routed = new Map();
  try {
    await ensureLibavoid();
    routed = await routeLibavoidEdges({ id: "repo-canvas-routing", children, edges: routable.map((edge) => ({ id: edge.id, source: edge.source, target: edge.target })) }, LIBAVOID_OPTIONS);
  } catch (error) { console.warn(`Repo Canvas libavoid fallback: ${error?.message || error}`); }
  return routable.map((edge) => { const route = routed.get(edge.id); const source = boxes.get(edge.source); const target = boxes.get(edge.target); return route ? { ...edge, sourceBase: { x: source.x, y: source.y }, targetBase: { x: target.x, y: target.y }, points: simplify([route.sourcePoint, ...(route.bendPoints || []), route.targetPoint]), sourceSide: route.sourceSide, targetSide: route.targetSide } : localFallback(edge, boxes); }).filter(Boolean);
}

function aggregateRelations(snapshot) {
  const areaByEntity = new Map(snapshot.entities.map((entity) => [entity.id, entity.areaId])); const grouped = new Map();
  for (const relation of snapshot.relations || []) {
    const source = `entity:${relation.from}`; const target = `entity:${relation.to}`;
    if (!source || !target || source.endsWith("undefined") || target.endsWith("undefined") || source === target) continue;
    const key = `${source}->${target}:${relation.status || "existing"}`;
    const current = grouped.get(key) || { id: `relation:${key}`, source, target, status: relation.status || "existing", relations: [], priority: relation.status === "planned" ? 1 : 0 };
    current.relations.push(relation); grouped.set(key, current);
  }
  return [...grouped.values()].map((edge) => ({ ...edge, type: "relation", label: edge.relations.length === 1 ? (edge.relations[0].ownerLabel || edge.relations[0].label || "") : `${edge.relations.length} связи`, relationId: edge.relations.length === 1 ? edge.relations[0].id : "", sourceAreaId: areaByEntity.get(edge.relations[0].from), targetAreaId: areaByEntity.get(edge.relations[0].to) }));
}

function aggregateAreaRelations(snapshot) {
  const areaByEntity = new Map(snapshot.entities.map((entity) => [entity.id, entity.areaId])); const kindByEntity = new Map(snapshot.entities.map((entity) => [entity.id, entity.kind])); const grouped = new Map();
  for (const relation of snapshot.relations || []) {
    const sourceAreaId = areaByEntity.get(relation.from); const targetAreaId = areaByEntity.get(relation.to);
    const sourcePerson = kindByEntity.get(relation.from) === "person"; const targetPerson = kindByEntity.get(relation.to) === "person";
    if (sourcePerson === targetPerson && (!sourceAreaId || !targetAreaId || sourceAreaId === targetAreaId)) continue;
    const source = sourcePerson ? `entity:${relation.from}` : `area:${sourceAreaId}`;
    const target = targetPerson ? `entity:${relation.to}` : `area:${targetAreaId}`;
    if (source.endsWith("undefined") || target.endsWith("undefined") || source === target) continue;
    const key = `${source}->${target}:${relation.status || "existing"}`;
    const current = grouped.get(key) || { id: `area-relation:${key}`, source, target, sourceAreaId: sourceAreaId || targetAreaId, targetAreaId: targetAreaId || sourceAreaId, status: relation.status || "existing", relations: [], priority: relation.status === "planned" ? 1 : 0 };
    current.relations.push(relation); grouped.set(key, current);
  }
  return [...grouped.values()].map((edge) => ({ ...edge, type: "area-relation", label: edge.relations.length === 1 ? (edge.relations[0].ownerLabel || edge.relations[0].label || "связь областей") : `${edge.relations.length} связей между областями`, relationId: edge.relations.length === 1 ? edge.relations[0].id : "" }));
}

function workEdges(snapshot, hierarchy) {
  const output = [];
  for (const work of (snapshot.work || []).filter((item) => ["active", "blocked", "planned"].includes(item.status))) {
    for (const targetId of work.targets || []) {
      if (!hierarchy.byId.has(targetId)) continue;
      const areaId = hierarchy.byId.get(targetId)?.areaId || "";
      output.push({ id: `work-edge:${work.id}:${targetId}`, source: `entity:${targetId}`, target: `work:${work.id}`, type: "work", status: work.status, label: "", priority: -2, sourceAreaId: areaId, targetAreaId: `work:${work.id}` });
    }
  }
  return output;
}

async function routeView(snapshot, geometry, hierarchy, colors, includeEdge = () => true) {
  const boxes = new Map(); const obstacles = []; const boxesByArea = new Map(); const obstaclesByArea = new Map();
  const ensureArea = (areaId) => { if (!boxesByArea.has(areaId)) boxesByArea.set(areaId, new Map()); if (!obstaclesByArea.has(areaId)) obstaclesByArea.set(areaId, []); };
  for (const area of snapshot.areas) {
    const rect = geometry.areas.get(area.id); if (!rect) continue;
    ensureArea(area.id);
    const header = { x: rect.x + 18, y: rect.y + 14, width: Math.min(560, rect.width - 36), height: AREA_HEADER_H - 20, id: `area-header:${area.id}` };
    obstacles.push(header); obstaclesByArea.get(area.id).push(header);
  }
  for (const [id, rect] of geometry.entities) {
    const areaId = hierarchy.byId.get(id)?.areaId || ""; ensureArea(areaId);
    const obstacle = rect.group ? { x: rect.x, y: rect.y, width: rect.width, height: 74, id: `entity:${id}` } : { ...rect, id: `entity:${id}` };
    boxes.set(`entity:${id}`, obstacle); obstacles.push(obstacle); boxesByArea.get(areaId).set(`entity:${id}`, obstacle); obstaclesByArea.get(areaId).push(obstacle);
  }
  for (const [id, rect] of geometry.work) {
    const obstacle = { ...rect, id: `work:${id}` };
    boxes.set(`work:${id}`, rect); obstacles.push(obstacle);
  }
  const edges = [...aggregateRelations(snapshot), ...workEdges(snapshot, hierarchy)].filter(includeEdge).sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  const local = new Map(); const cross = [];
  for (const edge of edges) { if (edge.sourceAreaId && edge.sourceAreaId === edge.targetAreaId) { if (!local.has(edge.sourceAreaId)) local.set(edge.sourceAreaId, []); local.get(edge.sourceAreaId).push(edge); } else cross.push(edge); }
  const routed = [];
  for (const [areaId, areaEdges] of local) routed.push(...await routeEdges(areaEdges, boxesByArea.get(areaId) || new Map(), obstaclesByArea.get(areaId) || []));
  if (cross.length) routed.push(...await routeEdges(cross, boxes, obstacles));
  const workColors = { active: "#f09a52", blocked: "#ed716a", planned: "#e1b45d" };
  const routes = routed.map((route) => ({ ...route, color: route.type === "work" ? workColors[route.status] || workColors.active : colors.get(route.sourceAreaId) || colors.get(route.targetAreaId) || "#b88f72" }));
  return { routes };
}

async function routeAreaView(snapshot, geometry, colors, includeEdge = () => true) {
  const boxes = new Map(); const obstacles = [];
  for (const [id, rect] of geometry.areas) { boxes.set(`area:${id}`, rect); obstacles.push({ ...rect, id: `area:${id}` }); }
  for (const entity of snapshot.entities.filter((item) => item.kind === "person")) {
    const rect = geometry.entities.get(entity.id); if (!rect) continue;
    boxes.set(`entity:${entity.id}`, rect); obstacles.push({ ...rect, id: `entity:${entity.id}` });
  }
  const edges = aggregateAreaRelations(snapshot).filter(includeEdge).sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  return (await routeEdges(edges, boxes, obstacles)).map((route) => ({ ...route, color: colors.get(route.sourceAreaId) || colors.get(route.targetAreaId) || "#b88f72" }));
}

function mergeRoutes(current, updates) { const merged = new Map((current || []).map((route) => [route.id, route])); for (const route of updates || []) merged.set(route.id, route); return [...merged.values()]; }

let liveContext = null;

async function routeLiveMoves(message, emitPriority) {
  if (!liveContext || liveContext.revision !== message.revision || !Array.isArray(message.moves) || !message.moves.length) return null;
  const geometry = { ...liveContext.geometry, areas: new Map(liveContext.geometry.areas), entities: new Map(liveContext.geometry.entities), work: new Map(liveContext.geometry.work) };
  const movedNodeIds = new Set(); const movedAreaIds = new Set(); const movedPersonIds = new Set();
  for (const move of message.moves) {
    const nodeId = String(move.id || ""); const [kind, ...rest] = nodeId.split(":"); const id = rest.join(":"); const collection = kind === "area" ? geometry.areas : kind === "entity" ? geometry.entities : kind === "work" ? geometry.work : null; const current = collection?.get(id);
    if (!current || !Number.isFinite(move.x) || !Number.isFinite(move.y)) continue;
    collection.set(id, { ...current, x: move.x, y: move.y }); movedNodeIds.add(nodeId);
    if (kind === "area") movedAreaIds.add(id);
    if (kind === "entity" && liveContext.hierarchy.byId.get(id)?.kind === "person") movedPersonIds.add(id);
  }
  if (!movedNodeIds.size) return null;
  // At the overview zoom these are the only visible relations, so publish them
  // before doing any hidden entity-level routing work.
  const areaRoutes = movedAreaIds.size || movedPersonIds.size ? await routeAreaView(liveContext.snapshot, geometry, liveContext.colors, (edge) => movedAreaIds.has(edge.source.replace(/^area:/, "")) || movedAreaIds.has(edge.target.replace(/^area:/, "")) || movedPersonIds.has(edge.source.replace(/^entity:/, "")) || movedPersonIds.has(edge.target.replace(/^entity:/, ""))) : [];
  liveContext.geometry = geometry;
  if (areaRoutes.length) {
    liveContext.areaRoutes = mergeRoutes(liveContext.areaRoutes, areaRoutes);
    emitPriority?.({ routes: [], areaRoutes });
  }
  // Detailed routes only need their final geometry after the area is released.
  if ((movedAreaIds.size || movedPersonIds.size) && !message.settle) return null;
  const routes = (await routeView(liveContext.snapshot, geometry, liveContext.hierarchy, liveContext.colors, (edge) => movedNodeIds.has(edge.source) || movedNodeIds.has(edge.target))).routes;
  liveContext.routes = mergeRoutes(liveContext.routes, routes);
  return { routes, areaRoutes: [] };
}

async function calculate(snapshot, revision, emitPartial) {
  const requestedDirection = snapshot.map?.layoutDirection;
  const direction = requestedDirection === "DOWN" ? "DOWN" : "RIGHT";
  const colors = new Map(snapshot.areas.map((area, index) => [area.id, stableColor(area, index)]));
  const areaLayouts = new Map();
  for (const area of snapshot.areas) areaLayouts.set(area.id, await layoutArea(area, snapshot.entities.filter((entity) => entity.areaId === area.id), snapshot.relations || [], direction));
  const areas = await layoutAreas(snapshot, areaLayouts, direction);
  const entities = new Map();
  for (const area of snapshot.areas) {
    const areaRect = areas.get(area.id); const local = areaLayouts.get(area.id); if (!areaRect) continue;
    if (Number.isFinite(Number(area.x)) && Number.isFinite(Number(area.y))) { areaRect.x = Number(area.x); areaRect.y = Number(area.y); }
    for (const [id, rect] of local.entities) {
      const absolute = { ...rect, x: areaRect.x + rect.x, y: areaRect.y + rect.y };
      const entity = snapshot.entities.find((item) => item.id === id);
      if (Number.isFinite(Number(entity?.x)) && Number.isFinite(Number(entity?.y))) { absolute.x = Number(entity.x); absolute.y = Number(entity.y); }
      entities.set(id, absolute);
    }
  }
  for (const [id, rect] of placePeople(snapshot, areas, entities)) entities.set(id, rect);
  const hierarchy = ancestors(snapshot.entities);
  const work = workPositions(snapshot, entities, areas);
  const allRects = [...areas.values(), ...entities.values(), ...work.values()];
  const minX = Math.min(0, ...allRects.map((item) => item.x)); const minY = Math.min(0, ...allRects.map((item) => item.y)); const maxX = Math.max(1200, ...allRects.map((item) => item.x + item.width)); const maxY = Math.max(800, ...allRects.map((item) => item.y + item.height));
  const world = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  const geometry = { areas, entities, work, world };
  const areaRoutes = await routeAreaView(snapshot, geometry, colors);
  const base = {
    areas: [...areas].map(([id, rect]) => ({ id, ...rect, color: colors.get(id) })),
    entities: [...entities].map(([id, rect]) => ({ id, ...rect, topId: hierarchy.top.get(id), depth: hierarchy.depth.get(id) || 0 })),
    work: [...work].map(([id, rect]) => ({ id, ...rect })), world, areaRoutes,
  };
  const context = { revision, snapshot, geometry, hierarchy, colors, routes: [], areaRoutes };
  liveContext = context;
  emitPartial?.({ ...base, routes: [] });
  const routes = (await routeView(snapshot, geometry, hierarchy, colors)).routes;
  context.routes = routes;
  return { ...base, routes };
}

let pendingLayout = null; let pendingLive = null; let processing = false;
self.onmessage = (event) => { if (event.data.type === "route-drag") pendingLive = event.data; else pendingLayout = event.data; void pump(); };

async function pump() {
  if (processing) return; processing = true;
  try {
    while (pendingLive || pendingLayout) {
      if (pendingLive) {
        const message = pendingLive; pendingLive = null;
        try {
          const emitPriority = (result) => self.postMessage({ type: "live-routes", revision: message.revision, seq: message.seq, priority: true, ...result });
          const result = await routeLiveMoves(message, emitPriority); if (result) self.postMessage({ type: "live-routes", revision: message.revision, seq: message.seq, ...result });
        }
        catch (error) { self.postMessage({ type: "live-routes", revision: message.revision, seq: message.seq, error: String(error?.stack || error) }); }
        continue;
      }
      const message = pendingLayout; pendingLayout = null;
      try {
        const { id, revision, snapshot } = message;
        const result = await calculate(snapshot, revision, (partial) => self.postMessage({ id, revision, ok: true, partial: true, result: partial }));
        self.postMessage({ id, revision, ok: true, result });
      } catch (error) { self.postMessage({ id: message.id, ok: false, error: String(error?.stack || error) }); }
    }
  } finally { processing = false; if (pendingLive || pendingLayout) void pump(); }
}
