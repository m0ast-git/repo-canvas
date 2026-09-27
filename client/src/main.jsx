import {statuses} from "./project-context.jsx";
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ReactFlow, ReactFlowProvider,
  applyNodeChanges, getViewportForBounds, useReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { settleCanvasDrop, originalContainerIds, canvasDropTarget } from "./drag-settlement.js";
import { layoutExpectation } from "./canvas-snapshot.js";
import { patchSnapshotPositions } from "./canvas-snapshot.js";
import {
  absoluteGroupContour, compactAreaMembership, compactContainerMembership, fitGroupContours,
  hierarchyWithLayoutItems, packAreaGrid, LAYOUT_VERSION, AREA_HEADER_HEIGHT,
} from "./container-layout.js";
import {
  boundingRect, dropObstacle, groupContourRect,
  followRouteDuringDrag, intersectionArea, magneticTranslation, nearestFreeTranslation,
  nodeRect, translateRect,
} from "./drag-geometry.js";
import { currentWork, graphHierarchy, graphItemMoveIds, activeWorkRollup, areaImplementationStatuses } from "./graph-contract.js";
import { layoutFingerprint } from "./layout-fingerprint.js";
import { ROUTING_VERSION } from "./routing-registry.js";
import { useCanvasLayout } from "./use-canvas-layout.js";
import {
  buildSearchItems, focusForSelection, offscreenChip, relationIds, routeMatchesFocus,
  routeSelection, searchCanvas, selectionKey, spreadOffscreenChips,
} from "./interaction-model.js";
import { placeRouteLabels } from "./route-label-layout.js";
import { persistentRouteLabel, routeVisualKind } from "./route-presentation.js";
import { QueryClientProvider } from "@tanstack/react-query";
import { createProjectQueryClient } from "./project-queries.js";
import { useProjectData } from "./use-project-data.js";
import { NODE_READABLE_ZOOM, settleViewportTransform } from "./viewport-geometry.js";
import "./styles.css";
import "./product.css";
import { ProjectTimeline, useProjectHistory } from "./project-history.jsx";
import {ModelSetup} from "./model-setup.jsx";
import { ProjectContext } from "./project-context.jsx";
import { activityText, jobMessage, jobStatistics } from "./job-message.js";
import { hoveredRouteAt } from "./route-hover.js";
import { Button, IconButton, StatusBadge, Dialog, TextField } from "./design-system/components.jsx";
import * as Icons from "./design-system/icons.jsx";
import { areaColor, assignAreaColors, routeColors, routeSourceArea, componentStatus } from "./design-system/project-theme.js";
import "./design-system/product-theme.css";
import { routeSceneKey, routeScene, presentSceneRoutes, isContainmentRoute } from "./route-scene.js";
import { mergeReciprocalRoutes } from "./reciprocal-routes.js";
import {nodeTypes,edgeTypes} from "./canvas-elements.jsx";
import { canvasDetail, detailSignature, workDetail } from "./canvas-detail.js";
import "./canvas-detail.css";
import {MapOverview,overviewRectangles} from "./map-overview.jsx";
import {ScenarioLens} from "./scenario-lens.jsx";
import "./review-improvements.css";
import {routeBudget} from "./route-budget.js";
import {ArchitectStatus} from "./architect-status.jsx";
import {WorkDetail} from "./work-detail.jsx";
import {useVisitChanges} from "./visit-changes.js";


const TOKEN_KEY = "repo-canvas.api-token";
const WORK_READABLE_ZOOM = .78;
const THEME_KEY = "repo-canvas.theme";
const nodeKinds = { capability: "ВОЗМОЖНОСТЬ", module: "МОДУЛЬ", service: "СЕРВИС", process: "ПРОЦЕСС", store: "ХРАНИЛИЩЕ", interface: "ИНТЕРФЕЙС", integration: "ИНТЕГРАЦИЯ", external: "ВНЕШНЯЯ СИСТЕМА", component: "КОМПОНЕНТ", person: "УЧАСТНИК" };

function readToken() {
  const hash = new URLSearchParams(location.hash.replace(/^#/, ""));
  const supplied = hash.get("token");
  if (supplied) { localStorage.setItem(TOKEN_KEY, supplied); history.replaceState(null, "", `${location.pathname}${location.search}`); return supplied; }
  return localStorage.getItem(TOKEN_KEY) || "";
}

let apiToken = readToken();
async function api(path, options = {}) {
  const timeout = AbortSignal.timeout(path.startsWith("/api/history") ? 15000 : 3000);
  try {
    return await fetch(path, { ...options, signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout, headers: { ...(options.headers || {}), "X-Repo-Canvas-Token": apiToken }, cache: options.cache || "no-store" });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new Error(timeout.aborted ? "Canvas не ответил вовремя. Повторите действие через несколько секунд." : "Нет связи с сервером Canvas. Сохранённая карта остаётся на экране; подключение восстановится автоматически.");
  }
}

function relativeTime(value,at=Date.now()) {
  if (!value) return "—"; const seconds = Math.max(0, Math.round((at - Date.parse(value)) / 1000));
  if (seconds < 5) return "сейчас"; if (seconds < 60) return `${seconds} сек`; if (seconds < 3600) return `${Math.floor(seconds / 60)} мин`; return `${Math.floor(seconds / 3600)} ч`;
}

function followMovedNodes(route, baseRects, currentRects) {
  const sourceBase = {...baseRects.get(route.source),...route.sourceBase}; const targetBase = {...baseRects.get(route.target),...route.targetBase};
  let sourceCurrent = currentRects.get(route.source); let targetCurrent = currentRects.get(route.target);
  return followRouteDuringDrag(route, sourceBase, targetBase, sourceCurrent, targetCurrent);
}

function useContainerSize(ref) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => { if (!ref.current) return; const observer = new ResizeObserver(([entry]) => setSize({ width: entry.contentRect.width, height: entry.contentRect.height })); observer.observe(ref.current); return () => observer.disconnect(); }, [ref]);
  return size;
}

function pointerPosition(flow, event, fallback) {
  if (!Number.isFinite(event?.clientX) || !Number.isFinite(event?.clientY)) return fallback;
  return flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }, { snapToGrid: false });
}

function dragVisualRect(node) {
  return node.type === "group" ? groupContourRect(node) : nodeRect(node);
}

function Canvas({ snapshot, setSnapshot, toast, unauthorized, connection, theme, toggleTheme, architect, setArchitect, timeline }) {
  const historical=Boolean(snapshot._history);
  const sinceVisit=useVisitChanges(snapshot,api);const visibleComparison=timeline.comparison||sinceVisit.comparison;
  const [contextOpen,setContextOpen]=useState(false);
  const [structureOpen,setStructureOpen]=useState(false);
  const [contextTab,setContextTab]=useState("overview");
  const [overviewTier,setOverviewTier]=useState(true);const [mobileArea,setMobileArea]=useState(0);const [activeScenario,setActiveScenario]=useState(null);const [scenarioStep,setScenarioStep]=useState(0);const [allConnections,setAllConnections]=useState(false);
  const [readingPreview,setReadingPreview]=useState(null);
  const readingTimer=useRef(null);const readingTarget=useRef(null);
  const clearReading=useCallback(()=>{clearTimeout(readingTimer.current);readingTarget.current=null;setReadingPreview(null);},[]);
  useEffect(()=>clearReading,[clearReading]);
  const capturedGeometry=useRef(new Set());
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 15_000); return () => clearInterval(timer); }, []);
  const liveWork = useMemo(() => currentWork(snapshot, historical?Date.parse(snapshot._history.at):now), [snapshot, now, historical]);
  const displaySnapshot = useMemo(() => ({ ...snapshot, work: liveWork, summary: { ...snapshot.summary, activeWork: liveWork.length } }), [snapshot, liveWork]);
  const { layout, settled, routes: detailedRoutes, prepareRoutes, presentation,arrange } = useCanvasLayout(displaySnapshot); const wrapper = useRef(null); const size = useContainerSize(wrapper); const flow = useReactFlow();
  const fittedOnce = useRef(false);
  const pendingCamera = useRef(null);
  const hoverFrame=useRef(null),hoverPointer=useRef(null),hoveredRouteRef=useRef(null);
  const cameraSize = useRef(null);
  // Geometry is already known. Avoid React Flow's deferred fitView queue overriding a newer navigation.
  const fitCamera = useCallback((options = {}) => {
    const targets = options.nodes || flow.getNodes();
    const frame = wrapper.current?.getBoundingClientRect();
    if (!targets.length || !frame?.width || !frame.height) return;
    cameraSize.current = {width:frame.width,height:frame.height};
    const rectangles = targets.map(nodeRect);
    const fit = (rects) => getViewportForBounds(boundingRect(rects), frame.width, frame.height, options.minZoom ?? .025, options.maxZoom ?? 1.7, options.padding ?? .1);
    let next = fit(rectangles);
    return flow.setViewport(next, { duration:options.duration ?? 0 });
  }, [flow]);
  const [viewport, setViewport] = useState({ x: 0, y: 0, zoom: .1 });
  const overview=overviewTier&&!activeScenario&&snapshot.areas.length>0;
  useEffect(()=>{if(viewport.zoom>.57)setOverviewTier(false);else if(viewport.zoom<.48)setOverviewTier(true);},[viewport.zoom]);
  const [selectedArea, setSelectedArea] = useState("all"); const [selection, setSelection] = useState(null); const [collapsed, setCollapsed] = useState(() => new Set(snapshot.areas.map((area) => area.id))); const [collapsedEntities, setCollapsedEntities] = useState(() => new Set(snapshot.entities.filter((entity) => snapshot.entities.some((child) => child.parentId === entity.id)).map((entity) => entity.id))); const [legend, setLegend] = useState(false); const [edit, setEdit] = useState(null); const [regenerate, setRegenerate] = useState(false); const [viewpoint, setViewpoint] = useState(""); const [dismissedArchitect, setDismissedArchitect] = useState(null); const [nodes, setNodes] = useState([]); const [interactionActive, setInteractionActive] = useState(false); const [searchOpen, setSearchOpen] = useState(false); const [searchQuery, setSearchQuery] = useState(""); const [dropPreview, setDropPreview] = useState(null); const [historyState, setHistoryState] = useState({ undo: 0, redo: 0 }); const drag = useRef(null); const manualPositions = useRef(new Map()); const manualAreaMinimums = useRef(new Map()); const edgeLeaveTimer = useRef(null); const resizeStart = useRef(new Map()); const dragPreviewFrame = useRef(null); const treeRowRefs = useRef(new Map()); const knownAreaIds = useRef(new Set(snapshot.areas.map((area) => area.id))); const searchInput = useRef(null); const revisionRef = useRef(snapshot.revision); const history = useRef({ past: [], future: [] }); const mutationQueue = useRef(Promise.resolve()); const historyBusy = useRef(false); const obstacleCache = useRef([]); const placementCache = useRef(new Map()); const edgeCache = useRef(new Map());
  const viewTrail=useRef([]);const [canGoBack,setCanGoBack]=useState(false);const viewContext=useRef(null);viewContext.current={selection,selectedArea,contextOpen,contextTab};
  const rememberView=()=>{viewTrail.current.push({...viewContext.current,viewport:flow.getViewport()});if(viewTrail.current.length>20)viewTrail.current.shift();setCanGoBack(true);};
  const previousView=()=>{const previous=viewTrail.current.pop();if(!previous)return;flow.setViewport(previous.viewport,{duration:200});setSelection(previous.selection);setSelectedArea(previous.selectedArea);setContextOpen(previous.contextOpen);setContextTab(previous.contextTab||"overview");setCanGoBack(viewTrail.current.length>0);};
  const activityTier = viewport.zoom < NODE_READABLE_ZOOM ? "area" : viewport.zoom < WORK_READABLE_ZOOM ? "entity" : "work";
  const detailKey = detailSignature(layout?.entities || [], viewport.zoom) + (layout?.work || []).map(rect=>workDetail(rect,viewport.zoom)).join("|");
  useEffect(() => {
    const previous = cameraSize.current;
    cameraSize.current = size;
    if (!previous?.width || !size.width || !size.height || pendingCamera.current) return;
    const current = flow.getViewport();
    if (previous.width !== size.width || previous.height !== size.height) flow.setViewport({...current,x:current.x+(size.width-previous.width)/2,y:current.y+(size.height-previous.height)/2},{duration:0});
  }, [size.width, size.height, flow]);
  const hierarchy = useMemo(() => graphHierarchy(snapshot).descendants, [snapshot.entities]);
  const activity = useMemo(() => activeWorkRollup(snapshot, historical ? Date.parse(snapshot._history.at) : now), [snapshot, historical, now]);
  const areaStatuses = useMemo(() => areaImplementationStatuses(snapshot), [snapshot.areas, snapshot.entities]);
  const areaMap = useMemo(() => new Map(snapshot.areas.map((area) => [area.id, area])), [snapshot]); const entityMap = useMemo(() => new Map(snapshot.entities.map((entity) => [entity.id, entity])), [snapshot]);
  const connectedAreas = useMemo(() => { const result = new Map(); for (const person of snapshot.entities.filter((entity) => entity.kind === "person")) { const areas = new Set(); for (const relation of snapshot.relations || []) { if (relation.from !== person.id && relation.to !== person.id) continue; const other = entityMap.get(relation.from === person.id ? relation.to : relation.from); if (other?.areaId) areas.add(other.areaId); } result.set(person.id, areas); } return result; }, [snapshot.entities, snapshot.relations, entityMap]);
  const layoutAreas = useMemo(() => new Map((layout?.areas || []).map((item) => [item.id, item])), [layout]); const detailPositions = useMemo(() => new Map((layout?.entities || []).map((item) => [item.id, item])), [layout]); const workPositions = useMemo(() => new Map((layout?.work || []).map((item) => [item.id, item])), [layout]);
  const overviewRects=useMemo(()=>overviewRectangles(layoutAreas,viewport.zoom||.33),[layoutAreas,viewport.zoom]);
  const fitOverview=useCallback((areaIndex=0)=>{const frame=wrapper.current?.getBoundingClientRect();if(!frame||!layoutAreas.size)return;let zoom=.4,next;for(let pass=0;pass<24;pass++){const boxes=overviewRectangles(layoutAreas,zoom);next=getViewportForBounds(boundingRect(frame.width<700?[...boxes.values()].slice(areaIndex,areaIndex+1):[...boxes.values()]),frame.width,frame.height,.025,.45,.07);if(Math.abs(next.zoom-zoom)<.00001)break;zoom=next.zoom;}setMobileArea(areaIndex);flow.setViewport(next,{duration:0});},[layoutAreas,flow]);
  const areaColorKey = "repo-canvas.area-colors:" + (snapshot.map?.id || snapshot.map?.projectTitle || location.host);
  const colorAssignments = useMemo(() => { let previous={};try{previous=JSON.parse(localStorage.getItem(areaColorKey)||"{}");}catch{}return assignAreaColors(snapshot.areas,previous); }, [snapshot.areas,areaColorKey]);
  useEffect(()=>{localStorage.setItem(areaColorKey,JSON.stringify(colorAssignments));},[colorAssignments,areaColorKey]);
  const colors = useMemo(() => new Map(snapshot.areas.map(item => [item.id, areaColor({...item,colorSlot:colorAssignments[item.id]}, theme)])), [snapshot.areas,theme,colorAssignments]);
  const pinnedFocus = useMemo(() => focusForSelection(selection, entityMap), [selection, entityMap]);
  const visibleFocus = pinnedFocus;
  const selectedEntity = selection?.kind === "entity" ? entityMap.get(selection.id) : null;
  useEffect(()=>{
    if(!contextOpen)return;
    const previous=document.activeElement;
    const frame=requestAnimationFrame(()=>document.querySelector('.context-panel button[aria-label="Закрыть контекст"]')?.focus());
    return()=>{cancelAnimationFrame(frame);if(previous?.isConnected)previous.focus();};
  },[contextOpen]);
  const selectedWork = selection?.kind === "work" ? liveWork.find((work) => work.id === selection.id) || selection.work : null;
  const selectedRoute = selection?.kind === "route" ? selection.route : null;
  const searchItems = useMemo(() => buildSearchItems(snapshot, liveWork), [snapshot, liveWork]);
  const searchResults = useMemo(() => searchCanvas(searchItems, searchQuery), [searchItems, searchQuery]);

  const revealEntityInTree = useCallback((entity) => {
    if (!entity) return;
    if (entity.areaId) setCollapsed((current) => { const next = new Set(current); next.delete(entity.areaId); return next; });
    const ancestors = []; let current = entity; const seen = new Set();
    while (current?.parentId && !seen.has(current.parentId)) { seen.add(current.parentId); ancestors.push(current.parentId); current = entityMap.get(current.parentId); }
    if (ancestors.length) setCollapsedEntities((value) => { const next = new Set(value); for (const id of ancestors) next.delete(id); return next; });
    requestAnimationFrame(() => requestAnimationFrame(() => treeRowRefs.current.get(entity.id)?.scrollIntoView({ block: "nearest" })));
  }, [entityMap]);
  const selectEntity = useCallback((entity) => { if (!entity) return; setContextOpen(window.innerWidth<800);setContextTab("object"); setSelection({ kind: "entity", id: entity.id }); revealEntityInTree(entity); }, [revealEntityInTree]);
  const selectArea = useCallback((area) => { if (!area) return; setContextOpen(window.innerWidth<800);setContextTab("object"); setSelection({ kind: "area", id: area.id }); setCollapsed((current) => { const next = new Set(current); next.delete(area.id); return next; }); }, []);
  const selectWork = useCallback((work) => { if (work) setSelection({ kind: "work", id: work.id, work }); }, []);
  const selectRoute = useCallback((route, relationId = "") => { if (route) {setContextOpen(window.innerWidth<800);setContextTab("object");setSelection(routeSelection(route, relationId));} }, []);

  useEffect(() => () => { clearTimeout(edgeLeaveTimer.current); cancelAnimationFrame(dragPreviewFrame.current); }, []);
  useEffect(() => { const incoming = new Set(snapshot.areas.map((area) => area.id)); const added = [...incoming].filter((id) => !knownAreaIds.current.has(id)); if (added.length || [...knownAreaIds.current].some((id) => !incoming.has(id))) setCollapsed((current) => { const next = new Set([...current].filter((id) => incoming.has(id))); for (const id of added) next.add(id); return next; }); knownAreaIds.current = incoming; }, [snapshot.areas]);

  useEffect(() => { revisionRef.current = snapshot.revision; }, [snapshot.revision]);
  const syncHistory = useCallback(() => setHistoryState({ undo: history.current.past.length, redo: history.current.future.length }), []);
  const remember = useCallback((entry) => { history.current.past.push(entry); if (history.current.past.length > 100) history.current.past.shift(); history.current.future = []; syncHistory(); }, [syncHistory]);
  const enqueueMutation = useCallback((task) => { const run = mutationQueue.current.then(task, task); mutationQueue.current = run.catch(() => {}); return run; }, []);
  const refreshSnapshot = useCallback(async () => { const response = await api(`/api/state?t=${Date.now()}`); if (response.ok) setSnapshot(await response.json()); }, [setSnapshot]);
  const persistLayout = useCallback(async (items, expected) => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await api("/api/layout", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ canvasRevision: revisionRef.current, items, expected }) });
      const result = await response.json();
      if (response.status === 409 && result.conflict) throw new Error(result.error);
      if (response.status === 409 && attempt < 2) {
        const latestResponse = await api(`/api/state?t=${Date.now()}`); if (!latestResponse.ok) throw new Error(result.error || `HTTP ${latestResponse.status}`);
        const latest = await latestResponse.json(); revisionRef.current = latest.revision; setSnapshot(latest); continue;
      }
      if (!response.ok) throw new Error(result.error);
      // Keep the dropped position visible until the worker has caught up.
      revisionRef.current = result.revision;
      const patches = new Map(items.map(item => [`${item.kind}:${item.id}`,item]));
      const visible = fitGroupContours(flow.getNodes().map(node=>{
        const patch=patches.get(node.id);return patch?{...node,position:{x:patch.x,y:patch.y},...(node.type==="area"?{width:patch.width??node.width,height:patch.height??node.height,style:{...node.style,width:patch.width??node.width,height:patch.height??node.height}}:{})}:node;
      }),hierarchyWithLayoutItems(displaySnapshot,items));
      const rects=new Map(visible.map(node=>[node.id,node]));
      setSnapshot(current=>{
        const next=result.state||patchSnapshotPositions(current,items,result.revision);
        const place=(values,kind)=>values.map(rect=>{const node=rects.get(`${kind}:${rect.id}`);if(!node)return rect;const contour=node.data?.contour;return {...rect,...nodeRect(node),...(contour?{width:contour.left+contour.width,height:contour.top+contour.height}:{}),x:node.position.x,y:node.position.y};});
        const seed={...layout,areas:place(layout.areas,"area"),entities:place(layout.entities,"entity"),work:place(layout.work||[],"work"),fingerprint:layoutFingerprint(next),routingVersion:3,layoutVersion:LAYOUT_VERSION,sourcePositions:Object.fromEntries([...next.areas,...next.entities,...next.work].map(item=>[item.id,[item.x??null,item.y??null]]))};
        const {_geometry,...rest}=next;return {...rest,_layoutSeed:seed};
      });
      return result;
    }
    throw new Error("Canvas changed repeatedly while saving the position");
  }, [setSnapshot,flow,layout,displaySnapshot]);
  const openEdit = useCallback((kind, id, title, description = "") => {if(!historical)setEdit({ kind, id, title, description, original: { title, description } });}, [historical]);
  const clearEdgeHover = useCallback(() => { cancelAnimationFrame(hoverFrame.current);hoverFrame.current=null; clearTimeout(edgeLeaveTimer.current); edgeLeaveTimer.current = null; hoveredRouteRef.current=null; }, []);
  const keepEdgeHover = useCallback((id) => { clearTimeout(edgeLeaveTimer.current); edgeLeaveTimer.current = null; if(hoveredRouteRef.current!==id){hoveredRouteRef.current=id;} }, []);
  const leaveEdgeHover = useCallback(() => { if (edgeLeaveTimer.current === null) edgeLeaveTimer.current = setTimeout(clearEdgeHover, 110); }, [clearEdgeHover]);
  const openWork = useCallback(async (work) => { if (!work.session) return toast("К этой работе не привязана сессия агента.", true); try { const response = await api("/api/sessions/open", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ workId: work.id, canvasRevision: snapshot.revision }) }); const result = await response.json(); if (!response.ok) throw new Error(result.error); if (result.outcome === "resume") { await navigator.clipboard.writeText(result.command).catch(() => {}); toast(`${result.label}: команда resume скопирована — ${result.command}`); } else toast(result.outcome === "surface-opened" ? "Открыта рабочая поверхность агента." : `${result.label}: открываю рабочую сессию.`); } catch (error) { toast(error.message, true); } }, [snapshot.revision, toast]);
  const onAreaResizeStart = useCallback((area, params) => {
    const node = flow.getNode(`area:${area.id}`); if (!node) return;
    const rect = nodeRect(node);
    resizeStart.current.set(area.id, {
      kind: "area", id: area.id,
      x: Number(params?.x ?? rect.x), y: Number(params?.y ?? rect.y),
      width: rect.width, height: rect.height,
      minWidth: Number(area.minWidth || 0), minHeight: Number(area.minHeight || 0),
    });
    setSelection({ kind: "area", id: area.id });
    clearEdgeHover();
    setInteractionActive(true);
  }, [clearEdgeHover, flow]);
  const onAreaResizeEnd = useCallback(async (area, params) => {
    const node = flow.getNode(`area:${area.id}`); const layoutRect = layoutAreas.get(area.id);
    if (!node || !layoutRect) { setInteractionActive(false); return; }
    const baseline = resizeStart.current.get(area.id) || {
      kind: "area", id: area.id, x: node.position.x, y: node.position.y,
      width: nodeRect(node).width, height: nodeRect(node).height,
      minWidth: Number(area.minWidth || 0), minHeight: Number(area.minHeight || 0),
    };
    resizeStart.current.delete(area.id);
    const width = Math.max(Number(layoutRect.contentWidth || 520), Number(params?.width || baseline.width));
    const height = Math.max(Number(layoutRect.contentHeight || 260), Number(params?.height || baseline.height));
    const after = { kind: "area", id: area.id, x: Number(params?.x ?? baseline.x), y: Number(params?.y ?? baseline.y), width, height, minWidth: width, minHeight: height };
    if (Math.abs(width - baseline.width) < .5 && Math.abs(height - baseline.height) < .5) { setInteractionActive(false); return; }
    manualAreaMinimums.current.set(area.id, { minWidth: width, minHeight: height });
    setNodes((current) => current.map((item) => item.id === `area:${area.id}` ? { ...item, width, height, style: { ...item.style, width, height } } : item));
    setInteractionActive(false);
    try {
      await enqueueMutation(() => persistLayout([after]));
      remember({ type: "layout", label: "изменение размера области", before: [baseline], after: [after] });
      toast("Размер области сохранён");
    } catch (error) {
      manualAreaMinimums.current.set(area.id, { minWidth: baseline.minWidth, minHeight: baseline.minHeight });
      setNodes((current) => current.map((item) => item.id === `area:${area.id}` ? { ...item, width: baseline.width, height: baseline.height, style: { ...item.style, width: baseline.width, height: baseline.height } } : item));
      toast(error.message, true);
    }
  }, [enqueueMutation, flow, layoutAreas, persistLayout, remember, toast]);

  const projectedNodes = useMemo(() => {
    if (!layout) return null;
    const distant = activityTier === "area";
    const pinnedEgo = selection?.kind === "route";
    const focusData = (id) => ({
      focused: visibleFocus.nodeIds.has(id) || selection?.kind !== "route" && selectionKey(selection) === id,
      focusDim: pinnedEgo && !pinnedFocus.nodeIds.has(id),
    });
    const output = snapshot.areas.map((area) => {
      const rect = layoutAreas.get(area.id); const id = `area:${area.id}`; const manual = manualPositions.current.get(id);
      if (!rect) return null;
      const minimum = manualAreaMinimums.current.get(area.id);
      const width = minimum ? Math.max(Number(rect.contentWidth || 520), Number(minimum.minWidth || 0)) : rect.width;
      const height = minimum ? Math.max(Number(rect.contentHeight || 260), Number(minimum.minHeight || 0)) : rect.height;
      return { id, type: "area", className: "area-shell", dragHandle: ".graph-item-body", position: manual || { x: rect.x, y: rect.y }, width, height, draggable: !historical, selectable: false, zIndex: 2, style: { width, height }, data: { readOnly: historical, pulsing: !historical, status: areaStatuses.get(area.id), area, title: area.ownerTitle || area.title, description: area.ownerNote || area.note || "Смысловая граница ответственности", color: colors.get(area.id), distant, activeCount: distant ? activity.areas.get(area.id) || 0 : 0, labelScale: 1, areaWidth: width, contentWidth: rect.contentWidth || 520, contentHeight: rect.contentHeight || 260, selected: selection?.kind === "area" && selection.id === area.id, muted: selectedArea !== "all" && selectedArea !== area.id, edit: openEdit, select: selectArea, resizeStart: onAreaResizeStart, resizeEnd: onAreaResizeEnd, ...focusData(id) } };
    }).filter(Boolean);
    for (const entity of snapshot.entities) {
      const storedRect = detailPositions.get(entity.id); if (!storedRect) continue; const rect = storedRect; const id = `entity:${entity.id}`; const manual = manualPositions.current.get(id); const person = entity.kind === "person"; const relatedAreas = connectedAreas.get(entity.id) || new Set(); const color = colors.get(routeSourceArea({source:id},entityMap)) || (theme === "dark" ? "#A0A9B2" : "#777777");
      output.push({ id, type: person ? "person" : rect.group ? "group" : "entity", className: rect.group ? "group-shell" : undefined, dragHandle: ".graph-item-body", position: manual || { x: rect.x, y: rect.y }, width: rect.width, height: rect.height, draggable: !historical, selectable: true, zIndex: person ? 30 : rect.group ? 2 + Math.min(6,rect.depth || 0) : 20 + (rect.depth || 0), style: { width: rect.width, height: rect.height }, data: { entity, stepNumber:activeScenario?(activeScenario.steps||[]).map((id,index)=>id===entity.id?index+1:null).filter(Boolean).join(" / "):null, detail: canvasDetail(rect, viewport.zoom), selected: selection?.kind === "entity" && selection.id === entity.id, label: entity.ownerLabel || entity.label, description: entity.ownerPurpose || entity.purpose || entity.path || (person ? "Внешний участник продукта" : "Подтверждённый элемент проекта"), color, status: entity.status, depth: rect.depth || 0, headerWidth: rect.headerWidth, headerHeight: rect.headerHeight, contour: historical ? rect.contour : undefined, pulsing: !historical, activeCount: person || activityTier === "area" ? 0 : activity.entities.get(entity.id) || 0, muted: selectedArea !== "all" && (person ? !relatedAreas.has(selectedArea) : selectedArea !== entity.areaId), edit: openEdit, select: selectEntity, ...focusData(id) } });
    }
    for (const work of liveWork) {
      const rect = workPositions.get(work.id); if (!rect) continue; const id = `work:${work.id}`; const manual = manualPositions.current.get(id); const first = entityMap.get(work.targets?.[0]);
      output.push({ id, type: "work", dragHandle: ".graph-item-body", position: manual || { x: rect.x, y: rect.y }, width: rect.width, height: rect.height, draggable: !historical, selectable: false, zIndex: 20, style: { width: rect.width, height: rect.height }, data: { work, pulsing: !historical, detail: workDetail(rect, viewport.zoom), selected: selection?.kind === "work" && selection.id === work.id, tier: activityTier, color: colors.get(first?.areaId) || (theme === "dark" ? "#A0A9B2" : "#777777"), open: openWork, select: selectWork, ...focusData(id) } });
    }
    const fittedNodes=fitGroupContours(output,hierarchy);
    const settledNodes=historical?fittedNodes.map(node=>{const saved=detailPositions.get(node.id.replace(/^entity:/,""))?.contour;return saved?{...node,data:{...node.data,contour:saved}}:node;}):fittedNodes;
    for(const item of timeline.comparison?.removed||[])if(item.kind==="entities"&&item.geometry){const rect=item.geometry;settledNodes.push({id:`removed:${item.id}`,type:"entity",position:{x:rect.x,y:rect.y},width:rect.width,height:rect.height,style:{width:rect.width,height:rect.height},draggable:false,selectable:false,zIndex:5,className:"diff-removed",data:{entity:item.item,label:item.label,description:"Удалён. Нажмите, чтобы открыть исходное состояние",status:"disabled",edit:()=>{},select:()=>timeline.seek(timeline.baseline)}});}
    return settledNodes.map(node=>({...node,className:[node.className,visibleComparison?.added?.some(item=>`${item.kind=== "areas"?"area":"entity"}:${item.id}`===node.id)?"diff-added":"",visibleComparison?.changed?.some(item=>`${item.kind==="areas"?"area":"entity"}:${item.id}`===node.id)?"diff-changed":""].filter(Boolean).join(" ")}));
  }, [layout, snapshot, liveWork, activityTier, layoutAreas, detailPositions, workPositions, activity, areaStatuses, hierarchy, selectedArea, entityMap, connectedAreas, colors, openEdit, openWork, onAreaResizeStart, onAreaResizeEnd, selectArea, selectEntity, selectWork, selection, visibleFocus, pinnedFocus, historical, timeline.comparison,visibleComparison, detailKey,activeScenario]);

  useEffect(() => { if (projectedNodes) setNodes(projectedNodes); }, [projectedNodes]);
  useEffect(() => {
    const request = pendingCamera.current;
    if (!request) return;
    const targets = request.kind === "flow" ? nodes.filter(node => request.ids.includes(node.id)) : nodes.filter(node => node.id === `${request.kind}:${request.id}`);
    if (!targets.length || request.kind === "flow" && targets.length < request.ids.length) return;
    pendingCamera.current = null;
    fittedOnce.current = true;
    requestAnimationFrame(() => {
      if (request.kind === "entity") {
        const node = targets[0];
        const visible=node.type==="group"?[{...node,width:node.data.headerWidth||420,height:node.data.headerHeight||100,style:{width:node.data.headerWidth||420,height:node.data.headerHeight||100}}]:[node];
        fitCamera({nodes:visible,padding:.35,minZoom:.65,maxZoom:1.05,duration:0});
      } else {
        let visibleTargets = targets;
        if(request.kind === "work") {
          const ids=new Set(targets[0]?.data.work?.targets||[]);
          visibleTargets=[...targets,...nodes.filter(node=>node.type!=="area"&&ids.has(node.data.entity?.id))];
        }
        const frame = wrapper.current?.getBoundingClientRect();
        if (request.kind === "flow" && frame && getViewportForBounds(boundingRect(targets.map(nodeRect)),frame.width,frame.height,.025,.85,.15).zoom < NODE_READABLE_ZOOM) {
          const areas = new Set(targets.map(node => node.data?.entity?.areaId).filter(Boolean));
          visibleTargets = [...targets,...nodes.filter(node => node.type === "area" && areas.has(node.data.area.id))];
        }
        fitCamera({ nodes:visibleTargets, padding:.15, minZoom:request.kind==="area"?.65:undefined, maxZoom:["area","work"].includes(request.kind) ? 1.1 : .85, duration:0 });
      }
    });
  }, [nodes, selection, flow]);
  useEffect(() => {
    if (!nodes.length || fittedOnce.current || pendingCamera.current) return;
    const target = selection && nodes.find(node => node.id === `${selection.kind}:${selection.id}`);
    const timer = setTimeout(() => {
      fittedOnce.current = true;
      if(!target&&snapshot.areas.length){fitOverview();return;}
      fitCamera({ includeHiddenNodes:true, nodes:target?[target]:undefined, padding:.1, minZoom:target?.type==="area"?.55:target?.type==="entity"?.95:undefined, maxZoom:1.05, duration:0 });
    }, 0);
    return () => clearTimeout(timer);
  }, [nodes.length, flow, selection]);

  const baseRects = useMemo(() => new Map([...(layout?.areas || []).map((item) => [`area:${item.id}`, item]), ...(layout?.entities || []).map((item) => [`entity:${item.id}`, item]), ...(layout?.work || []).map((item) => [`work:${item.id}`, item])]), [layout]);
  useEffect(() => {
    if (drag.current || !settled) return;
    for (const [id, position] of manualPositions.current) {
      const rect = baseRects.get(id);
      if (rect && Math.abs(rect.x-position.x)<.1 && Math.abs(rect.y-position.y)<.1) {
        manualPositions.current.delete(id);
        if (id.startsWith("area:")) manualAreaMinimums.current.delete(id.slice(5));
      }
    }
  }, [baseRects, settled]);
  const currentRects = useMemo(() => new Map(nodes.map((node) => [node.id, nodeRect(node)])), [nodes]);
  useEffect(()=>{
    manualPositions.current.clear();manualAreaMinimums.current.clear();setEdit(null);setSelection(null);setActiveScenario(null);setScenarioStep(0);if(historical&&!snapshot._geometry)setNodes([]);
  },[snapshot._history?.id]);
  const recordedHistory=Boolean(historical&&snapshot._geometry);
  const routes=useMemo(()=>recordedHistory?detailedRoutes:mergeReciprocalRoutes(detailedRoutes).filter(route=>!isContainmentRoute(route,hierarchy)),[detailedRoutes,hierarchy,recordedHistory]);
  const sceneKey=routeSceneKey(nodes);
  const scene=useMemo(()=>routeScene(nodes),[sceneKey]);
  const protectedHeaders=scene.headers;
  const budgetedRoutes=useMemo(()=>recordedHistory?routes:routeBudget(routes,{selection,areaId:selectedArea,flows:snapshot.map.keyFlows||[]}),[routes,recordedHistory,selection,selectedArea,snapshot.map.keyFlows]);
  const rawSceneRoutes=useMemo(()=>recordedHistory?routes:budgetedRoutes.map(route=>followMovedNodes(route,baseRects,scene.boundaries)),[routes,budgetedRoutes,baseRects,scene,recordedHistory]);
  const routingKey=sceneKey+JSON.stringify(rawSceneRoutes.map(route=>[route.id,route.source,route.target,route.channelId,route.sourcePort,route.targetPort]));
  const savedRoutes=recordedHistory?routes:snapshot._geometry?.routingVersion===ROUTING_VERSION&&snapshot._geometry?.routingKey===routingKey?snapshot._geometry.routes:null;
  const sceneComplete=rawSceneRoutes.every(route=>scene.boundaries.has(route.source)&&scene.boundaries.has(route.target));
  const routingReady=Boolean(layout&&settled&&sceneComplete&&(savedRoutes||presentation.key===routingKey&&!presentation.error&&presentation.routes?.length===rawSceneRoutes.length));
  useEffect(()=>{if(settled&&sceneComplete&&!drag.current&&!interactionActive&&!savedRoutes)prepareRoutes(routingKey,rawSceneRoutes,scene);},[routingKey,interactionActive,settled,sceneComplete,savedRoutes,prepareRoutes,rawSceneRoutes,scene]);
  useEffect(()=>{if(presentation.error)toast("Не удалось рассчитать связи. Перезагрузите карту, чтобы повторить расчёт.",true);},[presentation.error,toast]);
  const sceneRoutes=useMemo(()=>{
    if(recordedHistory)return routes;
    const prepared=new Map((savedRoutes||presentation.routes||[]).map(route=>[route.id,route]));
    const geometry=route=>{const found=prepared.get(route.id);return found?{...route,points:found.points,sourceBase:found.sourceBase,targetBase:found.targetBase,finalGeometry:found.finalGeometry}:route;};
    if(!savedRoutes&&presentation.key!==routingKey) {
      const preview=rawSceneRoutes.map(route=>{
        const previous=prepared.get(route.id);if(!previous)return route;
        const sameSize=['source','target'].every(end=>{const before=previous[end+'Base'],after=scene.boundaries.get(route[end]);return before&&after&&before.width===after.width&&before.height===after.height;});
        return followMovedNodes({...geometry(route),finalGeometry:sameSize},baseRects,scene.boundaries);
      });
      return presentSceneRoutes(preview,scene);
    }
    return rawSceneRoutes.map(geometry);
  },[recordedHistory,routes,routingKey,presentation,rawSceneRoutes,scene,baseRects,savedRoutes]);
  useEffect(()=>{
    const reconstructed=Boolean(snapshot._history?.reconstruction);
    const head=reconstructed?{...snapshot._history,revision:snapshot.revision}:snapshot._historyHead;
    if(historical&&(!reconstructed||recordedHistory)||!head||head.revision!==snapshot.revision||!routingReady||!layout||interactionActive||historyBusy.current||capturedGeometry.current.has(head.id))return;
    const timer=setTimeout(async()=>{
      const actualNodes=flow.getNodes();
      if(routeSceneKey(actualNodes)!==sceneKey||drag.current)return;
      const actual=new Map(actualNodes.map(node=>[node.id,node]));
      const positions=(items,kind)=>items.map(item=>{const node=actual.get(kind+':'+item.id);return node?{...item,...nodeRect(node),...(node.data?.contour?{contour:node.data.contour}:{})}:item;});
      const geometry={...layout,revision:undefined,format:2,routingVersion:ROUTING_VERSION,routingKey,fingerprint:layoutFingerprint(displaySnapshot),areas:positions(layout.areas,'area'),entities:positions(layout.entities,'entity'),work:positions(layout.work||[],'work'),routes:sceneRoutes};
      try {const response=await api(reconstructed?'/api/history/reconstruction-geometry':'/api/history/geometry',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:head.id,revision:snapshot.revision,geometry})});if(response.ok){const result=await response.json();if(result.saved||result.reason==='already-recorded')capturedGeometry.current.add(head.id);}}catch{}
    },350);return()=>clearTimeout(timer);
  },[historical,recordedHistory,snapshot.revision,snapshot._historyHead?.id,routingReady,routingKey,sceneKey,sceneRoutes,layout,interactionActive,displaySnapshot,flow]);

  const liveRoutes=useMemo(()=>sceneRoutes.map(route=>({...route,...routeColors(route,entityMap,colors,theme),visualKind:routeVisualKind(route,entityMap,areaStatuses)})),[sceneRoutes,entityMap,colors,theme,areaStatuses]);
  const onCanvasPointerMove=useCallback(event=>{
    const read=(key,title,body,point)=>{
      if(!key||viewport.zoom>=.75&&(key.startsWith("entity:")||key.startsWith("work:"))){clearReading();return;}
      const previous=readingTarget.current;
      if(previous?.key===key)return;
      clearReading();readingTarget.current={key,x:point.x,y:point.y};
      const frame=wrapper.current.getBoundingClientRect();
      readingTimer.current=setTimeout(()=>setReadingPreview({title,body,x:Math.max(12,Math.min(frame.width-300,point.x-frame.left+18)),y:Math.max(12,Math.min(frame.height-180,point.y-frame.top+18))}),450);
    };
    if(interactionActive||drag.current){clearReading();return;}
    const node=event.target?.closest?.(".react-flow__node");
    const entityId=event.target?.closest?.("[data-entity-id]")?.dataset.entityId||node?.dataset.id?.replace(/^entity:/,"");
    const entity=entityMap.get(entityId);
    const work=liveWork.find(item=>`work:${item.id}`===node?.dataset.id);
    if(work){read(`work:${work.id}`,work.title,`${work.actor||"Агент"} · ${work.status==="blocked"?"Ждёт решения":"В работе"}`,{x:event.clientX,y:event.clientY});leaveEdgeHover();return;}
    if(entity){read(`entity:${entityId}`,entity.ownerLabel||entity.label,entity.ownerPurpose||entity.purpose||"",{x:event.clientX,y:event.clientY});leaveEdgeHover();return;}
    if(event.target?.closest?.(".route-label"))return;
    if(node||event.target?.closest?.(".endpoint-chip")){clearReading();leaveEdgeHover();return;}
    hoverPointer.current={x:event.clientX,y:event.clientY};
    if(hoverFrame.current!==null)return;
    hoverFrame.current=requestAnimationFrame(()=>{
      hoverFrame.current=null;
      const point=flow.screenToFlowPosition(hoverPointer.current);
      const id=hoveredRouteAt(liveRoutes,point,viewport.zoom,hoveredRouteRef.current);
      const route=liveRoutes.find(item=>item.id===id);
      read(id,route?.label,(route?.relations||[]).map(relation=>`${entityMap.get(relation.from)?.ownerLabel||entityMap.get(relation.from)?.label||""} → ${entityMap.get(relation.to)?.ownerLabel||entityMap.get(relation.to)?.label||""}`).join("; "),hoverPointer.current);
      if(id)keepEdgeHover(id);else leaveEdgeHover();
    });
  },[interactionActive,liveRoutes,flow,viewport.zoom,keepEdgeHover,leaveEdgeHover,entityMap,liveWork,clearReading]);
  useEffect(()=>()=>cancelAnimationFrame(hoverFrame.current),[]);
  const obstacles = useMemo(() => {
    if (interactionActive && obstacleCache.current.length) return obstacleCache.current;
    const next = nodes.filter((node) => !node.hidden || activityTier==="area"&&node.id.startsWith("entity:")).map(node=>{
      if(node.type!=="area")return dropObstacle(node);
      const scale=node.data.labelScale||1;
      return {x:node.position.x+18,y:node.position.y+14,width:Math.max(0,node.width-36),height:(node.data.distant?110:170)*scale};
    });
    obstacleCache.current = next; return next;
  }, [nodes, activityTier, interactionActive]);
  const placements = useMemo(() => {
    if (interactionActive && placementCache.current.size) return placementCache.current;
    const headerScales=new Map(nodes.filter(node=>node.type==="area").map(node=>[node.id,node.data.labelScale||1]));
    const labelRoutes=liveRoutes.map(route=>({...route,maxLabelScale:viewport.zoom<NODE_READABLE_ZOOM?Math.min(headerScales.get(route.source)||Infinity,headerScales.get(route.target)||Infinity)*1.6:1}));
    const next = placeRouteLabels(labelRoutes, viewport, size, [...obstacles,...protectedHeaders]);
    placementCache.current = next; return next;
  }, [liveRoutes, viewport, size, obstacles, protectedHeaders, interactionActive]);
  const edges = useMemo(() => {
    const nextCache = new Map();
    const focusedRoutes=allConnections?liveRoutes:liveRoutes.filter(route=>selection?.kind==="route"?routeMatchesFocus(route,pinnedFocus):["entity","work"].includes(selection?.kind)?pinnedFocus.nodeIds.has(route.source)||pinnedFocus.nodeIds.has(route.target):selectedArea!=="all"?route.sourceAreaId===selectedArea||route.targetAreaId===selectedArea:true);
    const output = focusedRoutes.slice(0,60).map((route) => {
      const placement = placements.get(route.id); const hidden = false;
      const persistentLabel = persistentRouteLabel(route, placement);
      const pinned = ["entity", "work"].includes(selection?.kind) ? pinnedFocus.nodeIds.has(route.source) || pinnedFocus.nodeIds.has(route.target) : selection?.kind === "route" && routeMatchesFocus(route, pinnedFocus);
      const active = pinned; const labelActive = selection?.kind === "route" && pinned; const opacity = route.type === "work" && activityTier === "area" ? .74 : route.type === "work" && activityTier === "entity" ? .82 : activityTier === "area" ? .82 : activityTier === "entity" ? .68 : .86;
      const mutedByArea = selectedArea !== "all" && route.sourceAreaId !== selectedArea && route.targetAreaId !== selectedArea;
      const muted = ["route", "entity", "work"].includes(selection?.kind) && !pinned;
      const previous = edgeCache.current.get(route.id);
      if (previous && previous.data.zoom === viewport.zoom && previous.data.route === route && previous.data.placement === placement && previous.data.persistentLabel === persistentLabel && previous.data.hidden === hidden && previous.data.active === active && previous.data.labelActive === labelActive && previous.data.pinned === pinned && previous.data.opacity === opacity && previous.data.muted === muted && previous.data.interactionActive === interactionActive) {
        nextCache.set(route.id, previous); return previous;
      }
      const edge = { id: route.id, source: route.source, target: route.target, type: "routed", interactionWidth: 16, zIndex: 10, data: { route, zoom:viewport.zoom, placement, persistentLabel, hidden, active, labelActive, pinned, opacity, muted, interactionActive, edit: openEdit, selectRoute, keepHover: keepEdgeHover, leaveHover: leaveEdgeHover } };
      nextCache.set(route.id, edge); return edge;
    });
    edgeCache.current = nextCache; return output;
  }, [liveRoutes, placements, viewport.zoom, activityTier, selectedArea, selection, pinnedFocus, interactionActive, openEdit, selectRoute, keepEdgeHover, leaveEdgeHover,allConnections]);

  // React Flow owns the camera transform during a gesture. Expensive scene,
  // LOD and label updates happen once when it settles, not on every wheel tick.
  const settleViewport = useCallback((event, next) => {
    // Programmatic moves can end when a newer move interrupts them. Snapping that old end would cancel the new destination.
    if (!event) { setViewport(flow.getViewport()); setInteractionActive(Boolean(drag.current)); return; }
    const rect = wrapper.current?.getBoundingClientRect(); const anchor = rect && Number.isFinite(event?.clientX) ? { x: event.clientX - rect.left, y: event.clientY - rect.top } : { x: size.width / 2, y: size.height / 2 };
    const settled = settleViewportTransform(next, size, anchor, devicePixelRatio || 1);
    const changed = Math.abs(settled.x - next.x) > .01 || Math.abs(settled.y - next.y) > .01 || Math.abs(settled.zoom - next.zoom) > .0001;
    setViewport(settled); if (changed) flow.setViewport(settled, { duration: 0 });
    setInteractionActive(Boolean(drag.current));
  }, [flow, size]);
  const onNodesChange = useCallback((changes) => setNodes((current) => {
    const active = drag.current;
    const safeChanges = active ? changes.filter((change) => change.type !== "position" || !active.positions.has(change.id)) : changes;
    return safeChanges.length ? applyNodeChanges(safeChanges, current) : current;
  }), []);
  const onNodeDragStart = useCallback((event, node) => {
    setDropPreview(null);
    clearEdgeHover();
    const affected = graphItemMoveIds(displaySnapshot, node.id, now);
    const byId = new Map(nodes.map((item) => [item.id, item]));
    const positions = new Map(nodes.filter((item) => affected.has(item.id)).map((item) => [item.id, { ...item.position }]));
    const visualRects = nodes.filter((item) => affected.has(item.id) && item.type !== "work").map(dragVisualRect);
    const sourceBounds = boundingRect(visualRects.length ? visualRects : [dragVisualRect(node)]);
    const [kind, ...idParts] = node.id.split(":"); const entityId = kind === "entity" ? idParts.join(":") : "";
    const entity = entityMap.get(entityId); const canReparent = Boolean(entity && entity.kind !== "person");
    const originNode = canReparent && entity.parentId ? byId.get(`entity:${entity.parentId}`) : null;
    const groupContainer = (item) => {
      const rect = absoluteGroupContour(item, byId, hierarchy);
      return { id: item.id, type: "group", entityId: item.data.entity.id, areaId: item.data.entity.areaId, depth: item.data.depth || 0, rect, headerRect: { x: rect.x, y: rect.y, width: rect.width, height: item.data.headerHeight || 76 } };
    };
    const areaContainer = (item) => ({ id: item.id, type: "area", areaId: item.data.area.id, entityId: "", depth: -1, rect: nodeRect(item), headerRect: { x: item.position.x + 18, y: item.position.y + 14, width: Math.max(0, Number(item.style?.width || 0) - 36), height: AREA_HEADER_HEIGHT - 20 } });
    const originAreaNode = canReparent ? byId.get(`area:${entity.areaId}`) : null;
    const origin = originNode?.type === "group" ? groupContainer(originNode) : originAreaNode ? areaContainer(originAreaNode) : null;
    const containers = canReparent ? [
      ...nodes.filter((item) => item.type === "group" && !affected.has(item.id)).map(groupContainer),
      ...nodes.filter((item) => item.type === "area").map(areaContainer),
    ] : [];
    if (origin && !containers.some((item) => item.id === origin.id)) containers.push({ ...origin, depth: originNode.data.depth || 0 });
    const pointer = pointerPosition(flow, event, node.position);
    for (const [id, position] of positions) manualPositions.current.set(id, position);
    drag.current = {
      id: node.id, kind, entityId, canReparent, originalParentId: entity?.parentId || "", originalAreaId: entity?.areaId || "", affected,
      snapshot, originalNodes: nodes, pointer, start: { ...(positions.get(node.id) || node.position) }, pointerOffset: { x: pointer.x - node.position.x, y: pointer.y - node.position.y },
      positions, sourceBounds, origin, containers, targetId: null,
      lastTranslation: { dx: 0, dy: 0 }, lastRawTranslation: { dx: 0, dy: 0 }, lastMoves: [],
    };
    setInteractionActive(true);
  }, [clearEdgeHover, displaySnapshot, entityMap, flow, hierarchy, now, nodes]);
  const onNodeDrag = useCallback((event, node) => {
    const context = drag.current; if (!context || context.id !== node.id) return;
    const pointer = pointerPosition(flow, event, node.position);
    const rawPosition = { x: pointer.x - context.pointerOffset.x, y: pointer.y - context.pointerOffset.y };
    const rawTranslation = { dx: rawPosition.x - context.start.x, dy: rawPosition.y - context.start.y };
    const rawBounds = translateRect(context.sourceBounds, rawTranslation.dx, rawTranslation.dy);
    const target = context.canReparent ? canvasDropTarget(rawBounds,context) : null;
    const translated = rawTranslation;
    const moves = [...context.positions].map(([id, initial]) => ({ id, x: initial.x + translated.dx, y: initial.y + translated.dy }));
    context.targetId = target?.id || null; context.pointer = pointer; context.lastTranslation = translated; context.lastRawTranslation = rawTranslation; context.lastMoves = moves;
    for (const move of moves) manualPositions.current.set(move.id, { x: move.x, y: move.y });
    const settlement = settleCanvasDrop(context.snapshot, context.originalNodes, context, activityTier);
    context.settlement = settlement;
    const finalMap = new Map(settlement.finalMoves.map(move => [move.id, move]));
    const moveMap = new Map(moves.map(move => [move.id, move]));
    const previewNodes = context.originalNodes.map(item => {
      const move = finalMap.get(item.id);
      return move ? {...item,position:{x:move.x,y:move.y},...(item.type === "area" ? {width:move.width??item.width,height:move.height??item.height,style:{...item.style,width:move.width??item.width,height:move.height??item.height}} : {})} : item;
    });
    const ownedFrames=originalContainerIds(context);
    const contours = fitGroupContours(previewNodes, settlement.nextHierarchy).map(item=>ownedFrames.has(item.id)&&item.type==='group'?{...item,data:{...item.data,contour:context.originalNodes.find(original=>original.id===item.id)?.data.contour}}:item);
    setNodes(contours.map(item => {
      const moving = moveMap.get(item.id);
      return {...item,...(moving ? {position:{x:moving.x,y:moving.y}} : {}),data:{...item.data,dragTarget:item.id === settlement.target?.id}};
    }));
    cancelAnimationFrame(dragPreviewFrame.current);
    const final = settlement.finalMoves.find((move) => move.id === context.id);
    const initial = context.positions.get(context.id);
    const rect = final && initial ? translateRect(context.sourceBounds, final.x - initial.x, final.y - initial.y) : null;
    dragPreviewFrame.current = requestAnimationFrame(() => setDropPreview(rect ? { areaId: settlement.nextAreaId, rect, color: colors.get(settlement.nextAreaId) } : null));
  }, [colors, entityMap, flow, nodes, snapshot.entities, viewport.zoom, activityTier]);
  const onNodeDragStop = useCallback(async (event, node) => {
    onNodeDrag(event, node);
    cancelAnimationFrame(dragPreviewFrame.current); setDropPreview(null);
    const context = drag.current; drag.current = null;
    if (!context || !node.id.match(/^(area|entity|work):/)) { setInteractionActive(false); return; }
    const desired = context.lastTranslation;
    if (Math.abs(desired.dx) < .01 && Math.abs(desired.dy) < .01) {
      setNodes((current) => current.map((item) => item.data?.dragTarget ? { ...item, data: { ...item.data, dragTarget: false } } : item));
      setInteractionActive(false);
      return;
    }
    const { finalMoves, nextHierarchy, compactParentIds, changedAreaEntityIds, nextAreaId, nextParentId } = context.settlement || settleCanvasDrop(context.snapshot, context.originalNodes, context, activityTier);
    const byNodeId = new Map(nodes.map((item) => [item.id, item]));
    const beforeMoves = finalMoves.map((move) => {
      const current = context.originalNodes.find(item=>item.id===move.id); const position = context.positions.get(move.id) || current?.position || { x: move.x, y: move.y };
      return { id: move.id, x: position.x, y: position.y, ...(move.id.startsWith("area:") ? { width: Number(current?.style?.width || move.width), height: Number(current?.style?.height || move.height) } : {}) };
    });
    const before = beforeMoves.map((move) => {
      const kind = move.id.split(":", 1)[0]; const id = move.id.replace(/^[^:]+:/, ""); const item = { kind, id, x: move.x, y: move.y, ...(kind === "area" ? { width: move.width, height: move.height } : {}) };
      if (kind === "entity" && (move.id === context.id || changedAreaEntityIds.has(id))) { const original = entityMap.get(id); item.areaId = original?.areaId || "";item.ownerAreaId=original?.ownerAreaId??null;item.ownerParentId=original?.ownerParentId??null; if (move.id === context.id) item.parentId = context.originalParentId; }
      return item;
    });
    const items = finalMoves.map((move) => {
      const kind = move.id.split(":", 1)[0]; const id = move.id.replace(/^[^:]+:/, ""); const item = { kind, id, x: move.x, y: move.y, ...(kind === "area" ? { width: move.width, height: move.height } : {}) };
      if (kind === "entity" && (move.id === context.id || changedAreaEntityIds.has(id))) { item.areaId = changedAreaEntityIds.has(id) ? nextAreaId : entityMap.get(id)?.areaId || context.originalAreaId; if (move.id === context.id) item.parentId = nextParentId;const original=entityMap.get(id);item.ownerAreaId=item.areaId!==original?.areaId?item.areaId:original?.ownerAreaId??null;item.ownerParentId=Object.hasOwn(item,"parentId")&&item.parentId!==(original?.parentId||"")?item.parentId:original?.ownerParentId??null; }
      return item;
    });
    for (const parentId of compactParentIds) {
      const pinNode = byNodeId.get(`entity:${parentId}`); if (!pinNode || finalMoves.some((move) => move.id === pinNode.id)) continue;
      const item = { kind: "entity", id: parentId, x: pinNode.position.x, y: pinNode.position.y };
      before.push({ ...item }); items.push(item);
    }
    const finalMap = new Map(finalMoves.map((move) => [move.id, move]));
    for (const move of finalMoves) manualPositions.current.set(move.id, { x: move.x, y: move.y });
    setNodes((current) => fitGroupContours(current.map((item) => {
      const move = finalMap.get(item.id); const data = item.data?.dragTarget ? { ...item.data, dragTarget: false } : item.data;
      if (move) return { ...item, position: { x: move.x, y: move.y }, ...(move.id.startsWith("area:") ? { width: move.width??item.width, height: move.height??item.height, style: { ...item.style, width: move.width??item.width, height: move.height??item.height } } : {}), data };
      return item.data?.dragTarget ? { ...item, data } : item;
    }), nextHierarchy));
    const parentChanged = nextParentId !== context.originalParentId; const areaChanged = nextAreaId !== context.originalAreaId;
    setInteractionActive(false);
    try {
      await enqueueMutation(() => persistLayout(items, layoutExpectation(context.snapshot, items)));
      const label = context.kind === "area" ? "перемещение области" : context.kind === "work" ? "перемещение работы" : areaChanged ? "перемещение элемента между областями" : parentChanged ? nextParentId ? "перемещение элемента между блоками" : "извлечение элемента из блока" : "перемещение элемента";
      remember({ type: "layout", label, before, after: items });
      toast(context.kind === "area" ? "Область и всё содержимое перемещены" : context.kind === "work" ? "Работа перемещена" : areaChanged ? nextAreaId ? "Элемент перемещён в новую область" : "Элемент вынесен из области" : parentChanged ? nextParentId ? "Элемент перемещён и привязан к новому блоку" : "Элемент вынесен из блока" : "Элемент и его вложенная структура перемещены");
    } catch (error) {
      const beforeMap = new Map(beforeMoves.map((move) => [move.id, move]));
      for (const move of beforeMoves) manualPositions.current.set(move.id, { x: move.x, y: move.y });
      setNodes((current) => fitGroupContours(current.map((item) => beforeMap.has(item.id) ? { ...item, position: { x: beforeMap.get(item.id).x, y: beforeMap.get(item.id).y }, ...(item.type === "area" ? { width: beforeMap.get(item.id).width, height: beforeMap.get(item.id).height, style: { ...item.style, width: beforeMap.get(item.id).width, height: beforeMap.get(item.id).height } } : {}), data: item.data?.dragTarget ? { ...item.data, dragTarget: false } : item.data } : item.data?.dragTarget ? { ...item, data: { ...item.data, dragTarget: false } } : item), hierarchy));
      toast(error.message, true);
    }
  }, [activityTier, displaySnapshot, enqueueMutation, entityMap, hierarchy, liveWork, nodes, persistLayout, remember, toast, onNodeDrag]);

  const runHistory = useCallback(async (direction) => {
    if (historyBusy.current) return;
    const from = direction === "undo" ? history.current.past : history.current.future; const to = direction === "undo" ? history.current.future : history.current.past; const entry = from.at(-1);
    if (!entry) return;
    const values = direction === "undo" ? entry.before : entry.after;
    const rollbackValues = direction === "undo" ? entry.after : entry.before;
    const beforeLayout=Array.isArray(entry.before)?entry.before:[],afterLayout=Array.isArray(entry.after)?entry.after:[];
    const beforeParents = new Map(beforeLayout.filter((value) => value.kind === "entity" && Object.hasOwn(value, "parentId")).map((value) => [value.id, value.parentId || ""]));
    const afterParents = new Map(afterLayout.filter((value) => value.kind === "entity" && Object.hasOwn(value, "parentId")).map((value) => [value.id, value.parentId || ""]));
    const beforeAreas = new Map(beforeLayout.filter((value) => value.kind === "entity" && Object.hasOwn(value, "areaId")).map((value) => [value.id, value.areaId || ""]));
    const afterAreas = new Map(afterLayout.filter((value) => value.kind === "entity" && Object.hasOwn(value, "areaId")).map((value) => [value.id, value.areaId || ""]));
    const applyLayoutValues = (layoutValues) => {
      for (const value of layoutValues) {
        manualPositions.current.set(`${value.kind}:${value.id}`, { x: value.x, y: value.y });
        if (value.kind === "area" && (Object.hasOwn(value, "minWidth") || Object.hasOwn(value, "minHeight"))) manualAreaMinimums.current.set(value.id, { minWidth: Number(value.minWidth || 0), minHeight: Number(value.minHeight || 0) });
      }
      const valueMap = new Map(layoutValues.map((item) => [`${item.kind}:${item.id}`, item]));
      const historyHierarchy = hierarchyWithLayoutItems(displaySnapshot, layoutValues);
      setNodes((current) => fitGroupContours(current.map((node) => { const value = valueMap.get(node.id); if (!value) return node; const width = value.width ?? nodeRect(node).width; const height = value.height ?? nodeRect(node).height; return { ...node, position: { x: value.x, y: value.y }, ...(node.type === "area" ? { width, height, style: { ...node.style, width, height } } : {}) }; }), historyHierarchy));
    };
    historyBusy.current = true;
    if (entry.type === "layout") applyLayoutValues(values);
    try {
      await enqueueMutation(async () => {
        if (entry.type === "layout") return persistLayout(values, rollbackValues.map(({kind,id,resetPosition,...expected}) => ({kind,id,values:resetPosition?{...expected,x:null,y:null}:expected})));
        const path = "/api/rename";
      const body = { canvasRevision: revisionRef.current, kind: entry.kind, id: entry.id, values, expectedValues: rollbackValues };
        const response = await api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); const result = await response.json(); if (!response.ok) throw new Error(result.error); revisionRef.current = result.revision;
      });
      from.pop(); to.push(entry); syncHistory(); if (entry.type !== "layout") await refreshSnapshot(); toast(`${direction === "undo" ? "Отменено" : "Повторено"}: ${entry.label}`);
    } catch (error) {
      if (entry.type === "layout") {
        applyLayoutValues(rollbackValues);
        for (const item of rollbackValues) manualPositions.current.delete(`${item.kind}:${item.id}`);
      }
      await refreshSnapshot();
      toast(error.message, true);
    }
    finally { historyBusy.current = false; }
  }, [displaySnapshot, enqueueMutation, persistLayout, refreshSnapshot, syncHistory, toast]);

  const focusEntity = useCallback((entity) => {
    if (!entity) return;
    pendingCamera.current = {kind:"entity",id:entity.id};
    rememberView(); selectEntity(entity); setSelectedArea(entity.areaId || "all");
  }, [flow, selectEntity]);
  const fitAll = useCallback(() => { setSelectedArea("all");setSelection(null);setActiveScenario(null);setOverviewTier(true);requestAnimationFrame(()=>fitOverview()); }, [fitOverview]);
  const focusArea = useCallback((id) => { pendingCamera.current={kind:"area",id};rememberView();setSelectedArea(id);selectArea(areaMap.get(id)); }, [flow, selectArea, areaMap]);
  const focusPerson = useCallback((person) => { rememberView();
    selectEntity(person);
    const related = new Set([person.id]);
    for (const relation of snapshot.relations) {
      if (relation.from === person.id) related.add(relation.to);
      if (relation.to === person.id) related.add(relation.from);
    }
    requestAnimationFrame(() => fitCamera({ includeHiddenNodes:true, nodes: nodes.filter((node) => related.has(node.id.replace(/^entity:/, ""))), padding: .3, duration: 450, maxZoom: 1.1 }));
  }, [flow, snapshot.relations, nodes, selectEntity]);

  useEffect(()=>{
    if(!edit&&!regenerate)return;
    const modal=document.querySelector(".modal");if(!modal)return;
    const previous=document.activeElement;const workspace=document.querySelector(".workspace");if(workspace)workspace.inert=true;
    modal.setAttribute("role","dialog");modal.setAttribute("aria-modal","true");modal.setAttribute("aria-label",edit?"Редактирование элемента":"Построение карты");
    const focusables=()=>[...modal.querySelectorAll("input,textarea,select,button,[tabindex]")].filter(element=>!element.disabled&&element.tabIndex>=0);
    focusables()[0]?.focus();
    const trap=event=>{if(event.key!=="Tab")return;const items=focusables();const index=items.indexOf(document.activeElement);if(event.shiftKey&&index<=0){event.preventDefault();items.at(-1)?.focus();}else if(!event.shiftKey&&index===items.length-1){event.preventDefault();items[0]?.focus();}};
    document.addEventListener("keydown",trap,true);return()=>{if(workspace)workspace.inert=false;document.removeEventListener("keydown",trap,true);(previous?.isConnected?previous:document.querySelector(".context-action"))?.focus();};
  },[Boolean(edit),regenerate]);
  async function saveEdit(event) { event.preventDefault(); const title = edit.title.trim(); const description = edit.description.trim(); if (!title) return; const values = { title, ...(edit.kind === "relation" ? {} : { description }) }; const before = { title: edit.original.title, ...(edit.kind === "relation" ? {} : { description: edit.original.description }) }; try { await enqueueMutation(async () => { const response = await api("/api/rename", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ canvasRevision: revisionRef.current, kind: edit.kind, id: edit.id, values }) }); const result = await response.json(); if (!response.ok) throw new Error(result.error); revisionRef.current = result.revision; }); remember({ type: "rename", label: edit.kind === "relation" ? "изменение подписи связи" : "переименование", kind: edit.kind, id: edit.id, before, after: values }); setEdit(null); toast(edit.kind === "relation" ? "Подпись связи сохранена" : "Название и описание сохранены"); } catch (error) { toast(error.message, true); } }
  async function runRegenerate(reason="manual") { try { manualPositions.current.clear(); manualAreaMinimums.current.clear(); const response = await api("/api/architect/refresh", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ viewpoint,reason:typeof reason==="string"?reason:"manual" }) }); const result = await response.json(); if (!response.ok) throw new Error(result.error); setArchitect(result); setDismissedArchitect(null); setRegenerate(false); toast(result.started ? "Обновление Canvas запущено" : "Canvas уже обновляется"); } catch (error) { toast(error.message, true); } }

  useEffect(() => {
    const handler = (event) => {
      const modifier = event.ctrlKey || event.metaKey;
      if (modifier && event.key.toLowerCase() === "f" && !/^(INPUT|TEXTAREA|SELECT)$/.test(event.target?.tagName) && !event.target?.isContentEditable) {
        event.preventDefault(); setSearchOpen(true); requestAnimationFrame(() => searchInput.current?.focus()); return;
      }
      if (event.key !== "Escape") return;
      if (edit) { event.preventDefault(); setEdit(null); return; }
      if (regenerate) { event.preventDefault(); setRegenerate(false); return; }
      if (searchOpen) { event.preventDefault(); setSearchOpen(false); setSearchQuery(""); return; }
      if (contextOpen) { event.preventDefault(); setContextOpen(false); return; }
      if (selection) { event.preventDefault(); setSelection(null); }
    };
    addEventListener("keydown", handler); return () => removeEventListener("keydown", handler);
  }, [edit, regenerate, searchOpen, contextOpen, selection]);
  useEffect(() => { if (searchOpen) requestAnimationFrame(() => searchInput.current?.focus()); }, [searchOpen]);

  useEffect(() => { const handler = (event) => { const modifier = event.ctrlKey || event.metaKey; if (historical || !modifier || /^(INPUT|TEXTAREA|SELECT)$/.test(event.target?.tagName) || event.target?.isContentEditable) return; const undo = event.key.toLowerCase() === "z" && !event.shiftKey; const redo = event.key.toLowerCase() === "y" || event.key.toLowerCase() === "z" && event.shiftKey; if (!undo && !redo) return; event.preventDefault(); runHistory(undo ? "undo" : "redo"); }; addEventListener("keydown", handler); return () => removeEventListener("keydown", handler); }, [runHistory,historical]);

  const people = snapshot.entities.filter((entity) => entity.kind === "person");
  const tree = snapshot.areas.map((area) => ({ area, entities: snapshot.entities.filter((entity) => entity.areaId === area.id && (!entity.parentId || !entityMap.has(entity.parentId))) }));
  const freeEntities=snapshot.entities.filter(entity=>!entity.areaId&&entity.kind!=='person'&&!entity.parentId);
  const childrenByParent = useMemo(() => { const result = new Map(); for (const entity of snapshot.entities) { if (!entity.parentId || !entityMap.has(entity.parentId)) continue; if (!result.has(entity.parentId)) result.set(entity.parentId, []); result.get(entity.parentId).push(entity); } for (const children of result.values()) children.sort((a, b) => Number(a.order || 0) - Number(b.order || 0) || String(a.ownerLabel || a.label).localeCompare(String(b.ownerLabel || b.label))); return result; }, [snapshot.entities, entityMap]);
  const renderTreeEntities = (entities, depth = 0) => entities.map((entity) => {
    const children = childrenByParent.get(entity.id) || []; const closed = collapsedEntities.has(entity.id); const active = selection?.kind === "entity" && selection.id === entity.id;
    return <React.Fragment key={entity.id}><div className={`tree-entity-row ${active ? "is-active" : ""}`} style={{ "--tree-depth": depth }} ref={(element) => { if (element) treeRowRefs.current.set(entity.id, element); else treeRowRefs.current.delete(entity.id); }}><button type="button" onClick={() => focusEntity(entity)}><i className={entity.status}></i><span>{entity.ownerLabel || entity.label}</span></button>{children.length > 0 && <button type="button" className="tree-branch-toggle" aria-label={closed ? "Раскрыть вложенные элементы" : "Свернуть вложенные элементы"} onClick={() => setCollapsedEntities((current) => { const next = new Set(current); if (next.has(entity.id)) next.delete(entity.id); else next.add(entity.id); return next; })}>{closed ? "›" : "⌄"}</button>}</div>{children.length > 0 && !closed && renderTreeEntities(children, depth + 1)}</React.Fragment>;
  });
  const selectedRelations = selectedRoute ? (selectedRoute.relations || []).filter((relation) => !selection.relationId || relation.id === selection.relationId) : [];
  const entityRelations = selectedEntity ? snapshot.relations.filter((relation) => relation.from === selectedEntity.id || relation.to === selectedEntity.id) : [];
  const relationEndpoint = (id) => entityMap.get(id);
  const inspector = selection?.kind === "entity" && selectedEntity ? <section className="passport inspector-card"><IconButton icon={Icons.XIcon} label="Закрыть сведения" onClick={()=>setSelection(null)}/><h2>{selectedEntity.ownerLabel||selectedEntity.label}</h2><StatusBadge status={componentStatus(selectedEntity.status)}>{statuses[selectedEntity.status]||"В системе"}</StatusBadge><p>{selectedEntity.ownerPurpose||selectedEntity.purpose||"Описание пока не записано"}</p>{selectedEntity.status==="problem"&&<div className="inspector-problem"><strong>Почему нужна проверка</strong><p>{selectedEntity.statusReason||selectedEntity.verification?.reason||selectedEntity.note||"Подробное основание не записано. Откройте источники, чтобы уточнить статус."}</p></div>}<dl><div><dt>Получает</dt><dd><ul>{[].concat(selectedEntity.inputs||[]).map((item,i)=><li key={i}>{item}</li>)}</ul>{!selectedEntity.inputs?.length&&"Пока не описано"}</dd></div><div><dt>Передаёт</dt><dd><ul>{[].concat(selectedEntity.outputs||[]).map((item,i)=><li key={i}>{item}</li>)}</ul>{!selectedEntity.outputs?.length&&"Пока не описано"}</dd></div></dl><p className="inspector-area">{selectedEntity.kind==="person"?"Вне областей":areaMap.get(selectedEntity.areaId)?.ownerTitle||areaMap.get(selectedEntity.areaId)?.title}</p>{entityRelations.length>0&&<details className="inspector-relations"><summary>Связи ({entityRelations.length})</summary>{entityRelations.map(relation=><button key={relation.id} onClick={()=>{const route=liveRoutes.find(item=>relationIds(item).includes(relation.id));if(route)selectRoute(route,relation.id);}}><span>{relation.from===selectedEntity.id?"→":"←"}</span><strong>{relation.ownerLabel||relation.label||"Связь без подписи"}</strong></button>)}</details>}</section>
    : selection?.kind === "route" && selectedRoute ? <section className="passport inspector-card route-inspector" style={{ "--edge-color": routeColors(selectedRoute,entityMap,colors,theme).color }}><IconButton icon={Icons.XIcon} label="Закрыть сведения" onClick={()=>setSelection(null)}/><small>{selectedRoute.bidirectional ? "ВЗАИМООБМЕН" : selectedRelations.length > 1 ? "СВЯЗИ" : "СВЯЗЬ"}</small><h2>{selectedRelations.length > 1 ? `${selectedRelations.length} связей` : selectedRelations[0]?.ownerLabel || selectedRelations[0]?.label || selectedRoute.label}</h2>{selectedRelations.length === 1 && <p>{selectedRelations[0]?.ownerNote || selectedRelations[0]?.note || "Действие между двумя элементами проекта"}</p>}<ol>{selectedRelations.map((relation) => { const from = relationEndpoint(relation.from); const to = relationEndpoint(relation.to); const expanded = selectedRelations.length === 1 || selection.relationId === relation.id; return <li key={relation.id}><button onClick={() => selectRoute(selectedRoute, relation.id)}><strong>{relation.ownerLabel || relation.label || "Связь без подписи"}</strong><small>{from?.ownerLabel || from?.label || relation.from} <b>→</b> {to?.ownerLabel || to?.label || relation.to}</small></button>{expanded && <p>{relation.contract && <>Контракт: {relation.contract}<br /></>}{relation.mechanism && <>Механизм: {relation.mechanism}<br /></>}{(relation.evidence || []).length > 0 && <>Основание: {relation.evidence.join(" · ")}<br /></>}<b>{from?.ownerLabel || from?.label || relation.from}</b>: {from?.ownerPurpose || from?.purpose || "Источник связи"}<br /><b>{to?.ownerLabel || to?.label || relation.to}</b>: {to?.ownerPurpose || to?.purpose || "Получатель связи"}</p>}</li>; })}</ol></section>
      : selection?.kind === "area" ? <section className="passport inspector-card"><IconButton icon={Icons.XIcon} label="Закрыть сведения" onClick={()=>setSelection(null)}/><small>ОБЛАСТЬ ПРОЕКТА</small><h2>{areaMap.get(selection.id)?.ownerTitle || areaMap.get(selection.id)?.title}</h2><p>{areaMap.get(selection.id)?.ownerNote || areaMap.get(selection.id)?.note || "Смысловая граница ответственности"}</p></section>
        : selection?.kind === "work" && selectedWork ? <section className="passport inspector-card"><IconButton icon={Icons.XIcon} label="Закрыть сведения" onClick={()=>setSelection(null)}/><small>ТЕКУЩАЯ РАБОТА</small><h2>{selectedWork.title}</h2><StatusBadge status={componentStatus(selectedWork.status)}/><p>{selectedWork.actor || "Агент"}</p><WorkDetail work={selectedWork} api={api} checkpointId={snapshot._history?.id}/><dl><div><dt>Затронутые элементы</dt><dd>{(selectedWork.targets||[]).map(id=>entityMap.get(id)?.ownerLabel||entityMap.get(id)?.label||id).join(", ")}</dd></div></dl>{selectedWork.session && <button className="inspector-open-session" onClick={() => openWork(selectedWork)}>Перейти к сессии</button>}</section> : null;

  const activateSearchResult = useCallback((item) => {
    setSearchOpen(false); setSearchQuery("");
    if (item.kind === "area") { focusArea(item.id); return; }
    const node = nodes.find((entry) => entry.id === `${item.kind}:${item.id}`);
    if (item.kind === "entity") { const entity = entityMap.get(item.id); if (entity) focusEntity(entity); return; }
    if (item.kind === "work") { const work = liveWork.find((entry) => entry.id === item.id); if (work) { pendingCamera.current={kind:"work",id:item.id}; selectWork(work); } return; }
    if (node) requestAnimationFrame(() => fitCamera({ includeHiddenNodes:true, nodes: [node], padding: .55, duration: 420, maxZoom: item.kind === "work" ? 1.1 : .95 }));
  }, [entityMap, flow, focusArea, focusEntity, liveWork, nodes, selectEntity, selectWork]);
  const offscreenChips = useMemo(() => {
    if (selection?.kind !== "route") return [];
    const allIds = [...pinnedFocus.nodeIds]; const entityIds = allIds.filter((id) => id.startsWith("entity:")); const candidates = entityIds.length ? entityIds : allIds;
    const chips = candidates.map((id) => { const rect = currentRects.get(id); const chip = offscreenChip(viewport, size, rect); if (!chip) return null; const raw = id.replace(/^[^:]+:/, ""); const label = id.startsWith("area:") ? areaMap.get(raw)?.ownerTitle || areaMap.get(raw)?.title : entityMap.get(raw)?.ownerLabel || entityMap.get(raw)?.label; return { id, label: label || raw, ...chip }; }).filter(Boolean).slice(0, 6);
    return spreadOffscreenChips(chips, size);
  }, [selection, pinnedFocus, currentRects, viewport, size, areaMap, entityMap]);
  const [arranging,setArranging]=useState(false);
  const arrangeFlows=async()=>{if([...snapshot.areas,...snapshot.entities].every(item=>Number.isFinite(item.x)&&Number.isFinite(item.y))){toast("Все позиции закреплены вручную; перемещать нечего.");return;}setArranging(true);const revision=revisionRef.current;try{const next=await arrange();if(revisionRef.current!==revision)throw new Error("Карта изменилась. Повторите упорядочивание.");const items=[...[...next.areas].map(item=>({...item,kind:"area"})),...[...next.entities].map(item=>({...item,kind:"entity"}))].filter(item=>{const original=(item.kind==="area"?snapshot.areas:snapshot.entities).find(node=>node.id===item.id);return original&&!(Number.isFinite(original.x)&&Number.isFinite(original.y));}).map(({kind,id,x,y,width,height})=>({kind,id,x,y,...(kind==="area"?{width,height}:{})}));if(!items.length){toast("Все позиции закреплены вручную; перемещать нечего.");return;}const before=items.map(item=>{const node=nodes.find(node=>node.id===item.kind+":"+item.id);const rect=nodeRect(node);const original=(item.kind==="area"?snapshot.areas:snapshot.entities).find(value=>value.id===item.id);return {kind:item.kind,id:item.id,x:rect.x,y:rect.y,resetPosition:!Number.isFinite(original.x)||!Number.isFinite(original.y),...(item.kind==="area"?{width:rect.width,height:rect.height}:{})};});await enqueueMutation(()=>persistLayout(items,layoutExpectation(snapshot,items)));remember({type:"layout",label:"упорядочивание по потокам",before,after:items});toast("Незакреплённые элементы упорядочены по связям. Доступна отмена.");}catch(error){toast(error.message,true);}finally{setArranging(false);}};
  const showScenarioStep=(scenario,index)=>{
    const transition=scenario.transitions?.[index];const relation=snapshot.relations.find(item=>item.id===transition?.relationId);if(!relation)return;
    setActiveScenario(scenario);setScenarioStep(index);setOverviewTier(false);setSelectedArea("all");setContextOpen(false);
    setSelection({kind:"route",route:{id:`flow:${scenario.id}:${index}`,relations:[relation],source:`entity:${relation.from}`,target:`entity:${relation.to}`,label:relation.label,relationId:relation.id}});
    const pair=nodes.filter(node=>["entity:"+relation.from,"entity:"+relation.to].includes(node.id));
    if(pair.length)fitCamera({nodes:pair,padding:.3,minZoom:.55,maxZoom:1,duration:window.matchMedia("(prefers-reduced-motion: reduce)").matches?0:300});
  };
  const architectKey = architect?.finishedAt || architect?.startedAt;
  const showArchitect = architect && !["question","correction","probe"].includes(architect.kind) && architect.status !== "idle" && architectKey !== dismissedArchitect;
  const jobDisconnected = connection.status === "offline" || architect?.connectionLost;
  const notice=jobMessage(architect ? {...architect,connectionLost:jobDisconnected} : null,Boolean(snapshot.entities.length));
  const jobStats=jobStatistics(architect);

  return <div className={`app-shell ${!contextOpen && inspector ? "has-inspector" : ""} ${structureOpen ? "structure-open" : ""} ${historical?"is-historical":""} ${contextOpen?"context-open":""}`} data-checkpoint={snapshot._history?.id||"live"} data-revision={snapshot.revision} data-selection={selectionKey(selection)}>
    <header className="topbar"><div className="brand"><Icons.TreeStructureIcon size={26} aria-hidden="true"/><span><strong>Repo Canvas</strong><small>{snapshot.map?.projectTitle || "живая карта проекта"}</small></span></div><nav className="app-nav" aria-label="Разделы проекта">{[["map","Карта"],["flows","Сценарии"],["decisions","Решения"],["health","Состояние"],["settings","Настройки"]].map(([id,label])=><button key={id} aria-current={(id==="map"?(!contextOpen||!["flows","decisions","health","settings"].includes(contextTab)):contextOpen&&contextTab===id)?"page":undefined} onClick={()=>{rememberView();if(id==="map")setContextOpen(false);else{setContextTab(id);setContextOpen(true);}}}>{label}</button>)}</nav><div className="header-search"><Icons.MagnifyingGlassIcon size={18} aria-hidden="true"/><input ref={searchInput} aria-label="Поиск по проекту" placeholder="Найти в проекте…" value={searchQuery} onFocus={()=>setSearchOpen(true)} onChange={event=>{setSearchQuery(event.target.value);setSearchOpen(true);}} onKeyDown={event=>{if(event.key==="Enter"&&searchResults[0])activateSearchResult(searchResults[0]);if(event.key==="Escape"){setSearchOpen(false);setSearchQuery("");}}}/>{searchOpen&&searchQuery&&<div className="search-results">{searchResults.length ? searchResults.map(item=><button key={item.kind+":"+item.id} onClick={()=>activateSearchResult(item)}><strong>{item.label}</strong><small>{item.description}</small></button>):<p>Ничего не найдено</p>}</div>}</div><span className={"header-connection "+connection.status} title={connection.observer?.running?"Наблюдение включено":connection.error||"Локальный сервер"}><i/>{unauthorized?"Нет доступа":connection.status==="online"?"Онлайн":"Нет связи"}</span><IconButton className="theme-action" icon={theme==="dark"?Icons.SunIcon:Icons.MoonIcon} label={theme==="dark"?"Светлая тема":"Тёмная тема"} onClick={toggleTheme}/></header>
    <main className="workspace">{structureOpen&&<aside className="left-rail" aria-label="Структура проекта"><header className="structure-heading"><strong>Структура</strong><IconButton icon={Icons.XIcon} label="Закрыть структуру" onClick={()=>setStructureOpen(false)}/></header>
      <div className="rail-scroll">
        <section className="rail-section project-section"><header><b>ПРОЕКТ</b><span>{snapshot.entities.length}</span></header>{people.length > 0 && <div className="people-tree"><small>УЧАСТНИКИ</small>{people.map((person) => <button key={person.id} onClick={() => focusPerson(person)}><i></i><span>{person.ownerLabel || person.label}</span></button>)}</div>}<div className="project-tree">{tree.map(({ area, entities }) => <section className="tree-area" key={area.id}><header><button className={selectedArea === area.id ? "is-active" : ""} onClick={() => focusArea(area.id)}><i style={{ background: colors.get(area.id) }}></i><span><strong>{area.ownerTitle || area.title}</strong><small>{snapshot.entities.filter((item) => item.areaId === area.id).length} элементов</small></span></button><button className="tree-toggle" aria-label={collapsed.has(area.id) ? "Раскрыть область" : "Свернуть область"} onClick={() => setCollapsed((current) => { const next = new Set(current); if (next.has(area.id)) next.delete(area.id); else next.add(area.id); return next; })}>{collapsed.has(area.id) ? "›" : "⌄"}</button></header>{!collapsed.has(area.id) && <div className="tree-entities">{renderTreeEntities(entities)}</div>}</section>)}</div>{freeEntities.length>0&&<section className="tree-area"><header><strong>Вне областей</strong></header><div className="tree-entities">{renderTreeEntities(freeEntities)}</div></section>}</section>
        <section className="rail-section now-section"><header><b>{historical?"НА ЭТОТ МОМЕНТ":"СЕЙЧАС"}</b><span>{liveWork.length}</span></header><div className="now-list">{liveWork.length ? liveWork.map((work) => <button key={work.id} onClick={() => selectWork(work)} onDoubleClick={() => openWork(work)}><i className={work.status}></i><span><strong>{work.title}</strong><small>{work.actor || "agent"}</small></span></button>) : <p className="now-empty">Подтверждённой активной работы нет</p>}</div></section>
        <section className="rail-section latest-section"><header><b>ПОСЛЕДНЕЕ</b><span>{relativeTime(snapshot.updatedAt,historical?Date.parse(snapshot._history.at):now)}</span></header><div className="activity-list">{snapshot.activity.slice(0, 4).map((item) => <article key={item.id} className={item.level}><i></i><span><small>{relativeTime(item.ts,historical?Date.parse(snapshot._history.at):now)} · {item.actor}</small><p>{activityText(item)}</p></span></article>)}</div></section>
      </div>
    </aside>}<section className="canvas-shell" inert={window.innerWidth<760&&(contextOpen||(!activeScenario&&Boolean(inspector)))}><header className="canvas-header"><nav aria-label="Инструменты карты">
<Button className="structure-action" icon={Icons.FolderSimpleIcon} aria-label="Структура" title="Структура проекта" aria-expanded={structureOpen} onClick={()=>setStructureOpen(value=>!value)}>Структура<Icons.CaretDownIcon size={14}/></Button>
<Button variant="ghost" className="fit-map-action" aria-label="Показать всю карту" onClick={fitAll}>Вся карта</Button>
{selectedArea!=="all"&&<span className="map-area-label" title={areaMap.get(selectedArea)?.ownerTitle||areaMap.get(selectedArea)?.title}>{areaMap.get(selectedArea)?.ownerTitle||areaMap.get(selectedArea)?.title}</span>}
{showArchitect&&notice&&<ArchitectStatus job={architect} notice={notice} statistics={jobStats} disconnected={jobDisconnected} onAction={()=>notice.action==="settings"?(setContextTab("settings"),setContextOpen(true)):setRegenerate(architect.result?.issue?.code||"verification-failed")} onCancel={async()=>{try{const response=await api("/api/architect/cancel",{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"});if(!response.ok)throw new Error("Не удалось остановить обновление");setArchitect(await response.json());}catch(error){toast(error.message,true);}}} onDismiss={()=>setDismissedArchitect(architectKey)}/>}
<div className="map-edit-tools">
{<div className="map-zoom-controls" aria-label="Масштаб карты"><IconButton icon={Icons.MinusIcon} label="Отдалить карту" onClick={()=>flow.zoomOut({duration:180})}/><select aria-label="Масштаб карты" value={Math.round(viewport.zoom*100)} onChange={event=>flow.zoomTo(Number(event.target.value)/100,{duration:180})}>{[...new Set([10,25,40,55,75,100,130,170,Math.round(viewport.zoom*100)])].sort((a,b)=>a-b).map(value=><option key={value} value={value}>{value}%</option>)}</select><IconButton icon={Icons.PlusIcon} label="Приблизить карту" onClick={()=>flow.zoomIn({duration:180})}/></div>}
<details className="map-tools-menu"><summary aria-label="Дополнительные инструменты"><Icons.DotsThreeOutlineIcon size={20}/></summary><div onClick={event=>{if(event.target.closest('button'))event.currentTarget.parentElement.open=false;}}>
<Button variant="ghost" icon={Icons.InfoIcon} onClick={()=>{rememberView();setContextTab("overview");setContextOpen(true);}}>О проекте</Button>
<Button variant="ghost" icon={Icons.ArrowLeftIcon} disabled={!canGoBack} onClick={previousView}>Вернуться к предыдущему виду</Button>
<Button variant="ghost" icon={Icons.ArrowCounterClockwiseIcon} aria-label="Отменить · Ctrl+Z" disabled={historical||!historyState.undo} onClick={()=>runHistory("undo")}>Отменить</Button>
<Button variant="ghost" icon={Icons.ArrowClockwiseIcon} aria-label="Повторить · Ctrl+Y" disabled={historical||!historyState.redo} onClick={()=>runHistory("redo")}>Повторить</Button>
<Button variant="ghost" icon={Icons.ArrowClockwiseIcon} onClick={refreshSnapshot}>Обновить данные</Button>

<Button variant="ghost" disabled={historical||arranging} onClick={arrangeFlows}>{arranging?"Упорядочиваем…":"Упорядочить по потокам"}</Button>
<Button variant="ghost" aria-pressed={allConnections} onClick={()=>routes.length>60?fitAll():setAllConnections(value=>!value)}>{routes.length>60?"Обзор всех связей":allConnections?"Связи фокуса":"Все связи"}</Button>
<Button variant="ghost" icon={Icons.InfoIcon} onClick={()=>setLegend(value=>!value)}>Как читать карту</Button>
</div></details><Button className="regenerate-action" icon={Icons.TreeStructureIcon} title="Обновить карту" disabled={historical||architect?.running||jobDisconnected} onClick={()=>setRegenerate(true)}>{jobDisconnected?"Статус недоступен":architect?.running?"Обновляем карту…":snapshot.entities.length?"Обновить карту":"Построить карту"}</Button>
</div></nav>
</header>
      {sinceVisit.comparison&&<section className="visit-summary" role="status"><strong>Пока вас не было</strong><span>Модули: +{sinceVisit.comparison.added.filter(item=>item.kind==="entities").length} новых · {sinceVisit.comparison.changed.filter(item=>item.kind==="entities").length} изменено · {sinceVisit.comparison.removed.filter(item=>item.kind==="entities").length} удалено</span><button onClick={sinceVisit.markSeen}>Понятно</button></section>}
      {snapshot.storeErrors?.length>0&&<div className="store-warning" role="alert">Журнал проекта нужно восстановить. Показаны прочитанные данные; новые изменения защищены от записи. Попросите агента проверить журнал командой repo-canvas check и восстановить его через repo-canvas repair с резервной копией.</div>}
      <div className={`canvas-wrap tier-${activityTier} ${overview?"semantic-overview":""}`} data-route-count={overview?0:edges.length} data-view={overview?"overview":"modules"} data-routing-ready={routingReady} data-routing-run={recordedHistory?0:presentation.seq} data-interacting={interactionActive} data-resolution={viewport.zoom < .09 ? "tiny" : "normal"} ref={wrapper} onPointerMove={onCanvasPointerMove} onPointerDownCapture={clearReading} onPointerLeave={()=>{clearEdgeHover();clearReading();}} style={{"--canvas-zoom":viewport.zoom}}><div className="detail-canvas"><ReactFlow
        nodeDragThreshold={0} nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes}
        onNodesChange={onNodesChange} onNodeDragStart={onNodeDragStart} onNodeDrag={onNodeDrag} onNodeDragStop={onNodeDragStop}
        onEdgeClick={(event, edge) => { event.stopPropagation(); const id=hoveredRouteAt(liveRoutes,flow.screenToFlowPosition({x:event.clientX,y:event.clientY}),viewport.zoom);selectRoute(liveRoutes.find(route=>route.id===id)||edge.data?.route); }}
        onEdgeDoubleClick={(event, edge) => { event.stopPropagation(); if (edge.data?.route?.relationId) openEdit("relation", edge.data.route.relationId, edge.data.route.label, ""); }}
        onMoveStart={() => { clearEdgeHover(); setInteractionActive(true); }} onMoveEnd={settleViewport}
        onPaneClick={(event) => { if (!event.target?.classList?.contains("react-flow__pane")) return; clearEdgeHover(); setSelection(null); }}
        minZoom={.025} maxZoom={1.7} defaultViewport={{ x: 0, y: 0, zoom: .1 }} onlyRenderVisibleElements nodesFocusable={false} panOnDrag selectionOnDrag={false} nodesConnectable={false} edgesReconnectable={false} elevateNodesOnSelect={false} proOptions={{ hideAttribution: true }}
      >{overview&&<MapOverview snapshot={snapshot} rects={overviewRects} zoom={viewport.zoom} colors={colors} activity={activity} onArea={focusArea} onEntity={focusEntity}/>}</ReactFlow></div>
        {overview&&size.width<700&&snapshot.areas.length>1&&<nav className="overview-navigator" aria-label="Области на узком экране"><button aria-label="Предыдущая область" disabled={mobileArea===0} onClick={()=>fitOverview(mobileArea-1)}>←</button><span>Области · {mobileArea+1} из {snapshot.areas.length}</span><button aria-label="Следующая область" disabled={mobileArea===snapshot.areas.length-1} onClick={()=>fitOverview(mobileArea+1)}>→</button></nav>}
        {activeScenario&&<ScenarioLens scenario={activeScenario} snapshot={snapshot} index={scenarioStep} colors={colors} onInspect={entity=>{setActiveScenario(null);focusEntity(entity);}} onStep={index=>showScenarioStep(activeScenario,index)} onClose={()=>{setActiveScenario(null);setSelection(null);}}/>}
        {!snapshot.entities.length&&!snapshot._history&&<div className="empty-map"><h2>Соберите первую карту проекта</h2><p>Код и проектные диалоги помогут восстановить устройство и замысел.</p><button onClick={()=>setRegenerate(true)}>Построить первую карту</button></div>}{snapshot._history?.unavailable&&<div className="history-gap"><strong>В этот момент карта ещё не записывалась</strong><p>Коммит сохранился в Git. Геометрии и проверенного описания проекта для него нет.</p></div>}
        {routes.length>60&&!overview&&<span className="route-budget-note">Показано {edges.length} из {routes.length} связей · выберите модуль или сценарий</span>}
        {dropPreview && <i className="area-drop-preview" aria-hidden="true" style={{ left: dropPreview.rect.x * viewport.zoom + viewport.x, top: dropPreview.rect.y * viewport.zoom + viewport.y, width: dropPreview.rect.width * viewport.zoom, height: dropPreview.rect.height * viewport.zoom, "--area-color": dropPreview.color }}></i>}
        {readingPreview&&!interactionActive&&<aside className="reading-preview" style={{left:readingPreview.x,top:readingPreview.y}}><strong>{readingPreview.title}</strong><p>{readingPreview.body}</p></aside>}
        {!activeScenario&&offscreenChips.map((chip) => <button key={chip.id} type="button" className={`endpoint-chip ${chip.side}`} style={{ left: chip.x, top: chip.y }} aria-label={`${chip.label}. Перейти к связанному элементу`} onClick={() => { const target = nodes.find((node) => node.id === chip.id); if (target) fitCamera({ includeHiddenNodes:true, nodes: [target], padding: .55, duration: 380, maxZoom: .95 }); }}><span>{chip.label}</span></button>)}
        {legend && <aside className="legend"><header><span><small>ЛЕГЕНДА</small><strong>Как читать карту</strong></span><button aria-label="Закрыть подсказку" onClick={() => setLegend(false)}>×</button></header><p className="legend-color-rule">Линия наследует цвет области источника. Серый означает источник вне областей. Две стрелки показывают взаимообмен: у общей линии сохранены оба цвета, а каждая стрелка окрашена по отправителю своего направления.</p><div><p><i className="legend-person"></i><span><b>Внешний участник</b><small>Серый цвет исходящей связи означает, что узел находится вне областей</small></span></p><p><i className="legend-area"></i><span><b>Область проекта</b><small>крупная ответственность проекта; тянется только за заголовок</small></span></p><p><i className="legend-group"></i><span><b>Прозрачный контур</b><small>подсистема вокруг своих элементов; пустое место двигает камеру</small></span></p><p><i className="legend-route route-confirmed"></i><span><b>Подтверждённая связь</b><small>сплошная линия между существующими элементами проекта</small></span></p><p><i className="legend-route route-planned"></i><span><b>Запланированная связь</b><small>неподвижные штрихи на линии и рамке: эта часть системы ещё запланирована</small></span></p><p><i className="legend-route route-work-association"></i><span><b>Связь задачи с элементом</b><small>точечная линия показывает, к чему относится задача; план обозначен штрихами</small></span></p><p><i className="legend-pulse"></i><span><b>Сейчас в работе</b><small>пульсирующая точка и усиленный контур: вблизи — на элементах, издалека — на области. План и блокировка не пульсируют.</small></span></p><p><i aria-hidden="true">↔</i><span><b>Перемещение и поиск</b><small>Тяните пустое поле, чтобы двигать карту, карточку — чтобы переставить элемент. Размер области меняется за угол. Ctrl/Cmd+F открывает поиск.</small></span></p></div></aside>}
        </div>
      <ProjectTimeline timeline={timeline} api={api} toast={toast} architect={architect} setArchitect={setArchitect}/>
    </section>{!contextOpen&&!activeScenario&&inspector&&<aside className="selection-panel" aria-label="Сведения об элементе">{inspector}{selection?.kind!=="work"&&<footer><Button variant="primary" onClick={()=>{setContextTab("object");setContextOpen(true);requestAnimationFrame(()=>document.getElementById("map-correction")?.scrollIntoView({block:"start"}));}}>Уточнить смысл</Button><Button variant="link" icon={Icons.ArrowSquareOutIcon} onClick={()=>{setContextTab("object");setContextOpen(true);requestAnimationFrame(()=>document.querySelector(".evidence-section")?.scrollIntoView({block:"start"}));}}>Показать источники</Button></footer>}</aside>}<ProjectContext tab={contextTab} setTab={setContextTab} snapshot={snapshot} selection={selection} open={contextOpen} onClose={()=>{setContextOpen(false);if(window.innerWidth<760)setSelection(null);}} onRename={(kind,id,title,description)=>openEdit(kind==="route"?"relation":kind,id,title,description)} onSelect={focusEntity} onRelation={relationId=>selectRoute(selectedRoute,relationId)} onFlow={selected=>showScenarioStep(selected,0)} api={api} toast={toast} architect={architect} setArchitect={setArchitect} refresh={refreshSnapshot}/></main>
    <Dialog open={Boolean(edit)} title={edit?.kind==="relation"?"Подпись связи":"Название и описание"} onClose={()=>setEdit(null)}>{edit&&<form className="edit-map-form" onSubmit={saveEdit}><TextField label={edit.kind==="relation"?"Что делает эта связь":"Название"} autoFocus required maxLength={240} value={edit.title} onChange={event=>setEdit({...edit,title:event.target.value})}/>{edit.kind!=="relation"&&<TextField multiline label="Описание" maxLength={2000} value={edit.description} onChange={event=>setEdit({...edit,description:event.target.value})}/>}<footer><Button onClick={()=>setEdit(null)}>Отмена</Button><Button type="submit" variant="primary">Сохранить</Button></footer></form>}</Dialog>
    {regenerate && <ModelSetup api={api} building={!snapshot.entities.length} reason={typeof regenerate==="string"?regenerate:"manual"} onClose={()=>setRegenerate(false)} onStart={runRegenerate} viewpoint={viewpoint} onViewpoint={setViewpoint}/>}
  </div>;
}

const projectQueryClient=createProjectQueryClient();
function App() {
  const [unauthorized,setUnauthorized]=useState(false);
  const [toastState,setToast]=useState(null);
  const [theme,setTheme]=useState(()=>localStorage.getItem(THEME_KEY)||'light');
  const toastTimer=useRef(null);
  const toast=useCallback((message,error=false)=>{clearTimeout(toastTimer.current);setToast({message,error});toastTimer.current=setTimeout(()=>setToast(null),3600);},[]);
  useEffect(()=>()=>clearTimeout(toastTimer.current),[]);
  const {snapshot,setSnapshot,connection,architect,setArchitect,update,setUpdate}=useProjectData(api,toast,unauthorized,setUnauthorized);
  const timeline=useProjectHistory(snapshot,api,toast,architect);
  useLayoutEffect(()=>{document.documentElement.classList.add('rc-system');document.documentElement.dataset.theme=theme;document.documentElement.dataset.rcTheme=theme;localStorage.setItem(THEME_KEY,theme);},[theme]);
  useEffect(()=>{const handler=event=>{if(event.key===TOKEN_KEY&&event.newValue){apiToken=event.newValue;projectQueryClient.clear();setUnauthorized(false);}};addEventListener('storage',handler);return()=>removeEventListener('storage',handler);},[]);
  async function applyUpdate(){try{const response=await api('/api/update/apply',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});const state=await response.json();if(!response.ok)throw new Error(state.error);setUpdate(state);toast('Обновление устанавливается. Canvas перезапустится сам.');}catch(error){toast(error.message,true);}}
  if (unauthorized) return <main className="access-state"><small>НУЖНА СВЯЗЬ С ЛОКАЛЬНЫМ CANVAS</small><h1>Эта вкладка потеряла доступ</h1><p>Обновите страницу, чтобы восстановить локальную сессию.</p><button onClick={() => location.reload()}>Обновить страницу</button></main>;
  if (!snapshot) return <main className="loading" role="status"><i></i><h1>{connection.status === "offline" ? "Нет связи с локальным сервером" : "Открываем карту проекта"}</h1><p>{connection.error || "Загружаем сохранённое состояние."}</p>{connection.status === "offline" && <button onClick={() => location.reload()}>Повторить сейчас</button>}</main>;
  return <ReactFlowProvider><Canvas timeline={timeline} snapshot={timeline.snapshot} setSnapshot={setSnapshot} toast={toast} unauthorized={unauthorized} connection={connection} theme={theme} toggleTheme={() => setTheme((current) => current === "dark" ? "light" : "dark")} architect={architect} setArchitect={setArchitect} />{update && ["available", "failed", "applying"].includes(update.status) && <button className="update-button" onClick={applyUpdate} disabled={update.status === "applying"}><small>ДОСТУПНО ОБНОВЛЕНИЕ</small><strong>{update.status === "applying" ? "Устанавливается…" : `Установить v${update.availableVersion || ""}`}</strong></button>}{toastState && <div role={toastState.error?"alert":"status"} className={`toast ${toastState.error ? "error" : ""}`}>{toastState.message}</div>}</ReactFlowProvider>;
}

createRoot(document.getElementById("root")).render(<QueryClientProvider client={projectQueryClient}><App /></QueryClientProvider>);
