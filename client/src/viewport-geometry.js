export const NODE_READABLE_ZOOM = .5;

export function settleViewportTransform(next, size, anchor, pixelRatio = 1) {
  const zoom = Math.max(.025, Math.min(1.7, next.zoom));
  const focus = anchor || { x: size.width / 2, y: size.height / 2 };
  const world = {
    x: (focus.x - next.x) / next.zoom,
    y: (focus.y - next.y) / next.zoom,
  };
  return {
    x: Math.round((focus.x - world.x * zoom) * pixelRatio) / pixelRatio,
    y: Math.round((focus.y - world.y * zoom) * pixelRatio) / pixelRatio,
    zoom,
  };
}
