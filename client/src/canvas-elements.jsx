import React, {memo} from "react";
import {BaseEdge,EdgeLabelRenderer,Handle,NodeResizeControl,Position} from "@xyflow/react";
import * as Icons from "./design-system/icons.jsx";
import {StatusBadge} from "./design-system/components.jsx";
import {componentStatus} from "./design-system/project-theme.js";
import {CanvasCard,WorkActivity} from "./canvas-card.jsx";
import {roundedRoute as routePath,routeInk} from "./design-system/graph-theme.js";
import {ConnectionMarkers,connectionMarkerId} from "./design-system/connection-markers.jsx";
const entityIcons = { module: Icons.CodeIcon, service: Icons.TreeStructureIcon, process: Icons.ListChecksIcon, store: Icons.FileTextIcon, interface: Icons.MapTrifoldIcon, integration: Icons.ArrowSquareOutIcon, external: Icons.ArrowSquareOutIcon, component: Icons.CodeIcon, person: Icons.UserIcon };

const selectWithKeyboard = (event, action) => { if (["Enter", " "].includes(event.key)) { event.preventDefault(); event.stopPropagation(); action(); } };

const HiddenHandles = () => <><Handle type="target" position={Position.Left} className="hidden-handle" /><Handle type="source" position={Position.Right} className="hidden-handle" /></>;

const AreaNode = memo(({ data }) => <section data-status={data.status} className={`area-node ${data.distant ? "is-distant" : ""} ${data.activeCount ? "is-active" : ""} ${data.muted ? "is-muted" : ""} ${data.focused ? "is-focus-node" : ""} ${data.focusDim ? "is-focus-dim" : ""} ${data.dragTarget ? "is-drop-target" : ""} ${data.selected ? "is-selected" : ""}`} style={{ "--area-color": data.color, "--area-stroke-scale": data.labelScale || 1 }}>
  <HiddenHandles />
  <header className="graph-item-body" role="button" tabIndex={0} onKeyDown={event=>selectWithKeyboard(event,()=>data.select(data.area))} aria-label={`${data.title}. ${data.status === "planned" ? "Запланировано. " : ""}Перетащите область; двойной клик изменяет текст`} onClick={(event) => { event.stopPropagation(); data.select(data.area); }} onDoubleClick={(event) => { event.stopPropagation(); data.edit("area", data.area.id, data.title, data.description); }} style={{ width: data.areaWidth-36 }}><span className="area-color-dot" aria-hidden="true"/><h2>{data.title}</h2><p>{data.description}</p></header>
  {data.activeCount > 0 && <WorkActivity count={data.activeCount} pulsing={data.pulsing}/>}
  {!data.readOnly && <NodeResizeControl position="bottom-right" className="area-resize-control nodrag nopan" minWidth={data.contentWidth} minHeight={data.contentHeight} onResizeStart={(_, params) => data.resizeStart(data.area, params)} onResizeEnd={(_, params) => data.resizeEnd(data.area, params)}><span aria-hidden="true"></span></NodeResizeControl>}
</section>);

const GroupNode = memo(({ data }) => <section data-detail={data.detail} data-status={componentStatus(data.entity.status)} className={`group-node ${data.selected ? "is-selected" : ""} ${data.activeCount ? "is-active" : ""} ${data.muted ? "is-muted" : ""} ${data.dragTarget ? "is-drop-target" : ""} ${data.focused ? "is-focus-node" : ""} ${data.focusDim ? "is-focus-dim" : ""}`} style={{ "--area-color": data.color }}>
  <HiddenHandles />
  <i className="group-contour" aria-hidden="true" style={{ left: data.contour?.left || 0, top: data.contour?.top || 0, width: data.contour?.width || "100%", height: data.contour?.height || "100%" }}></i>
  <header className="graph-item-body" role="button" tabIndex={0} onKeyDown={event=>selectWithKeyboard(event,()=>data.select(data.entity))} style={{ left: data.contour?.left || 0, top: data.contour?.top || 0, width: data.contour?.width || "100%", minHeight: data.headerHeight }} onClick={(event) => { event.stopPropagation(); data.select(data.entity); }} onDoubleClick={(event) => { event.stopPropagation(); data.edit("entity", data.entity.id, data.label, data.description); }} aria-label={`${data.label}. Перетащите блок и его содержимое; двойной клик изменяет текст`}>
    <span className="area-color-dot" aria-hidden="true"/><strong>{data.label}</strong><p>{data.description}</p>
    {data.activeCount > 0 && <WorkActivity count={data.activeCount} pulsing={data.pulsing}/>}
  </header>
</section>);

const EntityNode = memo(({ data }) => <article className={`entity-node graph-item-body ${data.status || "operational"} ${data.activeCount ? "is-active" : ""} ${data.muted ? "is-muted" : ""} ${data.focused ? "is-focus-node" : ""} ${data.focusDim ? "is-focus-dim" : ""}`} style={{ "--area-color": data.color }} role="button" tabIndex={0} onKeyDown={event=>selectWithKeyboard(event,()=>data.select(data.entity))} onClick={(event) => { event.stopPropagation(); data.select(data.entity); }} onDoubleClick={(event) => { event.stopPropagation(); data.edit("entity", data.entity.id, data.label, data.description); }} aria-label={`${data.label}. Перетащите элемент; двойной клик изменяет текст`}>
  <HiddenHandles />
  {data.stepNumber&&<span className="scenario-step-number">{data.stepNumber}</span>}<CanvasCard title={data.label} description={data.description} icon={entityIcons[data.entity.kind] || Icons.CodeIcon} kindLabel={({service:"Сервис",store:"Хранилище",database:"Хранилище",module:"Модуль",external:"Внешняя система",component:"Компонент"})[data.entity.kind]||"Компонент"} selected={data.selected} status={componentStatus(data.status)} detail={data.detail} activeCount={data.activeCount}/>{data.activeCount > 0 && <WorkActivity count={data.activeCount} pulsing={data.pulsing}/>}
</article>);

const PersonNode = memo(({ data }) => <button className={`person-node graph-item-body ${data.muted ? "is-muted" : ""} ${data.focused ? "is-focus-node" : ""} ${data.focusDim ? "is-focus-dim" : ""}`} style={{ "--area-color": data.color }} type="button" onClick={(event) => { event.stopPropagation(); data.select(data.entity); }} onDoubleClick={(event) => { event.stopPropagation(); data.edit("entity", data.entity.id, data.label, data.description); }} aria-label={`${data.label}. Участник продукта`}>
  <HiddenHandles /><CanvasCard title={data.label} description={data.description} icon={Icons.UserIcon} selected={data.selected} detail={data.detail}/>
</button>);

const WorkNode = memo(({ data }) => <button data-detail={data.detail} className={`work-node graph-item-body ${data.selected ? "is-selected" : ""} tier-${data.tier} ${data.work.status} ${data.work.provisional ? "provisional" : ""} ${data.focused ? "is-focus-node" : ""} ${data.focusDim ? "is-focus-dim" : ""}`} style={{ "--area-color": data.color }} type="button" onClick={(event) => { event.stopPropagation(); data.select(data.work); }} aria-label={`${data.work.title}. ${data.work.actor || "agent"}. ${data.work.status}`} onDoubleClick={(event) => { event.stopPropagation(); data.open(data.work); }}>
  <HiddenHandles />{data.detail === "silhouette" ? <i className="work-signal" aria-hidden="true"/> : <>{data.detail === "full" && <Icons.ListChecksIcon size={22} aria-hidden="true"/>}<span>{data.detail === "full" && <small>{data.work.actor || "agent"}</small>}<strong>{data.work.title}</strong>{data.detail === "full" && <StatusBadge status={componentStatus(data.work.status)} />}</span></>}{data.work.status === "active" && <WorkActivity pulsing={data.pulsing}/>}
</button>);

const RoutedEdge = memo(({ id, data }) => {
  if(!data.route.points?.length)return <g data-blocked-route={id}><title>{data.route.label}</title></g>;
  const path = routePath(data.route.points, 32); const placement = data.placement;
  const ink = routeInk(data.route.points,data.zoom||1,data.active);
  const showLabel = placement?.safe && (data.labelActive || data.persistentLabel);
  const bundled = (data.route.relations || []).length > 1;
  const visualKind = data.route.visualKind;
  const baseOpacity = data.hidden ? 0 : data.muted ? .32 : 1;
  const gradientId = "exchange-" + id.replace(/[^a-zA-Z0-9_-]/g, character => character.charCodeAt(0).toString(16));
  const mixed = data.route.bidirectional && data.route.color !== data.route.reverseColor;
  const first = data.route.points[0], last = data.route.points.at(-1);
  const markerId=connectionMarkerId(id);
  return <>
    <ConnectionMarkers id={id} color={data.route.color} reverseColor={data.route.reverseColor} bidirectional={data.route.bidirectional} zoom={data.zoom||1} strokeWidth={ink.width} size={ink.arrow}/>
    {mixed && <defs><linearGradient id={gradientId} gradientUnits="userSpaceOnUse" x1={first.x} y1={first.y} x2={last.x} y2={last.y}><stop offset="0%" stopColor={data.route.reverseColor}/><stop offset="46%" stopColor={data.route.reverseColor}/><stop offset="54%" stopColor={data.route.color}/><stop offset="100%" stopColor={data.route.color}/></linearGradient></defs>}
    <g data-route-source={data.route.source} data-route-target={data.route.target}><BaseEdge id={id} path={path} markerStart={data.route.bidirectional?`url(#${markerId}-start)`:undefined} markerEnd={["relation","area-relation"].includes(data.route.type)?`url(#${markerId}-end)`:undefined} interactionWidth={16/(data.zoom||1)} style={{ strokeWidth:ink.width/(data.zoom||1), stroke: mixed ? `url(#${gradientId})` : data.route.color, opacity: baseOpacity }} className={`route-path route-${visualKind} route-type-${data.route.type} ${data.active ? "is-active" : ""}`} /></g>
    {showLabel && <EdgeLabelRenderer><button type="button" className={`route-label nodrag nopan ${bundled ? "is-bundle" : ""} ${data.pinned ? "is-pinned" : ""} ${data.interactionActive ? "is-interaction-hidden" : ""}`} style={{ left: placement.x, top: placement.y, width: placement.width, height: placement.height, "--label-scale": placement.scale, "--edge-color": data.route.color, opacity: data.interactionActive ? 0 : 1 }} aria-hidden={data.interactionActive ? "true" : undefined} tabIndex={data.interactionActive ? -1 : 0} aria-label={bundled ? `${data.route.relations.length} связей. Нажмите, чтобы раскрыть` : `${data.route.label}. Двойной клик изменяет подпись`} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); data.selectRoute(data.route); }} onMouseEnter={() => data.keepHover(id)} onMouseLeave={data.leaveHover} onDoubleClick={(event) => { event.stopPropagation(); if (data.route.relationId) data.edit("relation", data.route.relationId, data.route.label, ""); }}>{data.route.label}</button></EdgeLabelRenderer>}
  </>;
});

export const nodeTypes = { area: AreaNode, group: GroupNode, entity: EntityNode, person: PersonNode, work: WorkNode };
export const edgeTypes = { routed: RoutedEdge };
