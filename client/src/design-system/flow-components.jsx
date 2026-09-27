import React from "react";
import { BaseEdge, Handle, Position, getSmoothStepPath, useStore } from "@xyflow/react";
import { ConnectionMarkers, connectionMarkerId } from "./connection-markers.jsx";
import "@xyflow/react/dist/style.css";
import "./flow-components.css";
import { ModuleCard } from "./components.jsx";
import { AREA_TOKENS, NEUTRAL_EDGE, roundedRoute } from "./graph-theme.js";
import { CodeIcon, ChatCircleIcon, TreeStructureIcon, FileMagnifyingGlassIcon, ListChecksIcon, MapTrifoldIcon, ClockIcon, UserIcon } from "./icons.jsx";

export const moduleIcons = { code: CodeIcon, chat: ChatCircleIcon, tree: TreeStructureIcon, verify: FileMagnifyingGlassIcon, list: ListChecksIcon, map: MapTrifoldIcon, clock: ClockIcon, user: UserIcon };
const positions = { left: Position.Left, right: Position.Right, top: Position.Top, bottom: Position.Bottom };

export function CanvasModule({ data, selected }) {
  const color = AREA_TOKENS[data.colorKey] || NEUTRAL_EDGE;
  return <div className="rc-flow-module" style={{ "--rc-port-color": color }}>
    <ModuleCard title={data.title} description={data.description} selected={selected} status={data.status} icon={moduleIcons[data.icon]} />
    {(data.ports || []).map(port => {
      const [type, side] = port.split("-");
      return <Handle key={port} id={port} type={type} position={positions[side]} isConnectable={false} className="rc-handle" style={port.endsWith("neutral") ? { top: "75%" } : undefined} />;
    })}
  </div>;
}

export function CanvasArea({ data }) {
  return <section className="rc-flow-area" style={{ "--rc-area-color": AREA_TOKENS[data.colorKey] }}>
    <header><span aria-hidden="true" /><div><h3 aria-label={data.title}><span className="rc-area-title">{data.title}</span><span className="rc-area-title-short" aria-hidden="true">{data.shortTitle || data.title}</span></h3><p>{data.description}</p></div></header>
  </section>;
}

export function AreaEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, markerStart, data, selected }) {
  const zoom=useStore(state=>state.transform[2]);
  const key=connectionMarkerId(id),bidirectional=Boolean(markerStart);
  let points = data.points;
  if (!points && data.route === "outside-group") points = [
    { x: sourceX, y: sourceY }, { x: sourceX, y: sourceY + 65 },
    { x: targetX - 44, y: sourceY + 65 }, { x: targetX - 44, y: targetY }, { x: targetX, y: targetY },
  ];
  // Sample-specific corridor. Production callers pass obstacle-aware data.points.
  if (!points && data.route === "top-corridor") points = [
    { x: sourceX, y: sourceY }, { x: 308, y: sourceY },
    { x: 308, y: 178 }, { x: targetX, y: 178 }, { x: targetX, y: targetY },
  ];
  const path = points ? roundedRoute(points) : getSmoothStepPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, borderRadius: 16, offset: 24 })[0];
  return <><title>{data.description}</title><ConnectionMarkers id={id} color={data.color} bidirectional={bidirectional} zoom={zoom} strokeWidth={selected?2.6:1.8}/><BaseEdge id={id} path={path} markerStart={bidirectional?`url(#${key}-start)`:undefined} markerEnd={markerEnd?`url(#${key}-end)`:undefined} interactionWidth={24} style={{ stroke:data.color,strokeWidth:(selected?2.6:1.8)/zoom,vectorEffect:"none" }} className="rc-flow-edge" /></>;
}

export const canvasNodeTypes = { rcModule: CanvasModule, rcArea: CanvasArea };
export const canvasEdgeTypes = { rcAreaEdge: AreaEdge };
