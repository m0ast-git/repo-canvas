import { AREA_HEADER_HEIGHT } from "./node-geometry.js";

export const DROP_GAP = 24;
export const MAGNET_SCREEN_PX = 6;
export const CAPTURE_RATIO = .18;
export const RELEASE_RATIO = .08;

export function nodeRect(node) {
  return {
    x: Number(node?.position?.x || 0),
    y: Number(node?.position?.y || 0),
    width: Math.max(0, Number(node?.width ?? node?.style?.width ?? 0)),
    height: Math.max(0, Number(node?.height ?? node?.style?.height ?? 0)),
  };
}

export function groupContourRect(node) {
  const rect = nodeRect(node);
  const contour = node?.data?.contour;
  if (!contour) return rect;
  return {
    x: rect.x + Number(contour.left || 0),
    y: rect.y + Number(contour.top || 0),
    width: Math.max(0, Number(contour.width || rect.width)),
    height: Math.max(0, Number(contour.height || rect.height)),
  };
}

export function groupHeaderRect(node) {
  const rect = groupContourRect(node);
  return {
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: Math.max(0, Number(node?.data?.headerHeight || 76)),
  };
}

export function translateRect(rect, dx, dy) {
  return { ...rect, x: rect.x + dx, y: rect.y + dy };
}

export function boundingRect(rects) {
  if (!rects.length) return { x: 0, y: 0, width: 0, height: 0 };
  const left = Math.min(...rects.map((rect) => rect.x));
  const top = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function intersectionArea(a, b) {
  const width = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const height = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return width * height;
}

export function overlapRatio(rect, container) {
  const area = Math.max(1, rect.width * rect.height);
  return intersectionArea(rect, container) / area;
}

export function containsRect(container, rect) {
  return rect.x >= container.x && rect.y >= container.y
    && rect.x + rect.width <= container.x + container.width
    && rect.y + rect.height <= container.y + container.height;
}

export function magneticTranslation(rawTranslation, sourceBounds, originRect, zoom = 1) {
  if (!originRect) return { ...rawTranslation, resisted: false, detached: true };
  const moved = translateRect(sourceBounds, rawTranslation.dx, rawTranslation.dy);
  const overlap = intersectionArea(moved, originRect);
  if (overlap <= 0) return { ...rawTranslation, resisted: false, detached: true };
  if (containsRect(originRect, moved)) return { ...rawTranslation, resisted: false, detached: false };

  const movedCenter = { x: moved.x + moved.width / 2, y: moved.y + moved.height / 2 };
  const originCenter = { x: originRect.x + originRect.width / 2, y: originRect.y + originRect.height / 2 };
  const vx = originCenter.x - movedCenter.x; const vy = originCenter.y - movedCenter.y;
  const length = Math.hypot(vx, vy) || 1;
  const strength = MAGNET_SCREEN_PX / Math.max(.025, zoom);
  return {
    dx: rawTranslation.dx + vx / length * strength,
    dy: rawTranslation.dy + vy / length * strength,
    resisted: true,
    detached: false,
  };
}

export function pickDropContainer(movedBounds, containers, previousId = null) {
  const scored = containers.map((container) => ({
    ...container,
    ratio: overlapRatio(movedBounds, container.rect),
  })).filter((container) => container.ratio > 0)
    .sort((a, b) => Number(b.depth ?? -1) - Number(a.depth ?? -1) || b.ratio - a.ratio || a.id.localeCompare(b.id));
  const previous = previousId ? scored.find((container) => container.id === previousId) : null;
  const captured = scored.find((container) => container.ratio >= CAPTURE_RATIO);
  if (previous && previous.ratio >= RELEASE_RATIO && (!captured || (previous.depth ?? -1) >= (captured.depth ?? -1))) return previous;
  return captured || null;
}

export function expandedRect(rect, gap) {
  return { x: rect.x - gap, y: rect.y - gap, width: rect.width + gap * 2, height: rect.height + gap * 2 };
}

function collidingObstacle(rect, obstacles, gap) {
  return obstacles
    .map((obstacle) => ({ obstacle, area: intersectionArea(rect, expandedRect(obstacle, gap)) }))
    .filter((entry) => entry.area > 0)
    .sort((a, b) => b.area - a.area)[0]?.obstacle || null;
}

function positionKey(position) {
  return `${Math.round(position.x * 10)}:${Math.round(position.y * 10)}`;
}

export function nearestFreeTranslation(sourceBounds, desiredTranslation, obstacles, gap = DROP_GAP) {
  if (!obstacles.length) return { ...desiredTranslation, adjusted: false };
  const desired = { x: sourceBounds.x + desiredTranslation.dx, y: sourceBounds.y + desiredTranslation.dy };
  const queue = [{ ...desired, distance: 0 }]; const visited = new Set();
  let attempts = 0;
  while (queue.length && attempts < 1200) {
    queue.sort((a, b) => a.distance - b.distance);
    const candidate = queue.shift(); const key = positionKey(candidate);
    if (visited.has(key)) continue;
    visited.add(key); attempts += 1;
    const rect = { ...sourceBounds, x: candidate.x, y: candidate.y };
    const collision = collidingObstacle(rect, obstacles, gap);
    if (!collision) {
      return {
        dx: candidate.x - sourceBounds.x,
        dy: candidate.y - sourceBounds.y,
        adjusted: Math.abs(candidate.x - desired.x) > .01 || Math.abs(candidate.y - desired.y) > .01,
      };
    }
    const positions = [
      { x: collision.x - gap - sourceBounds.width, y: candidate.y },
      { x: collision.x + collision.width + gap, y: candidate.y },
      { x: candidate.x, y: collision.y - gap - sourceBounds.height },
      { x: candidate.x, y: collision.y + collision.height + gap },
    ];
    for (const position of positions) {
      const dx = position.x - desired.x; const dy = position.y - desired.y;
      queue.push({ ...position, distance: dx * dx + dy * dy });
    }
  }
  const exits=[
    {x:Math.min(...obstacles.map(rect=>rect.x))-gap-sourceBounds.width,y:desired.y},
    {x:Math.max(...obstacles.map(rect=>rect.x+rect.width))+gap,y:desired.y},
    {x:desired.x,y:Math.min(...obstacles.map(rect=>rect.y))-gap-sourceBounds.height},
    {x:desired.x,y:Math.max(...obstacles.map(rect=>rect.y+rect.height))+gap},
  ].sort((a,b)=>Math.hypot(a.x-desired.x,a.y-desired.y)-Math.hypot(b.x-desired.x,b.y-desired.y));
  return {dx:exits[0].x-sourceBounds.x,dy:exits[0].y-sourceBounds.y,adjusted:true,unresolved:false};
}

export function dropObstacle(node) {
  if (node.type === "area") {
    const rect = nodeRect(node);
    return { x: rect.x + 18, y: rect.y + 14, width: Math.max(0, rect.width - 36), height: AREA_HEADER_HEIGHT - 20 };
  }
  if (node.type === "group") return groupHeaderRect(node);
  return nodeRect(node);
}

function compactPoints(points) {
  return points.filter((point, index) => index === 0 || Math.abs(point.x - points[index - 1].x) > .01 || Math.abs(point.y - points[index - 1].y) > .01);
}

export function followRouteDuringDrag(route, sourceBase, targetBase, sourceCurrent, targetCurrent) {
  if (!route?.points?.length || !sourceBase || !targetBase || !sourceCurrent || !targetCurrent) return route;
  const sourceDelta = { x: sourceCurrent.x - sourceBase.x, y: sourceCurrent.y - sourceBase.y };
  const targetDelta = { x: targetCurrent.x - targetBase.x, y: targetCurrent.y - targetBase.y };
  if (![sourceDelta.x, sourceDelta.y, targetDelta.x, targetDelta.y].some((value) => Math.abs(value) > .01)) return route;
  if (Math.abs(sourceDelta.x - targetDelta.x) < .01 && Math.abs(sourceDelta.y - targetDelta.y) < .01) {
    return { ...route, points: route.points.map((point) => ({ x: point.x + sourceDelta.x, y: point.y + sourceDelta.y })) };
  }
  const start = { x: route.points[0].x + sourceDelta.x, y: route.points[0].y + sourceDelta.y };
  const end = { x: route.points.at(-1).x + targetDelta.x, y: route.points.at(-1).y + targetDelta.y };
  const horizontal = Math.abs(end.x - start.x) >= Math.abs(end.y - start.y);
  const points = horizontal
    ? [start, { x: (start.x + end.x) / 2, y: start.y }, { x: (start.x + end.x) / 2, y: end.y }, end]
    : [start, { x: start.x, y: (start.y + end.y) / 2 }, { x: end.x, y: (start.y + end.y) / 2 }, end];
  return { ...route, points: compactPoints(points) };
}
