// Detail depends on the projected card size, never on a different layout.
// The same bounds, IDs and ports survive every threshold.
export function canvasDetail(rect, zoom) {
  const width = Math.max(0, rect.width * zoom);
  const height = Math.max(0, (rect.headerHeight || rect.height) * zoom);
  if (width >= 240 && height >= 110) return "full";
  if (width >= 180 && height >= 88) return "preview";
  if (width >= 84 && height >= 60) return "compact";
  if (width >= 54 && height >= 28) return "label";
  return "silhouette";
}

export function detailSignature(rects, zoom) {
  return rects.map(rect => canvasDetail(rect, zoom)).join("|");
}

export function workDetail(rect, zoom) {
  if(rect.width*zoom>=216&&rect.height*zoom>=72)return "full";
  if(rect.width*zoom>=96&&rect.height*zoom>=32)return "compact";
  return "silhouette";
}
