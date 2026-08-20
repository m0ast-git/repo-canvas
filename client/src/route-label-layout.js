export function rectanglesOverlap(a, b, gap = 0) {
  return a.x - gap < b.x + b.width
    && a.x + a.width + gap > b.x
    && a.y - gap < b.y + b.height
    && a.y + a.height + gap > b.y;
}

export function routeLabelScale(zoom) {
  const safeZoom = Math.max(.025, Number(zoom || 0));
  return Math.min(1.45, Math.max(1, 1 / safeZoom));
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
    const width = Math.min(200, Math.max(72, route.label.length * 5.2 + 20));
    const height = 24;
    const scale = routeLabelScale(viewport.zoom);
    const visualWidth = width * scale;
    const visualHeight = height * scale;
    let safe = true;
    let point = labelCandidates(route.points, visualWidth).find((candidate) => {
      const box = {
        x: candidate.x - visualWidth / 2,
        y: candidate.y - visualHeight / 2,
        width: visualWidth,
        height: visualHeight,
      };
      const margin = 8 / viewport.zoom;
      const inside = box.x >= visible.x + margin
        && box.y >= visible.y + margin
        && box.x + box.width <= visible.x + visible.width - margin
        && box.y + box.height <= visible.y + visible.height - margin;
      return inside
        && !obstacles.some((item) => rectanglesOverlap(box, item, 5))
        && !occupied.some((item) => rectanglesOverlap(box, item, 10));
    });

    if (!point) {
      safe = false;
      const segments = route.points.slice(1).map((to, index) => ({
        from: route.points[index],
        to,
        length: Math.hypot(to.x - route.points[index].x, to.y - route.points[index].y),
      })).sort((a, b) => b.length - a.length);
      point = segments
        .flatMap((segment) => [.5, .25, .75].map((fraction) => ({
          x: segment.from.x + (segment.to.x - segment.from.x) * fraction,
          y: segment.from.y + (segment.to.y - segment.from.y) * fraction,
        })))
        .find((candidate) => candidate.x >= visible.x
          && candidate.y >= visible.y
          && candidate.x <= visible.x + visible.width
          && candidate.y <= visible.y + visible.height);
      if (!point && segments[0]) {
        point = {
          x: (segments[0].from.x + segments[0].to.x) / 2,
          y: (segments[0].from.y + segments[0].to.y) / 2,
        };
      }
    }

    if (!point) continue;
    const box = {
      x: point.x - visualWidth / 2,
      y: point.y - visualHeight / 2,
      width: visualWidth,
      height: visualHeight,
    };
    if (safe) occupied.push(box);
    result.set(route.id, { ...point, width, height, scale, safe });
  }
  return result;
}
