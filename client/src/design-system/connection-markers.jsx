import React from "react";

export function connectionMarkerId(id) {
  return "connection-" + encodeURIComponent(id).replace(/%/g,"_");
}

// Filled tips share the shaft's endpoint and tangent. Their size is constrained
// by the straight approach, so a marker cannot swallow the preceding bend.
export function ConnectionMarkers({ id, color, reverseColor=color, bidirectional=false, zoom=1, strokeWidth=1.8, size=8 }) {
  const key=connectionMarkerId(id);
  const marker=(end,ink)=><marker id={`${key}-${end}`} markerUnits="userSpaceOnUse" markerWidth={size/zoom} markerHeight={size/zoom} viewBox="0 -4 8 8" refX="8" refY="0" orient="auto-start-reverse" overflow="visible"><path d="M 0 -3.5 L 8 0 L 0 3.5 Z" fill={ink} stroke="none"/></marker>;
  return <defs>{marker("end",color)}{bidirectional&&marker("start",reverseColor)}</defs>;
}
