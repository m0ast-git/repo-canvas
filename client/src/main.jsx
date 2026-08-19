import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Background, BaseEdge, EdgeLabelRenderer, Handle, MarkerType, Position, ReactFlow, ReactFlowProvider,
  applyNodeChanges, useReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { patchSnapshotPositions } from "./canvas-snapshot.js";
import { currentWork, graphHierarchy, graphItemMoveIds } from "./graph-contract.js";
import { layoutFingerprint } from "./layout-fingerprint.js";
import { updateFinished, updatePollDelay } from "./update-polling.js";
import "./styles.css";

const TOKEN_KEY = "repo-canvas.api-token";
const NODE_READABLE_ZOOM = .52;
const WORK_READABLE_ZOOM = .78;
const THEME_KEY = "repo-canvas.theme";
const ARCHITECT_PHASES = {
  starting: "Подключаем Architect",
  inspecting: "Читаем устройство проекта",
  reasoning: "Собираем смысловую карту",
  validating: "Проверяем связи и сценарии",
  repairing: "Исправляем структуру результата",
  reviewing: "Проверяем карту глазами владельца",
  refining: "Дорабатываем замечания приёмки",
  applying: "Сохраняем новую карту",
};
const nodeKinds = { capability: "ВОЗМОЖНОСТЬ", module: "МОДУЛЬ", service: "СЕРВИС", process: "ПРОЦЕСС", store: "ХРАНИЛИЩЕ", interface: "ИНТЕРФЕЙС", integration: "ИНТЕГРАЦИЯ", external: "ВНЕШНЯЯ СИСТЕМА", component: "КОМПОНЕНТ", person: "УЧАСТНИК" };

function readToken() {
  const hash = new URLSearchParams(location.hash.replace(/^#/, ""));
  const supplied = hash.get("token");
  if (supplied) { localStorage.setItem(TOKEN_KEY, supplied); history.replaceState(null, "", `${location.pathname}${location.search}`); return supplied; }
  return localStorage.getItem(TOKEN_KEY) || "";
}

let apiToken = readToken();
async function api(path, options = {}) {
  return fetch(path, { ...options, headers: { ...(options.headers || {}), "X-Repo-Canvas-Token": apiToken }, cache: options.cache || "no-store" });
}

function relativeTime(value) {
  if (!value) return "—"; const seconds = Math.max(0, Math.round((Date.now() - Date.parse(value)) / 1000));
  if (seconds < 5) return "сейчас"; if (seconds < 60) return `${seconds} сек`; if (seconds < 3600) return `${Math.floor(seconds / 60)} мин`; return `${Math.floor(seconds / 3600)} ч`;
}

function overlap(a, b, gap = 0) { return a.x - gap < b.x + b.width && a.x + a.width + gap > b.x && a.y - gap < b.y + b.height && a.y + a.height + gap > b.y; }
function routePath(points, radius = 16) {
  if (!points?.length) return ""; if (points.length < 3) return `M ${points[0].x} ${points[0].y} L ${points.at(-1).x} ${points.at(-1).y}`;
  const parts = [`M ${points[0].x} ${points[0].y}`];
  for (let index = 1; index < points.length - 1; index += 1) {
    const previous = points[index - 1]; const current = points[index]; const next = points[index + 1];
    const incoming = Math.hypot(current.x - previous.x, current.y - previous.y); const outgoing = Math.hypot(next.x - current.x, next.y - current.y); const corner = Math.min(radius, incoming / 2, outgoing / 2);
    const entry = { x: current.x + (previous.x - current.x) * corner / Math.max(1, incoming), y: current.y + (previous.y - current.y) * corner / Math.max(1, incoming) };
    const exit = { x: current.x + (next.x - current.x) * corner / Math.max(1, outgoing), y: current.y + (next.y - current.y) * corner / Math.max(1, outgoing) };
    parts.push(`L ${entry.x} ${entry.y} Q ${current.x} ${current.y} ${exit.x} ${exit.y}`);
  }
  parts.push(`L ${points.at(-1).x} ${points.at(-1).y}`); return parts.join(" ");
}

function followMovedNodes(route, baseRects, currentRects) {
  if (!route.points?.length) return route;
  const sourceBase = route.sourceBase || baseRects.get(route.source); const targetBase = route.targetBase || baseRects.get(route.target);
  const sourceCurrent = currentRects.get(route.source); const targetCurrent = currentRects.get(route.target);
  if (!sourceBase || !targetBase || !sourceCurrent || !targetCurrent) return route;
  const sourceDelta = { x: sourceCurrent.x - sourceBase.x, y: sourceCurrent.y - sourceBase.y };
  const targetDelta = { x: targetCurrent.x - targetBase.x, y: targetCurrent.y - targetBase.y };
  if (![sourceDelta.x, sourceDelta.y, targetDelta.x, targetDelta.y].some((value) => Math.abs(value) > .01)) return route;
  const last = Math.max(1, route.points.length - 1);
  const points = route.points.map((point, index) => { const progress = index / last; return { x: point.x + sourceDelta.x * (1 - progress) + targetDelta.x * progress, y: point.y + sourceDelta.y * (1 - progress) + targetDelta.y * progress }; });
  return { ...route, points };
}

function labelCandidates(points, width) {
  const candidates = [];
  for (let index = 1; index < points.length; index += 1) {
    const from = points[index - 1]; const to = points[index]; const length = Math.hypot(to.x - from.x, to.y - from.y);
    const vertical = Math.abs(to.y - from.y) > Math.abs(to.x - from.x);
    if (length < (vertical ? 54 : width + 30)) continue;
    for (const fraction of [.5, .34, .66, .2, .8]) candidates.push({ x: from.x + (to.x - from.x) * fraction, y: from.y + (to.y - from.y) * fraction, score: Math.abs(fraction - .5) + index / points.length * .05 });
  }
  return candidates.sort((a, b) => a.score - b.score);
}

function placeLabels(routes, viewport, size, obstacles) {
  if (!size.width || !viewport.zoom) return new Map();
  const visible = { x: -viewport.x / viewport.zoom, y: -viewport.y / viewport.zoom, width: size.width / viewport.zoom, height: size.height / viewport.zoom };
  const occupied = []; const result = new Map();
  for (const route of routes.filter((item) => item.label)) {
    const width = Math.min(260, Math.max(96, route.label.length * 6.5 + 32)); const height = 32;
    const visualWidth = width / viewport.zoom; const visualHeight = height / viewport.zoom;
    let safe = true; let point = labelCandidates(route.points, visualWidth).find((candidate) => {
      const box = { x: candidate.x - visualWidth / 2, y: candidate.y - visualHeight / 2, width: visualWidth, height: visualHeight };
      const inside = box.x >= visible.x + 8 / viewport.zoom && box.y >= visible.y + 8 / viewport.zoom && box.x + box.width <= visible.x + visible.width - 8 / viewport.zoom && box.y + box.height <= visible.y + visible.height - 8 / viewport.zoom;
      return inside && !obstacles.some((item) => overlap(box, item, 5)) && !occupied.some((item) => overlap(box, item, 10));
    });
    if (!point) { safe = false;
      const segments = route.points.slice(1).map((to, index) => ({ from: route.points[index], to, length: Math.hypot(to.x - route.points[index].x, to.y - route.points[index].y) })).sort((a, b) => b.length - a.length);
      point = segments.flatMap((segment) => [.5, .25, .75].map((fraction) => ({ x: segment.from.x + (segment.to.x - segment.from.x) * fraction, y: segment.from.y + (segment.to.y - segment.from.y) * fraction }))).find((candidate) => candidate.x >= visible.x && candidate.y >= visible.y && candidate.x <= visible.x + visible.width && candidate.y <= visible.y + visible.height);
      if (!point && segments[0]) point = { x: (segments[0].from.x + segments[0].to.x) / 2, y: (segments[0].from.y + segments[0].to.y) / 2 };
    }
    if (point) { const box = { x: point.x - visualWidth / 2, y: point.y - visualHeight / 2, width: visualWidth, height: visualHeight }; if (safe) occupied.push(box); result.set(route.id, { ...point, width, height, scale: 1 / viewport.zoom, safe }); }
  }
  return result;
}

const HiddenHandles = () => <><Handle type="target" position={Position.Left} className="hidden-handle" /><Handle type="source" position={Position.Right} className="hidden-handle" /></>;

const AreaNode = memo(({ data }) => <section className={`area-node ${data.distant ? "is-distant" : ""} ${data.activeCount ? "is-active" : ""} ${data.muted ? "is-muted" : ""}`} style={{ "--area-color": data.color, "--area-stroke-scale": data.labelScale || 1 }}>
  <HiddenHandles />
  <header className="graph-item-body" title="Перетащите область · двойной клик: изменить текст" onDoubleClick={(event) => { event.stopPropagation(); data.edit("area", data.area.id, data.title, data.description); }} style={{ transform: `scale(${data.labelScale || 1})` }}><span className="map-drag-handle">⠿</span><small>ОБЛАСТЬ ПРОЕКТА</small><h2>{data.title}</h2><p>{data.description}</p>{data.activeCount > 0 && <b>{data.activeCount} {data.activeCount === 1 ? "работа" : "работы"}</b>}</header>
</section>);

const GroupNode = memo(({ data }) => <section className={`group-node ${data.activeCount ? "is-active" : ""} ${data.muted ? "is-muted" : ""}`} style={{ "--area-color": data.color }}>
  <HiddenHandles />
  <i className="group-contour" aria-hidden="true" style={{ left: data.contour?.left || 0, top: data.contour?.top || 0, width: data.contour?.width || "100%", height: data.contour?.height || "100%" }}></i>
  <header className="graph-item-body" onClick={(event) => { event.stopPropagation(); data.select(data.entity); }} onDoubleClick={(event) => { event.stopPropagation(); data.edit("entity", data.entity.id, data.label, data.description); }} title="Перетащите блок и всё его содержимое · двойной клик: изменить текст">
    <span className="map-drag-handle">⠿</span><small>{nodeKinds[data.entity.kind] || "БЛОК"}</small><strong>{data.label}</strong><p>{data.description}</p>{data.activeCount > 0 && <b>{data.activeCount}</b>}
  </header>
</section>);

const EntityNode = memo(({ data }) => <article className={`entity-node graph-item-body ${data.status || "operational"} ${data.activeCount ? "is-active" : ""} ${data.muted ? "is-muted" : ""}`} style={{ "--area-color": data.color }} onClick={(event) => { event.stopPropagation(); data.select(data.entity); }} onDoubleClick={(event) => { event.stopPropagation(); data.edit("entity", data.entity.id, data.label, data.description); }} title="Перетащите элемент · двойной клик: изменить текст">
  <HiddenHandles />
  <span className="map-drag-handle">⠿</span><span>{nodeKinds[data.entity.kind] || "ЭЛЕМЕНТ"}</span><strong>{data.label}</strong><small>{data.description}</small><i></i>{data.activeCount > 0 && <b>{data.activeCount}</b>}
</article>);

const PersonNode = memo(({ data }) => <button className={`person-node graph-item-body ${data.muted ? "is-muted" : ""}`} style={{ "--area-color": data.color }} type="button" onClick={(event) => { event.stopPropagation(); data.select(data.entity); }} onDoubleClick={(event) => { event.stopPropagation(); data.edit("entity", data.entity.id, data.label, data.description); }} title="Участник продукта · перетащите или измените двойным кликом">
  <HiddenHandles /><span className="person-avatar" aria-hidden="true"><i></i><b></b></span><strong>{data.label}</strong><small>{data.description}</small>
</button>);

const WorkNode = memo(({ data }) => <button className={`work-node graph-item-body ${data.visible ? "is-readable" : "is-concealed"} ${data.work.status} ${data.work.provisional ? "provisional" : ""}`} style={{ "--area-color": data.color }} type="button" title={data.work.session ? "Перетащите работу · двойной клик: открыть рабочую сессию" : "Перетащите работу · сессия не привязана"} onDoubleClick={(event) => { event.stopPropagation(); data.open(data.work); }}>
  <HiddenHandles /><i>✦</i><span><small>{data.work.actor || "agent"} · {data.work.status === "blocked" ? "ЖДЁТ" : data.work.status === "planned" ? "ПЛАН" : "В РАБОТЕ"}</small><strong>{data.work.title}</strong></span>{data.work.session && <b>↗</b>}
</button>);

const RoutedEdge = memo(({ id, data, markerEnd }) => {
  const path = routePath(data.route.points); const placement = data.placement;
  const showLabel = placement && (data.hovered || data.persistentLabel && placement.safe);
  const bundled = (data.route.relations || []).length > 1;
  return <>
    <BaseEdge id={id} path={path} markerEnd={markerEnd} interactionWidth={32} style={{ stroke: data.route.color, strokeWidth: data.hovered ? 4.8 : data.route.type === "area-relation" ? 4.1 : data.route.type === "work" ? 2.6 : 2.25, strokeDasharray: data.route.type === "work" ? "7 7" : data.route.status === "planned" ? "10 8" : undefined, opacity: data.hidden ? 0 : data.muted ? .12 : data.hovered ? 1 : data.opacity, filter: data.route.type === "work" && !data.hidden ? `drop-shadow(0 0 4px ${data.route.color})` : data.route.type === "area-relation" ? `drop-shadow(0 0 2px ${data.route.color})` : undefined }} className={!data.hidden && data.route.type === "work" && data.route.status === "active" ? "animated-route" : ""} />
    {showLabel && <EdgeLabelRenderer><button type="button" className={`route-label nodrag nopan ${bundled ? "is-bundle" : ""}`} style={{ left: placement.x, top: placement.y, width: placement.width, height: placement.height, "--label-scale": placement.scale, "--edge-color": data.route.color, opacity: data.muted ? .12 : 1 }} title={bundled ? `Показать все ${data.route.relations.length} связей` : `${data.route.label} · Двойной клик: изменить подпись`} onClick={(event) => { event.stopPropagation(); if (bundled) data.openBundle(data.route, event); }} onMouseEnter={() => data.keepHover(id)} onMouseLeave={data.leaveHover} onDoubleClick={(event) => { event.stopPropagation(); if (data.route.relationId) data.edit("relation", data.route.relationId, data.route.label, ""); }}>{data.route.label}</button></EdgeLabelRenderer>}
  </>;
});

const nodeTypes = { area: AreaNode, group: GroupNode, entity: EntityNode, person: PersonNode, work: WorkNode };
const edgeTypes = { routed: RoutedEdge };

function useLayout(snapshot) {
  const layoutKey = useMemo(() => layoutFingerprint(snapshot), [snapshot]);
  const [layout, setLayout] = useState(null); const [routeState, setRouteState] = useState({ revision: null, routes: [], areaRoutes: [] }); const requestId = useRef(0); const routingEpoch = useRef(0); const activeRoutingEpoch = useRef(0); const liveSeq = useRef(0); const appliedLiveSeq = useRef(0); const liveOverrides = useRef({ revision: null, routes: new Map(), areaRoutes: new Map() }); const worker = useRef(null); const pendingMoves = useRef(null); const dragFrame = useRef(null);
  useEffect(() => {
    worker.current = new Worker(new URL("./layout-worker.js", import.meta.url), { type: "module" });
    worker.current.onmessage = (event) => {
      const data = event.data;
      if (data.type === "live-routes") {
        if (data.error) { console.warn(data.error); return; }
        if (data.revision !== activeRoutingEpoch.current || data.seq < appliedLiveSeq.current) return;
        appliedLiveSeq.current = data.seq;
        if (liveOverrides.current.revision !== data.revision) liveOverrides.current = { revision: data.revision, routes: new Map(), areaRoutes: new Map() };
        for (const route of data.routes || []) liveOverrides.current.routes.set(route.id, route);
        for (const route of data.areaRoutes || []) liveOverrides.current.areaRoutes.set(route.id, route);
        setRouteState((current) => {
          if (current.revision !== data.revision) return current;
          const merge = (base, updates) => { const output = new Map((base || []).map((route) => [route.id, route])); for (const route of updates || []) output.set(route.id, route); return [...output.values()]; };
          return { ...current, routes: merge(current.routes, data.routes), areaRoutes: merge(current.areaRoutes, data.areaRoutes) };
        });
        return;
      }
      if (data.id !== requestId.current) return;
      if (data.ok) {
        const next = { ...data.result, revision: data.revision };
        setLayout((current) => data.partial || !current || current.revision !== data.revision ? next : current);
        setRouteState((current) => {
          const merge = (base, updates) => { const output = new Map((base || []).map((route) => [route.id, route])); for (const route of updates || []) output.set(route.id, route); return [...output.values()]; };
          if (data.partial) {
            const valid = new Set([...(next.areas || []).map((item) => `area:${item.id}`), ...(next.entities || []).map((item) => `entity:${item.id}`), ...(next.work || []).map((item) => `work:${item.id}`)]);
            return { revision: data.revision, routes: (current.routes || []).filter((route) => valid.has(route.source) && valid.has(route.target)), areaRoutes: next.areaRoutes || [] };
          }
          const overrides = liveOverrides.current.revision === data.revision ? liveOverrides.current : null;
          return { revision: data.revision, routes: merge(next.routes, overrides ? [...overrides.routes.values()] : []), areaRoutes: merge(next.areaRoutes, overrides ? [...overrides.areaRoutes.values()] : []) };
        });
      }
      else console.error(data.error);
    };
    return () => { cancelAnimationFrame(dragFrame.current); worker.current?.terminate(); };
  }, []);
  useEffect(() => {
    if (!snapshot || !worker.current) return;
    const revision = ++routingEpoch.current; activeRoutingEpoch.current = revision; appliedLiveSeq.current = 0;
    liveOverrides.current = { revision: null, routes: new Map(), areaRoutes: new Map() };
    requestId.current += 1; worker.current.postMessage({ type: "layout", id: requestId.current, revision, snapshot });
  }, [layoutKey]);
  const routeDrag = useCallback((moves, immediate = false) => {
    pendingMoves.current = { moves, settle: immediate };
    const send = () => { dragFrame.current = null; const current = pendingMoves.current; pendingMoves.current = null; if (!current?.moves?.length || !worker.current) return; const seq = ++liveSeq.current; worker.current.postMessage({ type: "route-drag", revision: activeRoutingEpoch.current, seq, ...current }); };
    if (immediate) { cancelAnimationFrame(dragFrame.current); send(); return; }
    if (dragFrame.current === null) dragFrame.current = requestAnimationFrame(send);
  }, []);
  return { layout, routes: routeState.routes, areaRoutes: routeState.areaRoutes, routeDrag };
}

function useContainerSize(ref) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => { if (!ref.current) return; const observer = new ResizeObserver(([entry]) => setSize({ width: entry.contentRect.width, height: entry.contentRect.height })); observer.observe(ref.current); return () => observer.disconnect(); }, [ref]);
  return size;
}

function activeRollup(snapshot) {
  const byId = new Map(snapshot.entities.map((entity) => [entity.id, entity])); const entities = new Map(); const areas = new Map();
  for (const work of snapshot.work.filter((item) => item.status === "active")) {
    const workEntities = new Set(); const workAreas = new Set();
    for (const target of work.targets || []) {
      let current = byId.get(target); const seen = new Set();
      while (current && !seen.has(current.id) && current.kind !== "person") { seen.add(current.id); workEntities.add(current.id); if (current.areaId) workAreas.add(current.areaId); current = current.parentId ? byId.get(current.parentId) : null; }
    }
    for (const id of workEntities) entities.set(id, (entities.get(id) || 0) + 1);
    for (const id of workAreas) areas.set(id, (areas.get(id) || 0) + 1);
  }
  return { entities, areas };
}

function fitGroupContours(nodes, hierarchy) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  return nodes.map((node) => {
    if (node.type !== "group") return node;
    const width = Number(node.style?.width || 0); const height = Number(node.style?.height || 0);
    let left = 0; let top = 0; let right = width; let bottom = height;
    const entityId = node.id.replace(/^entity:/, "");
    for (const childId of hierarchy.get(entityId) || []) {
      const child = byId.get(`entity:${childId}`); if (!child) continue;
      const childWidth = Number(child.style?.width || 0); const childHeight = Number(child.style?.height || 0);
      left = Math.min(left, child.position.x - node.position.x - 18);
      top = Math.min(top, child.position.y - node.position.y - 18);
      right = Math.max(right, child.position.x + childWidth - node.position.x + 18);
      bottom = Math.max(bottom, child.position.y + childHeight - node.position.y + 18);
    }
    const contour = { left, top, width: right - left, height: bottom - top };
    return { ...node, data: { ...node.data, contour } };
  });
}

function Canvas({ snapshot, setSnapshot, toast, unauthorized, theme, toggleTheme, architect, setArchitect }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 15_000); return () => clearInterval(timer); }, []);
  const liveWork = useMemo(() => currentWork(snapshot, now), [snapshot, now]);
  const displaySnapshot = useMemo(() => ({ ...snapshot, work: liveWork, summary: { ...snapshot.summary, activeWork: liveWork.length } }), [snapshot, liveWork]);
  const { layout, routes: detailedRoutes, areaRoutes, routeDrag } = useLayout(displaySnapshot); const wrapper = useRef(null); const size = useContainerSize(wrapper); const flow = useReactFlow();
  const fittedOnce = useRef(false);
  const [viewport, setViewport] = useState({ x: 0, y: 0, zoom: .1 }); const viewportFrame = useRef(null); const pendingViewport = useRef(viewport);
  const [selectedArea, setSelectedArea] = useState("all"); const [selectedEntity, setSelectedEntity] = useState(null); const [collapsed, setCollapsed] = useState(new Set()); const [legend, setLegend] = useState(false); const [edit, setEdit] = useState(null); const [regenerate, setRegenerate] = useState(false); const [viewpoint, setViewpoint] = useState(""); const [dismissedArchitect, setDismissedArchitect] = useState(null); const [nodes, setNodes] = useState([]); const [hoveredEdge, setHoveredEdge] = useState(null); const [relationBundle, setRelationBundle] = useState(null); const [historyState, setHistoryState] = useState({ undo: 0, redo: 0 }); const drag = useRef(null); const manualPositions = useRef(new Map()); const edgeLeaveTimer = useRef(null); const revisionRef = useRef(snapshot.revision); const history = useRef({ past: [], future: [] }); const mutationQueue = useRef(Promise.resolve()); const historyBusy = useRef(false);
  const activityTier = viewport.zoom < NODE_READABLE_ZOOM ? "area" : viewport.zoom < WORK_READABLE_ZOOM ? "entity" : "work";
  const hierarchy = useMemo(() => graphHierarchy(snapshot).descendants, [snapshot.entities]); const activity = useMemo(() => activeRollup(displaySnapshot), [displaySnapshot]);
  const areaMap = useMemo(() => new Map(snapshot.areas.map((area) => [area.id, area])), [snapshot]); const entityMap = useMemo(() => new Map(snapshot.entities.map((entity) => [entity.id, entity])), [snapshot]);
  const connectedAreas = useMemo(() => { const result = new Map(); for (const person of snapshot.entities.filter((entity) => entity.kind === "person")) { const areas = new Set(); for (const relation of snapshot.relations || []) { if (relation.from !== person.id && relation.to !== person.id) continue; const other = entityMap.get(relation.from === person.id ? relation.to : relation.from); if (other?.areaId) areas.add(other.areaId); } result.set(person.id, areas); } return result; }, [snapshot.entities, snapshot.relations, entityMap]);
  const layoutAreas = useMemo(() => new Map((layout?.areas || []).map((item) => [item.id, item])), [layout]); const detailPositions = useMemo(() => new Map((layout?.entities || []).map((item) => [item.id, item])), [layout]); const workPositions = useMemo(() => new Map((layout?.work || []).map((item) => [item.id, item])), [layout]);
  const colors = useMemo(() => new Map((layout?.areas || []).map((item) => [item.id, item.color])), [layout]);

  useEffect(() => { revisionRef.current = snapshot.revision; }, [snapshot.revision]);
  const syncHistory = useCallback(() => setHistoryState({ undo: history.current.past.length, redo: history.current.future.length }), []);
  const remember = useCallback((entry) => { history.current.past.push(entry); if (history.current.past.length > 100) history.current.past.shift(); history.current.future = []; syncHistory(); }, [syncHistory]);
  const enqueueMutation = useCallback((task) => { const run = mutationQueue.current.then(task, task); mutationQueue.current = run.catch(() => {}); return run; }, []);
  const refreshSnapshot = useCallback(async () => { const response = await api(`/api/state?t=${Date.now()}`); if (response.ok) setSnapshot(await response.json()); }, [setSnapshot]);
  const persistLayout = useCallback(async (items) => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await api("/api/layout", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ canvasRevision: revisionRef.current, items }) });
      const result = await response.json();
      if (response.status === 409 && attempt < 2) {
        const latestResponse = await api(`/api/state?t=${Date.now()}`); if (!latestResponse.ok) throw new Error(result.error || `HTTP ${latestResponse.status}`);
        const latest = await latestResponse.json(); revisionRef.current = latest.revision; setSnapshot(latest); continue;
      }
      if (!response.ok) throw new Error(result.error);
      revisionRef.current = result.revision; setSnapshot((current) => patchSnapshotPositions(current, items, result.revision)); return result;
    }
    throw new Error("Canvas changed repeatedly while saving the position");
  }, [setSnapshot]);
  const openEdit = useCallback((kind, id, title, description = "") => setEdit({ kind, id, title, description, original: { title, description } }), []);
  const openRelationBundle = useCallback((route, event) => { const rect = wrapper.current?.getBoundingClientRect(); if (!rect) return; const width = Math.min(360, rect.width - 24); const x = Math.max(12, Math.min(rect.width - width - 12, event.clientX - rect.left + 12)); const y = Math.max(12, Math.min(rect.height - 330, event.clientY - rect.top + 12)); setRelationBundle({ route, x, y, width }); }, []);
  const keepEdgeHover = useCallback((id) => { clearTimeout(edgeLeaveTimer.current); setHoveredEdge(id); }, []);
  const leaveEdgeHover = useCallback(() => { clearTimeout(edgeLeaveTimer.current); edgeLeaveTimer.current = setTimeout(() => setHoveredEdge(null), 140); }, []);
  const openWork = useCallback(async (work) => { if (!work.session) return toast("К этой работе не привязана сессия агента.", true); try { const response = await api("/api/sessions/open", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ workId: work.id, canvasRevision: snapshot.revision }) }); const result = await response.json(); if (!response.ok) throw new Error(result.error); if (result.outcome === "resume") { await navigator.clipboard.writeText(result.command).catch(() => {}); toast(`${result.label}: команда resume скопирована — ${result.command}`); } else toast(result.outcome === "surface-opened" ? "Открыта рабочая поверхность агента." : `${result.label}: открываю рабочую сессию.`); } catch (error) { toast(error.message, true); } }, [snapshot.revision, toast]);

  const projectedNodes = useMemo(() => {
    if (!layout) return null;
    const distant = activityTier === "area";
    const output = snapshot.areas.map((area) => { const rect = layoutAreas.get(area.id); const id = `area:${area.id}`; const manual = manualPositions.current.get(id); return rect && { id, type: "area", className: "area-shell", dragHandle: ".graph-item-body", position: manual || { x: rect.x, y: rect.y }, width: rect.width, height: rect.height, draggable: true, selectable: false, zIndex: 0, style: { width: rect.width, height: rect.height }, data: { area, title: area.ownerTitle || area.title, description: area.ownerNote || area.note || "Смысловая граница ответственности", color: rect.color, distant, activeCount: distant ? activity.areas.get(area.id) || 0 : 0, labelScale: 1, muted: selectedArea !== "all" && selectedArea !== area.id, edit: openEdit } }; }).filter(Boolean);
    for (const entity of snapshot.entities) { const rect = detailPositions.get(entity.id); if (!rect) continue; const id = `entity:${entity.id}`; const manual = manualPositions.current.get(id); const person = entity.kind === "person"; const relatedAreas = connectedAreas.get(entity.id) || new Set(); const color = person ? colors.get([...relatedAreas][0]) || "#d88961" : colors.get(entity.areaId); output.push({ id, type: person ? "person" : rect.group ? "group" : "entity", className: rect.group ? "group-shell" : undefined, dragHandle: ".graph-item-body", position: manual || { x: rect.x, y: rect.y }, width: rect.width, height: rect.height, draggable: true, selectable: true, zIndex: person ? 12 : rect.group ? 2 + (rect.depth || 0) : 5 + (rect.depth || 0), style: { width: rect.width, height: rect.height }, data: { entity, label: entity.ownerLabel || entity.label, description: entity.ownerPurpose || entity.purpose || entity.path || (person ? "Внешний участник продукта" : "Подтверждённый элемент проекта"), color, status: entity.status, activeCount: person ? 0 : activityTier === "entity" ? activity.entities.get(entity.id) || 0 : 0, muted: selectedArea !== "all" && (person ? !relatedAreas.has(selectedArea) : selectedArea !== entity.areaId), edit: openEdit, select: setSelectedEntity } }); }
    for (const work of liveWork) { const rect = workPositions.get(work.id); if (!rect) continue; const id = `work:${work.id}`; const manual = manualPositions.current.get(id); const first = entityMap.get(work.targets?.[0]); output.push({ id, type: "work", dragHandle: ".graph-item-body", position: manual || { x: rect.x, y: rect.y }, width: rect.width, height: rect.height, draggable: true, selectable: false, zIndex: 20, style: { width: rect.width, height: rect.height }, data: { work, visible: activityTier === "work", color: colors.get(first?.areaId), open: openWork } }); }
    return fitGroupContours(output, hierarchy);
  }, [layout, snapshot, liveWork, activityTier, layoutAreas, detailPositions, workPositions, activity, hierarchy, selectedArea, entityMap, connectedAreas, colors, openEdit, openWork]);

  useEffect(() => { if (projectedNodes) setNodes(projectedNodes); }, [projectedNodes]);
  useEffect(() => {
    if (!nodes.length || fittedOnce.current) return;
    fittedOnce.current = true;
    const timer = setTimeout(() => flow.fitView({ padding: .1, maxZoom: 1.05, duration: 0 }), 0);
    return () => clearTimeout(timer);
  }, [nodes.length, flow]);

  const routes = activityTier === "area" ? areaRoutes : detailedRoutes;
  const baseRects = useMemo(() => new Map([...(layout?.areas || []).map((item) => [`area:${item.id}`, item]), ...(layout?.entities || []).map((item) => [`entity:${item.id}`, item]), ...(layout?.work || []).map((item) => [`work:${item.id}`, item])]), [layout]);
  const currentRects = useMemo(() => new Map(nodes.map((node) => [node.id, { x: node.position.x, y: node.position.y, width: Number(node.style?.width || 0), height: Number(node.style?.height || 0) }])), [nodes]);
  const liveRoutes = useMemo(() => routes.map((route) => followMovedNodes(route, baseRects, currentRects)), [routes, baseRects, currentRects]);
  const obstacles = useMemo(() => nodes.filter((node) => !node.hidden && (node.type !== "work" || activityTier === "work")).map((node) => node.type === "area"
    ? { x: node.position.x + 18, y: node.position.y + 14, width: Math.min(560, Number(node.style?.width || 0) - 36), height: 82 }
    : node.type === "group" ? { x: node.position.x + 13, y: node.position.y + 13, width: Math.min(360, Number(node.style?.width || 0) - 26), height: 72 }
      : { x: node.position.x, y: node.position.y, width: Number(node.style?.width || 0), height: Number(node.style?.height || 0) }), [nodes, activityTier]);
  const placements = useMemo(() => placeLabels(liveRoutes, viewport, size, obstacles), [liveRoutes, viewport, size, obstacles]);
  const edges = useMemo(() => liveRoutes.map((route) => ({ id: route.id, source: route.source, target: route.target, type: "routed", interactionWidth: 32, zIndex: route.type === "work" ? 8 : route.type === "area-relation" ? 4 : 0, markerEnd: ["relation", "area-relation"].includes(route.type) ? { type: MarkerType.ArrowClosed, color: route.color, width: 13, height: 13 } : undefined, data: { route, placement: placements.get(route.id), persistentLabel: Boolean(route.label), hidden: route.type === "work" && activityTier !== "work", hovered: hoveredEdge === route.id, opacity: activityTier === "area" ? .82 : activityTier === "entity" ? .68 : .86, muted: selectedArea !== "all" && route.sourceAreaId !== selectedArea && route.targetAreaId !== selectedArea, edit: openEdit, openBundle: openRelationBundle, keepHover: keepEdgeHover, leaveHover: leaveEdgeHover } })), [liveRoutes, placements, activityTier, selectedArea, hoveredEdge, openEdit, openRelationBundle, keepEdgeHover, leaveEdgeHover]);

  const onViewportChange = useCallback((next) => { pendingViewport.current = next; if (viewportFrame.current !== null) return; viewportFrame.current = requestAnimationFrame(() => { viewportFrame.current = null; setViewport(pendingViewport.current); }); }, []);
  const settleViewport = useCallback((event, next) => {
    const step = next.zoom < .15 ? .005 : next.zoom < .4 ? .01 : .025;
    const zoom = Math.max(.025, Math.min(1.7, Math.round(next.zoom / step) * step));
    const rect = wrapper.current?.getBoundingClientRect(); const anchor = rect && Number.isFinite(event?.clientX) ? { x: event.clientX - rect.left, y: event.clientY - rect.top } : { x: size.width / 2, y: size.height / 2 };
    const world = { x: (anchor.x - next.x) / next.zoom, y: (anchor.y - next.y) / next.zoom }; const pixelRatio = devicePixelRatio || 1;
    const settled = { x: Math.round((anchor.x - world.x * zoom) * pixelRatio) / pixelRatio, y: Math.round((anchor.y - world.y * zoom) * pixelRatio) / pixelRatio, zoom };
    const changed = Math.abs(settled.x - next.x) > .01 || Math.abs(settled.y - next.y) > .01 || Math.abs(settled.zoom - next.zoom) > .0001;
    onViewportChange(settled); if (changed) flow.setViewport(settled, { duration: 0 });
  }, [flow, onViewportChange, size]);
  const onNodesChange = useCallback((changes) => setNodes((current) => applyNodeChanges(changes, current)), []);
  const onNodeDragStart = useCallback((_, node) => { const affected = graphItemMoveIds(displaySnapshot, node.id, now); const positions = new Map(nodes.filter((item) => affected.has(item.id)).map((item) => [item.id, { ...item.position }])); for (const [id, position] of positions) manualPositions.current.set(id, position); drag.current = { id: node.id, start: { ...node.position }, positions }; }, [displaySnapshot, now, nodes]);
  const onNodeDrag = useCallback((_, node) => { const context = drag.current; if (!context || context.id !== node.id) return; const dx = node.position.x - context.start.x; const dy = node.position.y - context.start.y; const moves = [...context.positions].map(([id, initial]) => ({ id, x: initial.x + dx, y: initial.y + dy })); for (const move of moves) manualPositions.current.set(move.id, { x: move.x, y: move.y }); setNodes((current) => fitGroupContours(current.map((item) => { const initial = context.positions.get(item.id); return initial ? { ...item, position: { x: initial.x + dx, y: initial.y + dy } } : item; }), hierarchy)); routeDrag(moves); }, [hierarchy, routeDrag]);
  const onNodeDragStop = useCallback(async (_, node) => {
    const context = drag.current; drag.current = null;
    if (!context || !node.id.match(/^(area|entity|work):/)) return;
    const kind = node.id.split(":", 1)[0];
    const dx = node.position.x - context.start.x; const dy = node.position.y - context.start.y;
    if (Math.abs(dx) < .01 && Math.abs(dy) < .01) return;
    const finalMoves = [...context.positions].map(([id, initial]) => ({ id, x: initial.x + dx, y: initial.y + dy }));
    for (const move of finalMoves) manualPositions.current.set(move.id, { x: move.x, y: move.y });
    routeDrag(finalMoves, true);
    const before = [...context.positions].map(([nodeId, initial]) => ({ kind: nodeId.split(":", 1)[0], id: nodeId.replace(/^[^:]+:/, ""), x: initial.x, y: initial.y }));
    const items = [...context.positions].map(([nodeId, initial]) => ({ kind: nodeId.split(":", 1)[0], id: nodeId.replace(/^[^:]+:/, ""), x: initial.x + dx, y: initial.y + dy }));
    try {
      await enqueueMutation(() => persistLayout(items));
      remember({ type: "layout", label: kind === "area" ? "перемещение области" : kind === "work" ? "перемещение работы" : "перемещение элемента", before, after: items });
      toast(kind === "area" ? "Область и всё содержимое перемещены" : kind === "work" ? "Работа перемещена" : "Элемент и его вложенная структура перемещены");
    } catch (error) {
      for (const [id, position] of context.positions) manualPositions.current.set(id, position);
      setNodes((current) => fitGroupContours(current.map((item) => context.positions.has(item.id) ? { ...item, position: context.positions.get(item.id) } : item), hierarchy));
      toast(error.message, true);
    }
  }, [enqueueMutation, hierarchy, persistLayout, remember, routeDrag, toast]);

  const runHistory = useCallback(async (direction) => {
    if (historyBusy.current) return;
    const from = direction === "undo" ? history.current.past : history.current.future; const to = direction === "undo" ? history.current.future : history.current.past; const entry = from.at(-1);
    if (!entry) return;
    historyBusy.current = true;
    try {
      const values = direction === "undo" ? entry.before : entry.after;
      await enqueueMutation(async () => {
        if (entry.type === "layout") return persistLayout(values);
        const path = "/api/rename";
        const body = { canvasRevision: revisionRef.current, kind: entry.kind, id: entry.id, values };
        const response = await api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); const result = await response.json(); if (!response.ok) throw new Error(result.error); revisionRef.current = result.revision;
      });
      if (entry.type === "layout") {
        for (const value of values) manualPositions.current.set(`${value.kind}:${value.id}`, { x: value.x, y: value.y });
        setNodes((current) => fitGroupContours(current.map((node) => { const value = values.find((item) => `${item.kind}:${item.id}` === node.id); return value ? { ...node, position: { x: value.x, y: value.y } } : node; }), hierarchy));
      }
      from.pop(); to.push(entry); syncHistory(); if (entry.type !== "layout") await refreshSnapshot(); toast(`${direction === "undo" ? "Отменено" : "Повторено"}: ${entry.label}`);
    } catch (error) { toast(error.message, true); }
    finally { historyBusy.current = false; }
  }, [enqueueMutation, hierarchy, persistLayout, refreshSnapshot, syncHistory, toast]);

  const fitAll = useCallback(() => { setSelectedArea("all"); requestAnimationFrame(() => flow.fitView({ padding: .1, duration: 450, maxZoom: 1.05 })); }, [flow]);
  const focusArea = useCallback((id) => { setSelectedArea(id); const ids = [`area:${id}`, ...snapshot.entities.filter((item) => item.areaId === id || item.kind === "person" && connectedAreas.get(item.id)?.has(id)).map((item) => `entity:${item.id}`)]; requestAnimationFrame(() => flow.fitView({ nodes: nodes.filter((node) => ids.includes(node.id)), padding: .13, duration: 450, maxZoom: 1.1 })); }, [flow, snapshot.entities, connectedAreas, nodes]);
  const focusPerson = useCallback((person) => {
    setSelectedEntity(person);
    const related = new Set([person.id]);
    for (const relation of snapshot.relations) {
      if (relation.from === person.id) related.add(relation.to);
      if (relation.to === person.id) related.add(relation.from);
    }
    requestAnimationFrame(() => flow.fitView({ nodes: nodes.filter((node) => related.has(node.id.replace(/^entity:/, ""))), padding: .3, duration: 450, maxZoom: 1.1 }));
  }, [flow, snapshot.relations, nodes]);

  async function saveEdit(event) { event.preventDefault(); const title = edit.title.trim(); const description = edit.description.trim(); if (!title) return; const values = { title, ...(edit.kind === "relation" ? {} : { description }) }; const before = { title: edit.original.title, ...(edit.kind === "relation" ? {} : { description: edit.original.description }) }; try { await enqueueMutation(async () => { const response = await api("/api/rename", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ canvasRevision: revisionRef.current, kind: edit.kind, id: edit.id, values }) }); const result = await response.json(); if (!response.ok) throw new Error(result.error); revisionRef.current = result.revision; }); remember({ type: "rename", label: edit.kind === "relation" ? "изменение подписи связи" : "переименование", kind: edit.kind, id: edit.id, before, after: values }); setEdit(null); toast(edit.kind === "relation" ? "Подпись связи сохранена" : "Название и описание сохранены"); } catch (error) { toast(error.message, true); } }
  async function runRegenerate() { try { manualPositions.current.clear(); const response = await api("/api/architect/refresh", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ viewpoint }) }); const result = await response.json(); if (!response.ok) throw new Error(result.error); setArchitect(result); setDismissedArchitect(null); setRegenerate(false); toast(result.started ? "Повторная генерация запущена" : "Architect уже работает"); } catch (error) { toast(error.message, true); } }

  useEffect(() => { const handler = (event) => { const modifier = event.ctrlKey || event.metaKey; if (!modifier || /^(INPUT|TEXTAREA|SELECT)$/.test(event.target?.tagName) || event.target?.isContentEditable) return; const undo = event.key.toLowerCase() === "z" && !event.shiftKey; const redo = event.key.toLowerCase() === "y" || event.key.toLowerCase() === "z" && event.shiftKey; if (!undo && !redo) return; event.preventDefault(); runHistory(undo ? "undo" : "redo"); }; addEventListener("keydown", handler); return () => removeEventListener("keydown", handler); }, [runHistory]);

  const people = snapshot.entities.filter((entity) => entity.kind === "person");
  const tree = snapshot.areas.map((area) => ({ area, entities: snapshot.entities.filter((entity) => entity.areaId === area.id && (!entity.parentId || !entityMap.has(entity.parentId))) }));
  const architectKey = architect?.finishedAt || architect?.startedAt;
  const showArchitect = architect && architect.status !== "idle" && architectKey !== dismissedArchitect;
  const architectConnected = architect?.heartbeatAt && Date.now() - Date.parse(architect.heartbeatAt) < 20_000;
  const architectMessage = architect?.status === "failed" ? `${architect.error}${architect.result?.calls ? ` · вызовов: ${architect.result.calls}` : ""}${architect.result?.usage?.totalTokens ? ` · токенов: ${architect.result.usage.totalTokens.toLocaleString("ru-RU")}` : ""}` : architect?.status === "done"
    ? `${architect.result?.areas || 0} областей · ${architect.result?.entities || 0} элементов · ${architect.result?.relations || 0} связей${architect.result?.semanticReviews ? ` · проверок понятности: ${architect.result.semanticReviews}` : ""}${architect.result?.acceptanceRepairs ? ` · доработок: ${architect.result.acceptanceRepairs}` : ""}${architect.result?.repairs ? ` · исправлений: ${architect.result.repairs}` : ""}${architect.result?.usage?.totalTokens ? ` · токенов: ${architect.result.usage.totalTokens.toLocaleString("ru-RU")}` : ""}`
    : architect?.attempt > 0 ? `Проверка нашла несогласованность — корректирующая попытка ${architect.attempt}` : architectConnected ? "Агент на связи, Canvas получает heartbeat" : "Модель думает; сервер продолжает следить за процессом";
  return <div className="app-shell">
    <header className="topbar"><div className="brand"><i></i><i></i><i></i><span><strong>Repo Canvas</strong><small>{snapshot.map?.projectTitle || "живая карта проекта"}</small></span></div><div className="telemetry"><span><small>ОБЛАСТИ</small><strong>{snapshot.areas.length}</strong></span><span><small>ЭЛЕМЕНТЫ</small><strong>{snapshot.entities.length}</strong></span><span className="hot"><small>В РАБОТЕ</small><strong>{liveWork.length}</strong></span><span className="connection"><i></i><b>{unauthorized ? "нет доступа" : "онлайн"}</b></span></div></header>
    <main className="workspace"><aside className="left-rail">
      <section className="rail-section project-section"><header><b>ПРОЕКТ</b><span>{snapshot.entities.length}</span></header><button className={`project-all ${selectedArea === "all" ? "is-active" : ""}`} onClick={fitAll}><i>∞</i><span><strong>Вся система</strong><small>общая карта</small></span></button>{people.length > 0 && <div className="people-tree"><small>УЧАСТНИКИ</small>{people.map((person) => <button key={person.id} onClick={() => focusPerson(person)}><i></i><span>{person.ownerLabel || person.label}</span></button>)}</div>}<div className="project-tree">{tree.map(({ area, entities }) => <section className="tree-area" key={area.id}><header><button className={selectedArea === area.id ? "is-active" : ""} onClick={() => focusArea(area.id)}><i style={{ background: colors.get(area.id) }}></i><span><strong>{area.ownerTitle || area.title}</strong><small>{snapshot.entities.filter((item) => item.areaId === area.id).length} элементов</small></span></button><button className="tree-toggle" onClick={() => setCollapsed((current) => { const next = new Set(current); if (next.has(area.id)) next.delete(area.id); else next.add(area.id); return next; })}>{collapsed.has(area.id) ? "›" : "⌄"}</button></header>{!collapsed.has(area.id) && <div>{entities.map((entity) => <button key={entity.id} onClick={() => setSelectedEntity(entity)}><i className={entity.status}></i>{entity.ownerLabel || entity.label}</button>)}</div>}</section>)}</div></section>
      {selectedEntity && <section className="passport"><button onClick={() => setSelectedEntity(null)}>×</button><small>{nodeKinds[selectedEntity.kind] || "ЭЛЕМЕНТ"}</small><h2>{selectedEntity.ownerLabel || selectedEntity.label}</h2><p>{selectedEntity.ownerPurpose || selectedEntity.purpose}</p><dl><div><dt>Область</dt><dd>{selectedEntity.kind === "person" ? "Внешний участник" : areaMap.get(selectedEntity.areaId)?.ownerTitle || areaMap.get(selectedEntity.areaId)?.title}</dd></div><div><dt>Основание</dt><dd>{(selectedEntity.evidence || [selectedEntity.path]).filter(Boolean).join(" · ") || "свидетельство не записано"}</dd></div><div><dt>Статус</dt><dd>{selectedEntity.status}</dd></div></dl></section>}
      <section className="rail-section now-section"><header><b>СЕЙЧАС</b><span>{liveWork.length}</span></header><div className="now-list">{liveWork.length ? liveWork.map((work) => <button key={work.id} onDoubleClick={() => openWork(work)}><i className={work.status}></i><span><strong>{work.title}</strong><small>{work.actor || "agent"}</small></span></button>) : <p className="now-empty">Подтверждённой активной работы нет</p>}</div></section>
      <section className="rail-section latest-section"><header><b>ПОСЛЕДНЕЕ</b><span>{relativeTime(snapshot.updatedAt)}</span></header><div className="activity-list">{snapshot.activity.slice(0, 8).map((item) => <article key={item.id} className={item.level}><i></i><span><small>{relativeTime(item.ts)} · {item.actor}</small><p>{item.message}</p></span></article>)}</div></section>
    </aside><section className="canvas-shell"><header className="canvas-header"><span><small>{activityTier === "area" ? "АКТИВНЫЕ ОБЛАСТИ" : activityTier === "entity" ? "АКТИВНЫЕ БЛОКИ" : "ТЕКУЩИЕ ПРОЦЕССЫ"}</small><h1>{selectedArea === "all" ? "Весь проект" : areaMap.get(selectedArea)?.ownerTitle || areaMap.get(selectedArea)?.title}</h1></span><nav><button className="refresh-action" title="Обновить данные" onClick={() => setSnapshot(null)}>↻</button><button className="history-action" title="Отменить · Ctrl+Z" disabled={!historyState.undo} onClick={() => runHistory("undo")}>↶</button><button className="history-action" title="Повторить · Ctrl+Y / Ctrl+Shift+Z" disabled={!historyState.redo} onClick={() => runHistory("redo")}>↷</button><button className={`regenerate-action ${architect?.running ? "is-running" : ""}`} disabled={architect?.running} onClick={() => setRegenerate(true)}>{architect?.running ? "Карта строится…" : "Повторная генерация карты"}</button><button className="theme-action" title={theme === "dark" ? "Светлая тема" : "Тёмная тема"} onClick={toggleTheme}>{theme === "dark" ? "☀" : "◐"}</button><i></i><button onClick={() => flow.zoomOut({ duration: 180 })}>−</button><button onClick={fitAll}>Показать всё</button><button onClick={() => flow.zoomIn({ duration: 180 })}>+</button><button className={legend ? "is-active" : ""} onClick={() => setLegend(!legend)}>Легенда</button></nav></header>
      {showArchitect && <section className={`architect-banner ${architect.status}`}><i></i><span><small>{architect.status === "running" ? `ARCHITECT · ${Math.max(1, Math.round((architect.elapsedMs || 0) / 1000))} СЕК` : architect.status === "done" ? "КАРТА ОБНОВЛЕНА" : "ГЕНЕРАЦИЯ НЕ ПРИМЕНЕНА"}</small><strong>{architect.status === "running" ? ARCHITECT_PHASES[architect.phase] || "Строим карту проекта" : architect.status === "done" ? "Проверка пройдена" : "Architect остановлен валидатором"}</strong><p>{architectMessage}</p></span>{architect.status === "failed" && <button onClick={() => { setDismissedArchitect(architectKey); setRegenerate(true); }}>Повторить</button>}{architect.status !== "running" && <button className="architect-dismiss" title="Скрыть" onClick={() => setDismissedArchitect(architectKey)}>×</button>}</section>}
      <div className={`canvas-wrap tier-${activityTier}`} ref={wrapper}><ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} onNodesChange={onNodesChange} onNodeDragStart={onNodeDragStart} onNodeDrag={onNodeDrag} onNodeDragStop={onNodeDragStop} onEdgeMouseEnter={(_, edge) => keepEdgeHover(edge.id)} onEdgeMouseLeave={leaveEdgeHover} onEdgeDoubleClick={(event, edge) => { event.stopPropagation(); if (edge.data?.route?.relationId) openEdit("relation", edge.data.route.relationId, edge.data.route.label, ""); }} onMoveEnd={settleViewport} onPaneClick={() => { setSelectedEntity(null); setRelationBundle(null); }} minZoom={.025} maxZoom={1.7} defaultViewport={{ x: 0, y: 0, zoom: .1 }} onlyRenderVisibleElements={false} panOnDrag selectionOnDrag={false} nodeDragThreshold={0} nodesConnectable={false} edgesReconnectable={false} elevateNodesOnSelect={false} proOptions={{ hideAttribution: true }}><Background variant="dots" gap={28} size={1} color={theme === "dark" ? "#3a332f" : "#eadccf"} /></ReactFlow>{legend && <aside className="legend"><header><span><small>ЛЕГЕНДА</small><strong>Как читать карту</strong></span><button onClick={() => setLegend(false)}>×</button></header><div><p><i className="legend-person"></i><span><b>Круглый участник</b><small>человек вне системы; связь показывает, что он вводит, делает или получает</small></span></p><p><i className="legend-area"></i><span><b>Цветная территория</b><small>крупная ответственность проекта; тянется только за заголовок</small></span></p><p><i className="legend-group"></i><span><b>Прозрачный контур</b><small>подсистема вокруг своих элементов; пустое место двигает камеру</small></span></p><p><i className="legend-line"></i><span><b>Сплошная связь</b><small>действие или поток между конкретными элементами</small></span></p><p><i className="legend-dash"></i><span><b>Цветной пунктир</b><small>подтверждённая свежим сигналом работа агента</small></span></p><p><i className="legend-pulse"></i><span><b>Пульс следует за масштабом</b><small>сначала область, затем блок, затем процесс агента</small></span></p></div></aside>}{relationBundle && <aside className="relation-popover nodrag nopan" style={{ left: relationBundle.x, top: relationBundle.y, width: relationBundle.width, "--edge-color": relationBundle.route.color }}><header><span><small>СВЯЗИ В ЭТОЙ ЛИНИИ</small><strong>{relationBundle.route.relations.length} связей</strong></span><button type="button" onClick={() => setRelationBundle(null)}>×</button></header><ol>{relationBundle.route.relations.map((relation) => <li key={relation.id}><strong>{relation.ownerLabel || relation.label || "Связь без подписи"}</strong><small>{entityMap.get(relation.from)?.ownerLabel || entityMap.get(relation.from)?.label || relation.from} <b>→</b> {entityMap.get(relation.to)?.ownerLabel || entityMap.get(relation.to)?.label || relation.to}</small></li>)}</ol></aside>}<span className="canvas-hint">фон — камера · заголовок или карточка — перемещение · двойной клик — изменить · Ctrl+Z / Ctrl+Y — история</span></div>
    </section></main>
    {edit && <div className="modal-backdrop"><form className="modal" onSubmit={saveEdit}><small>РУЧНАЯ РЕДАКЦИЯ</small><h2>{edit.kind === "relation" ? "Подпись связи" : "Название и описание"}</h2><label><span>{edit.kind === "relation" ? "Что делает эта связь" : "Название"}</span><input autoFocus maxLength="240" value={edit.title} onChange={(event) => setEdit({ ...edit, title: event.target.value })} /></label>{edit.kind !== "relation" && <label><span>Описание</span><textarea rows="4" maxLength="2000" value={edit.description} onChange={(event) => setEdit({ ...edit, description: event.target.value })} /></label>}<div><button type="button" onClick={() => setEdit(null)}>Отмена</button><button className="primary">Сохранить</button></div></form></div>}
    {regenerate && <div className="modal-backdrop"><section className="modal"><small>АРХИТЕКТОР ПРОЕКТА</small><h2>Повторная генерация карты</h2><p>Можно оставить поле пустым — Architect сам выберет композицию по устройству проекта.</p><label><span>Как вы хотите смотреть на проект?</span><textarea rows="4" value={viewpoint} onChange={(event) => setViewpoint(event.target.value)} placeholder="Например: поставь ядро в центр и покажи окружающие модули" /></label><div><button onClick={() => setRegenerate(false)}>Отмена</button><button className="primary" onClick={runRegenerate}>Начать генерацию</button></div></section></div>}
  </div>;
}

function App() {
  const [snapshot, setSnapshot] = useState(null); const [unauthorized, setUnauthorized] = useState(false); const [toastState, setToast] = useState(null); const [update, setUpdate] = useState(null); const [architect, setArchitect] = useState(null); const [theme, setTheme] = useState(() => localStorage.getItem(THEME_KEY) || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")); const toastTimer = useRef(null); const previousArchitect = useRef(null); const updateStatus = useRef(null);
  const toast = useCallback((message, error = false) => { clearTimeout(toastTimer.current); setToast({ message, error }); toastTimer.current = setTimeout(() => setToast(null), 3600); }, []);
  useEffect(() => { document.documentElement.dataset.theme = theme; localStorage.setItem(THEME_KEY, theme); }, [theme]);
  useEffect(() => {
    if (unauthorized) return undefined;
    let stopped = false; let timer;
    async function poll(force = false) { try { if (!force && snapshot) { const revision = await api(`/api/revision?t=${Date.now()}`); if (revision.status === 401) throw Object.assign(new Error("unauthorized"), { unauthorized: true }); if (revision.ok && (await revision.json()).revision === snapshot.revision) return; } const response = await api(`/api/state?t=${Date.now()}`); if (response.status === 401) throw Object.assign(new Error("unauthorized"), { unauthorized: true }); if (!response.ok) throw new Error(`HTTP ${response.status}`); const next = await response.json(); if (!stopped) { setUnauthorized(false); setSnapshot(next); } } catch (error) { if (!stopped && error.unauthorized) setUnauthorized(true); } finally { if (!stopped) timer = setTimeout(() => poll(false), 350); } }
    poll(true); return () => { stopped = true; clearTimeout(timer); };
  }, [snapshot?.revision, unauthorized]);
  useEffect(() => { const handler = (event) => { if (event.key === TOKEN_KEY && event.newValue) { apiToken = event.newValue; setUnauthorized(false); setSnapshot(null); } }; addEventListener("storage", handler); return () => removeEventListener("storage", handler); }, []);
  useEffect(() => { let stopped = false; let timer; async function check(force = false) { let next = null; try { const response = await api(`/api/update/status?${force ? "refresh=1&" : ""}t=${Date.now()}`); if (response.ok) next = await response.json(); } catch { /* the server is expected to disappear briefly while updating */ } if (stopped) return; const previous = updateStatus.current; if (next) { updateStatus.current = next.status; setUpdate(next); if (updateFinished(previous, next.status)) { location.reload(); return; } if (next.status === "updated") { const noticeKey = `repo-canvas.updated.${next.currentVersion}`; if (sessionStorage.getItem(noticeKey) !== "1") { sessionStorage.setItem(noticeKey, "1"); toast(`Repo Canvas обновлён до v${next.currentVersion}.`); } } } timer = setTimeout(() => check(false), updatePollDelay(next?.status || updateStatus.current)); } check(update == null); return () => { stopped = true; clearTimeout(timer); }; }, [update?.status, toast]);
  useEffect(() => { let stopped = false; let timer; async function check() { let next = null; try { const response = await api(`/api/architect/status?t=${Date.now()}`); if (response.ok) next = await response.json(); } catch {} if (!stopped && next) { const previous = previousArchitect.current; setArchitect(next); previousArchitect.current = next; if (previous?.running && !next.running) { if (next.status === "done") { const stateResponse = await api(`/api/state?t=${Date.now()}`); if (stateResponse.ok && !stopped) setSnapshot(await stateResponse.json()); toast("Карта проекта обновлена и прошла проверку."); } else if (next.status === "failed") toast(`Architect: ${next.error}`, true); } } if (!stopped) timer = setTimeout(check, next?.running ? 1000 : 5000); } check(); return () => { stopped = true; clearTimeout(timer); }; }, [toast]);
  async function applyUpdate() { try { const response = await api("/api/update/apply", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }); const state = await response.json(); if (!response.ok) throw new Error(state.error); updateStatus.current = state.status; setUpdate(state); toast("Обновление устанавливается. Canvas перезапустится сам."); } catch (error) { toast(error.message, true); } }
  if (unauthorized) return <main className="access-state"><small>НУЖНА СВЯЗЬ С ЛОКАЛЬНЫМ CANVAS</small><h1>Эта вкладка потеряла доступ</h1><p>Обновите страницу, чтобы восстановить локальную сессию.</p><button onClick={() => location.reload()}>Обновить страницу</button></main>;
  if (!snapshot) return <main className="loading"><i></i><h1>Строим карту проекта</h1><p>Раскладываем области, элементы и свободные коридоры.</p></main>;
  return <ReactFlowProvider><Canvas snapshot={snapshot} setSnapshot={setSnapshot} toast={toast} unauthorized={unauthorized} theme={theme} toggleTheme={() => setTheme((current) => current === "dark" ? "light" : "dark")} architect={architect} setArchitect={setArchitect} />{update && ["available", "failed", "applying"].includes(update.status) && <button className="update-button" onClick={applyUpdate} disabled={update.status === "applying"}><small>ДОСТУПНО ОБНОВЛЕНИЕ</small><strong>{update.status === "applying" ? "Устанавливается…" : `Update v${update.availableVersion || ""}`}</strong></button>}{toastState && <div className={`toast ${toastState.error ? "error" : ""}`}>{toastState.message}</div>}</ReactFlowProvider>;
}

createRoot(document.getElementById("root")).render(<App />);
