import {mergeReciprocalRoutes} from "./reciprocal-routes.js";
import ELK from "elkjs/lib/elk-api.js";
import elkWorkerUrl from "elkjs/lib/elk-worker.min.js?url";
import { createRoutingSession, init as initLibavoid, routeEdges as routeLibavoidEdges } from "@mr_mint/elkjs-libavoid";
import { LAYOUT_VERSION, AREA_HEADER_HEIGHT, packAreaGrid, normalizeStoredEntityPositions, displaceOverlappingAreas, restoredLayoutPosition } from "./container-layout.js";
import { ENTITY_BASE_HEIGHT, ENTITY_MIN_WIDTH, entityCardSize, groupHeaderSize } from "./node-geometry.js";
import { ROUTING_VERSION, RoutingRegistry } from "./routing-registry.js";
import { layoutFingerprint } from "./layout-fingerprint.js";


import { graphHierarchy } from './graph-contract.js';
import { isContainmentRoute } from './route-scene.js';
import { INTERACTIVE_ROUTING_OPTIONS, presentationRoutingScope, presentationRoutesFromResults } from './presentation-routing.js';

const elk = new ELK({ workerUrl: elkWorkerUrl });
const libavoidWasmUrl = new URL("../../node_modules/libavoid-js/dist/libavoid.wasm", import.meta.url).href;
let libavoidReady;
function ensureLibavoid() { if (!libavoidReady) libavoidReady = initLibavoid(libavoidWasmUrl).catch((error) => { libavoidReady = null; throw error; }); return libavoidReady; }
const ENTITY_W = ENTITY_MIN_WIDTH;
const ENTITY_H = ENTITY_BASE_HEIGHT;
const PERSON_W = 176;
const PERSON_H = 164;
const WORK_W = 240;
const WORK_H = 88;
const CLEARANCE = 24;
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
  for (const items of children.values()) items.sort((a, b) => Number(a.order || 0) - Number(b.order || 0) || String(a.label).localeCompare(String(b.label),"ru",{numeric:true}));
  return children;
}

async function layoutArea(area, entities,relations=[],direction="RIGHT") {
  const tree=entityTree(entities.filter(item=>item.kind!=="person"));
  const geometry=new Map();
  async function pack(items,headerHeight=AREA_HEADER_HEIGHT,minimumWidth=area.minWidth,minimumHeight=area.minHeight) {
    const owner=new Map(items.flatMap(item=>item.ids.map(id=>[id,item.id])));
    const edges=relations.filter(edge=>owner.has(edge.from)&&owner.has(edge.to)&&owner.get(edge.from)!==owner.get(edge.to)).map(edge=>({id:edge.id,sources:[owner.get(edge.from)],targets:[owner.get(edge.to)]}));
    if(!edges.length)return packAreaGrid({areaRect:{x:0,y:0},items,headerHeight,minimumWidth,minimumHeight,preserveOrder:true});
    const graph=await elk.layout({id:"flow-packing",layoutOptions:{"elk.algorithm":"layered","elk.direction":direction,"elk.edgeRouting":"ORTHOGONAL","elk.padding":`[top=${headerHeight},left=40,bottom=40,right=40]`,"elk.spacing.nodeNode":"60","elk.layered.spacing.nodeNodeBetweenLayers":"90","elk.layered.considerModelOrder.strategy":"NODES_AND_EDGES"},children:items.map(item=>({id:item.id,width:item.rect.width,height:item.rect.height})),edges});
    return {width:Math.max(graph.width,minimumWidth||0),height:Math.max(graph.height,minimumHeight||0),placements:graph.children.map(item=>({id:item.id,x:item.x,y:item.y}))};
  }
  async function build(item,depth=0){
    const children=await Promise.all((tree.get(item.id)||[]).map(child=>build(child,depth+1)));
    if(!children.length){const rect={...entityCardSize(item),x:0,y:0,depth,group:false};geometry.set(item.id,rect);return {id:item.id,rect,ids:[item.id]};}
    const header=groupHeaderSize(item,400);
    const packed=await pack(children,header.height+12,header.width+80);
    for(const placed of packed.placements){const child=children.find(item=>item.id===placed.id);for(const id of child.ids){const rect=geometry.get(id);rect.x+=placed.x;rect.y+=placed.y;}}
    const rect={x:0,y:0,width:packed.width,height:packed.height,headerWidth:header.width,headerHeight:header.height,group:true,depth};geometry.set(item.id,rect);
    return {id:item.id,rect,ids:[item.id,...children.flatMap(child=>child.ids)]};
  }
  const roots=await Promise.all((tree.get("")||[]).map(item=>build(item)));
  const packed=await pack(roots);
  for(const placed of packed.placements){const root=roots.find(item=>item.id===placed.id);for(const id of root.ids){const rect=geometry.get(id);rect.x+=placed.x;rect.y+=placed.y;}}
  return {width:packed.width,height:packed.height,entities:geometry};
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
      "elk.spacing.nodeNode": "96",
      "elk.layered.spacing.nodeNodeBetweenLayers": "112",
      "elk.spacing.componentComponent": "96",
      "elk.aspectRatio": "2.2",
      "elk.padding": "[top=32,left=32,bottom=32,right=32]",
    }),
    children: snapshot.areas.map((area) => ({
      id: area.id,
      width: Math.max(areaLayouts.get(area.id).width, Number(area.minWidth || 0)),
      height: Math.max(areaLayouts.get(area.id).height, Number(area.minHeight || 0)),
    })),
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
    ].filter(([side])=>side==="left"||side==="right").sort((a, b) => a[1] - b[1]);
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
    ...areaRects.values().map((rect) => ({ x: rect.x + 18, y: rect.y + 14, width: Math.max(0, rect.width - 36), height: AREA_HEADER_HEIGHT - 20 })),
  ];
  for (const work of (snapshot.work || []).filter((item) => ["active", "blocked", "planned"].includes(item.status))) {
    const manual = Number.isFinite(Number(work.x)) && Number.isFinite(Number(work.y)) ? { x: Number(work.x), y: Number(work.y) } : null;
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
    let selected = manual || candidates.find(fits);
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

function previewRoute(edge, boxes) {
  const source = boxes.get(edge.source); const target = boxes.get(edge.target); if (!source || !target) return null;
  const routeBase = { sourceBase: { x: source.x, y: source.y }, targetBase: { x: target.x, y: target.y } };
  const a = center(source); const b = center(target); const horizontal = Math.abs(b.x - a.x) >= Math.abs(b.y - a.y);
  if (horizontal) {
    const direction = b.x >= a.x ? 1 : -1; const start = { x: direction > 0 ? source.x + source.width : source.x, y: a.y }; const end = { x: direction > 0 ? target.x : target.x + target.width, y: b.y }; const midX = (start.x + end.x) / 2;
    return { ...edge, ...routeBase, points: simplify([start, { x: midX, y: start.y }, { x: midX, y: end.y }, end]), preview: true };
  }
  const direction = b.y >= a.y ? 1 : -1; const start = { x: a.x, y: direction > 0 ? source.y + source.height : source.y }; const end = { x: b.x, y: direction > 0 ? target.y : target.y + target.height }; const midY = (start.y + end.y) / 2;
  return { ...edge, ...routeBase, points: simplify([start, { x: start.x, y: midY }, { x: end.x, y: midY }, end]), preview: true };
}

function fitAreasToContents(snapshot, areas, entities) {
  const byArea = new Map();
  for (const entity of snapshot.entities) {
    if (entity.kind === "person") continue;
    const rect = entities.get(entity.id); if (!rect) continue;
    if (!byArea.has(entity.areaId)) byArea.set(entity.areaId, []);
    byArea.get(entity.areaId).push(rect);
  }
  for (const area of snapshot.areas) {
    const rect = areas.get(area.id); if (!rect) continue;
    const members = byArea.get(area.id) || [];
    const right = Math.max(rect.x + 520, ...members.map((item) => item.x + item.width + 40));
    const bottom = Math.max(rect.y + 260, ...members.map((item) => item.y + item.height + 40));
    const contentWidth = Math.max(520, right - rect.x);
    const contentHeight = Math.max(260, bottom - rect.y);
    rect.contentWidth = contentWidth;
    rect.contentHeight = contentHeight;
    rect.width = Math.max(rect.width,contentWidth, Number(area.minWidth || 0));
    rect.height = Math.max(rect.height,contentHeight, Number(area.minHeight || 0));
  }
}

const finalRouting = new RoutingRegistry({
  createSession:async graph=>{await ensureLibavoid();return createRoutingSession(graph,INTERACTIVE_ROUTING_OPTIONS);},
  routeOnce:async scope=>{await ensureLibavoid();return presentationRoutesFromResults(scope,await routeLibavoidEdges(scope.graph,INTERACTIVE_ROUTING_OPTIONS));},
  convertResults:presentationRoutesFromResults,
  onError:error=>console.warn('Final routing:',error),
});
async function routePresentation(message) {
  if(!message.routes.length){await finalRouting.replace([]);return [];}
  const scope=presentationRoutingScope(message.routes,message.scene);
  const previous=finalRouting.entries.get(scope.id);
  if(!previous||previous.scope.structure!==scope.structure)return finalRouting.replace([scope]);
  previous.scope.logicalRoutes=scope.logicalRoutes;previous.scope.scene=scope.scene;
  const moves=[...scope.nodes.values()].filter(node=>{const old=previous.scope.nodes.get(node.id);return !old||Math.abs(old.x-node.x)>.01||Math.abs(old.y-node.y)>.01;}).map(node=>({id:node.id,x:node.x,y:node.y}));
  await finalRouting.settle(moves);
  return finalRouting.routes();
}

function aggregateRelations(snapshot) {
  const descendants=graphHierarchy(snapshot).descendants;
  const areaByEntity = new Map(snapshot.entities.map((entity) => [entity.id, entity.areaId])); const grouped = new Map();
  for (const relation of snapshot.relations || []) {
    const source = `entity:${relation.from}`; const target = `entity:${relation.to}`;
    if(isContainmentRoute({source,target},descendants))continue;
    if (!source || !target || source.endsWith("undefined") || target.endsWith("undefined") || source === target) continue;
    const channelId=relation.channelId||relation.channel||"",sourcePort=relation.sourcePort||relation.fromPort||"",targetPort=relation.targetPort||relation.toPort||"";
    const key = `${source}->${target}:${relation.status || "existing"}:${JSON.stringify([channelId,sourcePort,targetPort])}`;
    const current = grouped.get(key) || { id: `relation:${key}`, source, target, channelId, sourcePort, targetPort, status: relation.status || "existing", relations: [], priority: relation.status === "planned" ? 1 : 0 };
    current.relations.push(relation); grouped.set(key, current);
  }
  return mergeReciprocalRoutes([...grouped.values()]).map((edge) => ({ ...edge, type: "relation", label: edge.sharedLabel || (edge.bidirectional ? "Обмен данными" : "") || (edge.relations.length === 1 ? (edge.relations[0].ownerLabel || edge.relations[0].label || "") : `${edge.relations.length} связей`), relationId: edge.relations.length === 1 ? edge.relations[0].id : "", sourceAreaId: areaByEntity.get(edge.relations[0].from), targetAreaId: areaByEntity.get(edge.relations[0].to) }));
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

function logicalRoutes(snapshot,geometry,hierarchy) {
  const boxes=new Map([...geometry.entities].map(([id,rect])=>['entity:'+id,rect]).concat([...geometry.work].map(([id,rect])=>['work:'+id,rect])));
  return [...aggregateRelations(snapshot),...workEdges(snapshot,hierarchy)]
    .sort((a,b)=>a.priority-b.priority||a.id.localeCompare(b.id))
    .map(edge=>previewRoute(edge,boxes)).filter(Boolean);
}

async function calculate(snapshot) {
  const requestedDirection = snapshot.map?.layoutDirection;
  const direction = requestedDirection === "DOWN" ? "DOWN" : "RIGHT";
  const colors = new Map(snapshot.areas.map((area, index) => [area.id, stableColor(area, index)]));
  const stored=snapshot._geometry||snapshot._layoutSeed;
  const structureKey=value=>{try{return JSON.stringify(JSON.parse(value).slice(0,4));}catch{return value;}};
  const complete=stored && stored.routingVersion >= 3 && stored.layoutVersion === LAYOUT_VERSION && (!stored.fingerprint||structureKey(stored.fingerprint)===structureKey(layoutFingerprint(snapshot))) && stored.areas.length===snapshot.areas.length && stored.entities.length===snapshot.entities.length && snapshot.entities.every(item=>stored.entities.some(rect=>rect.id===item.id));
  const sourcePositions = Object.fromEntries([...snapshot.areas,...snapshot.entities,...(snapshot.work || [])].map(item => [item.id,[item.x ?? null,item.y ?? null]]));
  const reusePositions = stored?.layoutVersion === LAYOUT_VERSION;
  const areaLayouts = new Map();
  let areas;let entities;
  if(complete) {
    areas=new Map(stored.areas.map(rect=>[rect.id,{...rect}]));
    entities=new Map(stored.entities.map(rect=>[rect.id,{...rect}]));
    for(const item of [...snapshot.areas,...snapshot.entities]){const rect=areas.get(item.id)||entities.get(item.id);if(rect && JSON.stringify(sourcePositions[item.id]) !== JSON.stringify(stored.sourcePositions?.[item.id]) && Number.isFinite(item.x)&&Number.isFinite(item.y)){rect.x=item.x;rect.y=item.y;}}
  } else {
  for (const area of snapshot.areas) areaLayouts.set(area.id, await layoutArea(area, snapshot.entities.filter((entity) => entity.areaId === area.id), snapshot.relations || [], direction));
  areas = await layoutAreas(snapshot, areaLayouts, direction);
  const entityById = new Map(snapshot.entities.map((entity) => [entity.id, entity]));
  entities = new Map();
  const defaultEntities = new Map();
  for (const area of snapshot.areas) {
    const areaRect = areas.get(area.id); const local = areaLayouts.get(area.id); if (!areaRect) continue;
    const previousArea=stored?.areas?.find(item=>item.id===area.id);
    const restoredArea=restoredLayoutPosition(area,reusePositions?previousArea:null,reusePositions?stored.sourcePositions?.[area.id]:null);
    if(restoredArea)Object.assign(areaRect,restoredArea);
    areaRect.width = Math.max(areaRect.width, Number(area.minWidth || 0)); areaRect.height = Math.max(areaRect.height, Number(area.minHeight || 0));
    for (const [id, rect] of local.entities) {
      const absolute = { ...rect, x: areaRect.x + rect.x, y: areaRect.y + rect.y };
      defaultEntities.set(id, { ...absolute });
      const entity = entityById.get(id);
      const previous=stored?.entities?.find(item=>item.id===id);
      if(reusePositions&&previous&&!rect.group){absolute.width=previous.width;absolute.height=entityCardSize(entity,previous.width).height;}
      const restored=restoredLayoutPosition(entity,reusePositions?previous:null,reusePositions?stored.sourcePositions?.[id]:null);
      if(restored)Object.assign(absolute,restored);
      entities.set(id, absolute);
    }
  }
  // Free nodes are first-class map objects and retain their saved coordinates.
  const free=snapshot.entities.filter(entity=>!entity.areaId&&entity.kind!=='person');
  if(free.length) {
    const local=await layoutArea({id:'',title:''},free,snapshot.relations||[],direction);
    const left=Math.max(0,...[...areas.values()].map(rect=>rect.x+rect.width))+120;
    for(const [id,rect] of local.entities) {
      const entity=entityById.get(id),previous=stored?.entities?.find(item=>item.id===id);
      const restored=restoredLayoutPosition(entity,previous,stored?.sourcePositions?.[id]);
      const absolute={...rect,x:restored?.x??left+rect.x,y:restored?.y??rect.y};
      entities.set(id,absolute);defaultEntities.set(id,{...absolute});
    }
  }
  entities = normalizeStoredEntityPositions(snapshot, entities, defaultEntities, areas);
  }
  // Retain saved coordinates; only allow enough height for the new readable type.
  for(const entity of snapshot.entities){const rect=entities.get(entity.id);if(rect&&!rect.group&&entity.kind!=="person")rect.height=Math.max(rect.height,entityCardSize(entity,rect.width).height);}
  fitAreasToContents(snapshot, areas, entities);
  // A changed map must not inherit obsolete rectangles after normalization.
  // Move each area with all its members so its internal layout stays intact.
  for (const anchorId of areas.keys()) {
    const separated = displaceOverlappingAreas(areas, anchorId).rects;
    for (const [id, rect] of separated) {
      const before = areas.get(id);
      const dx = rect.x - before.x, dy = rect.y - before.y;
      if (dx || dy) for (const entity of snapshot.entities) {
        if (entity.areaId !== id || entity.kind === "person") continue;
        const member = entities.get(entity.id);
        if (member) { member.x += dx; member.y += dy; }
      }
    }
    areas = separated;
  }
  if (!complete) for (const [id, rect] of placePeople(snapshot, areas, entities)) entities.set(id, rect);
  const hierarchy = ancestors(snapshot.entities);
  const work = workPositions(snapshot, entities, areas);
  const allRects = [...areas.values(), ...entities.values(), ...work.values()];
  const minX = Math.min(0, ...allRects.map((item) => item.x)); const minY = Math.min(0, ...allRects.map((item) => item.y)); const maxX = Math.max(1200, ...allRects.map((item) => item.x + item.width)); const maxY = Math.max(800, ...allRects.map((item) => item.y + item.height));
  const world = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  const geometry = { areas, entities, work, world };
  return {
    routingVersion:ROUTING_VERSION, layoutVersion:LAYOUT_VERSION, sourcePositions,
    areas:[...areas].map(([id,rect])=>({id,...rect,color:colors.get(id)})),
    entities:[...entities].map(([id,rect])=>({id,...rect,topId:hierarchy.top.get(id),depth:hierarchy.depth.get(id)||0})),
    work:[...work].map(([id,rect])=>({id,...rect})),world,
    routes:logicalRoutes(snapshot,geometry,hierarchy),
  };
}

let pendingLayout=null,pendingPresentation=null,processing=false;
self.onmessage=({data})=>{if(data.type==='present-routes')pendingPresentation=data;else if(data.type==='layout'||data.type==='arrange')pendingLayout=data;void pump();};
async function pump() {
  if(processing)return;processing=true;
  try {
    while(pendingLayout||pendingPresentation) {
      if(pendingLayout) {
        const message=pendingLayout;pendingLayout=null;
        try {const result=await calculate(message.snapshot);self.postMessage({type:message.type==='arrange'?'arranged':'layout',id:message.id,layoutKey:message.layoutKey,ok:true,result});}
        catch(error){self.postMessage({type:message.type==='arrange'?'arranged':'layout',id:message.id,layoutKey:message.layoutKey,ok:false,error:String(error?.stack||error)});}
      } else {
        await new Promise(resolve=>setTimeout(resolve,0));if(pendingLayout)continue;
        const message=pendingPresentation;pendingPresentation=null;
        try {
          const start=performance.now(),routes=await routePresentation(message);
          if(routes.length!==message.routes.length||routes.some(route=>!route.finalGeometry))throw new Error('Final routes are incomplete');
          self.postMessage({type:'presented-routes',key:message.key,layoutKey:message.layoutKey,seq:message.seq,routes,elapsed:performance.now()-start});
        }catch(error){self.postMessage({type:'presented-routes',key:message.key,layoutKey:message.layoutKey,seq:message.seq,error:String(error?.stack||error)});}
      }
    }
  }finally{processing=false;if(pendingLayout||pendingPresentation)void pump();}
}
