import { NODE_READABLE_ZOOM } from "./viewport-geometry.js";

export function rectanglesOverlap(a, b, gap = 0) {
  return a.x - gap < b.x + b.width
    && a.x + a.width + gap > b.x
    && a.y - gap < b.y + b.height
    && a.y + a.height + gap > b.y;
}

export const ROUTE_LABEL_FONT_SIZE = 12;

export function routeLabelScale(zoom, overview = false) {
  const safeZoom = Math.max(.025, Number(zoom || 0));
  return overview ? Math.min(24, 1 / safeZoom) : 1;
}

function labelCandidates(points, width) {
  const candidates = [];
  for (let index = 1; index < points.length; index += 1) {
    const from = points[index - 1];
    const to = points[index];
    const length = Math.hypot(to.x - from.x, to.y - from.y);
    const vertical = Math.abs(to.y - from.y) > Math.abs(to.x - from.x);
    if (length < (vertical ? 54 : width + 30)) continue;
    for (const fraction of [.5, .34, .66, .2, .8]) {
      candidates.push({
        x: from.x + (to.x - from.x) * fraction,
        y: from.y + (to.y - from.y) * fraction,
        score: Math.abs(fraction - .5) + index / points.length * .05,
      });
    }
  }
  return candidates.sort((a, b) => a.score - b.score);
}

export function placeRouteLabels(routes, viewport, size, obstacles) {
  if (!size.width || !viewport.zoom) return new Map();
  const visible = {
    x: -viewport.x / viewport.zoom,
    y: -viewport.y / viewport.zoom,
    width: size.width / viewport.zoom,
    height: size.height / viewport.zoom,
  };
  const occupied = [];
  const result = new Map();

  for (const route of routes.filter((item) => item.label)) {
    const overview = viewport.zoom < NODE_READABLE_ZOOM && ["area-relation", "trunk"].includes(route.type);
    const width = Math.min(280, Math.max(80, route.label.length * 7.2 + 20));
    const height = 26;
    const scale = Math.min(routeLabelScale(viewport.zoom, overview), route.maxLabelScale || Infinity);
    if (viewport.zoom * scale * ROUTE_LABEL_FONT_SIZE < 10.5) continue;
    const visualWidth = width * scale;
    const visualHeight = height * scale;
    const point = labelCandidates(route.points, visualWidth).find((candidate) => {
      const box = {
        x: candidate.x - visualWidth / 2,
        y: candidate.y - visualHeight / 2,
        width: visualWidth,
        height: visualHeight,
      };
      const margin = 16 / viewport.zoom;
      const inside = box.x >= visible.x + margin
        && box.y >= visible.y + margin
        && box.x + box.width <= visible.x + visible.width - margin
        && box.y + box.height <= visible.y + visible.height - margin;
      return inside
        && !obstacles.some((item) => rectanglesOverlap(box, item, 12 / viewport.zoom))
        && !occupied.some((item) => rectanglesOverlap(box, item, 16 / viewport.zoom));
    });

    if (!point) continue;
    const box = {
      x: point.x - visualWidth / 2,
      y: point.y - visualHeight / 2,
      width: visualWidth,
      height: visualHeight,
    };
    occupied.push(box);
    result.set(route.id, { ...point, width, height, scale, safe: true });
  }
  return result;
}
