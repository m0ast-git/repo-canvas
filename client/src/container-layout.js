import { boundingRect, nodeRect } from "./drag-geometry.js";
import { graphHierarchy } from "./graph-contract.js";

export const CONTAINER_PADDING_X = 40;
export const CONTAINER_PADDING_Y = 40;
export const CONTAINER_ITEM_GAP = 76;
export const AREA_HEADER_HEIGHT = 150;
export const AREA_ITEM_GAP = 76;

function rectanglesOverlap(a, b, gap = 0) {
  return a.x - gap < b.x + b.width
    && a.x + a.width + gap > b.x
    && a.y - gap < b.y + b.height
    && a.y + a.height + gap > b.y;
}

export function normalizeStoredEntityPositions(snapshot, entityRects, defaultRects, areaRects, gap = 36) {
  const output = new Map([...entityRects].map(([id, rect]) => [id, { ...rect }]));
  const defaults = defaultRects || entityRects;
  const byEntity = new Map((snapshot.entities || []).map((entity) => [entity.id, entity]));
  const hierarchy = graphHierarchy(snapshot);

  const subtreeIds = (id) => [id, ...(hierarchy.descendants.get(id) || [])];
  const subtreeBounds = (rects, id) => boundingRect(subtreeIds(id).map((entityId) => rects.get(entityId)).filter(Boolean));
  const moveSubtree = (id, dx, dy) => {
    if (Math.abs(dx) < .01 && Math.abs(dy) < .01) return;
    for (const entityId of subtreeIds(id)) {
      const rect = output.get(entityId);
      if (rect) output.set(entityId, { ...rect, x: rect.x + dx, y: rect.y + dy });
    }
  };

  const normalizeSiblings = (ids, header = null, parentId = "") => {
    for (const id of ids) {
      const children = (hierarchy.direct.get(id) || []).filter((childId) => byEntity.has(childId));
      if (!children.length) continue;
      const parent = output.get(id);
      normalizeSiblings(children, parent ? {
        x: parent.x,
        y: parent.y,
        width: Math.max(280, Number(parent.headerWidth || parent.width || 0)),
        height: Math.max(76, Number(parent.headerHeight || 0)),
      } : null, id);
    }

    const obstacles = header ? [header] : [];
    const currentBounds = ids.map((id) => ({ id, rect: subtreeBounds(output, id) }))
      .filter((item) => item.rect.width && item.rect.height);
    const invalid = currentBounds.some(({ rect }, index) => obstacles.some((obstacle) => rectanglesOverlap(rect, obstacle, gap))
      || currentBounds.slice(0, index).some((previous) => rectanglesOverlap(rect, previous.rect, gap)));

    if (invalid) {
      const parent = parentId ? output.get(parentId) : null;
      const defaultParent = parentId ? defaults.get(parentId) : null;
      const offsetX = parent && defaultParent ? parent.x - defaultParent.x : 0;
      const offsetY = parent && defaultParent ? parent.y - defaultParent.y : 0;
      for (const { id, rect } of currentBounds) {
        const fallback = subtreeBounds(defaults, id);
        if (!fallback.width || !fallback.height) continue;
        moveSubtree(id, fallback.x + offsetX - rect.x, fallback.y + offsetY - rect.y);
      }
    }

  };

  const topLevelByArea = new Map();
  for (const entity of snapshot.entities || []) {
    if (entity.kind === "person" || entity.parentId && byEntity.has(entity.parentId)) continue;
    if (!topLevelByArea.has(entity.areaId)) topLevelByArea.set(entity.areaId, []);
    topLevelByArea.get(entity.areaId).push(entity.id);
  }
  for (const [areaId, ids] of topLevelByArea) {
    const area = areaRects?.get(areaId);
    const header = area ? {
      x: area.x + 18,
      y: area.y + 14,
      width: Math.max(0, Math.min(560, area.width - 36)),
      height: AREA_HEADER_HEIGHT - 20,
    } : null;
    normalizeSiblings(ids, header);
  }
  return output;
}

function itemOrder(a, b) {
  return a.rect.y - b.rect.y || a.rect.x - b.rect.x || a.id.localeCompare(b.id);
}

export function orderItemsForDrop(items, movingId = "", dropCenterY = null) {
  const moving = movingId ? items.find((item) => item.id === movingId) : null;
  const ordered = items.filter((item) => item !== moving).sort(itemOrder);
  if (!moving) return ordered;
  const index = Number.isFinite(dropCenterY)
    ? ordered.findIndex((item) => dropCenterY < item.rect.y + item.rect.height / 2)
    : -1;
  ordered.splice(index < 0 ? ordered.length : index, 0, moving);
  return ordered;
}

export function packVerticalContainer({ containerRect, headerRect, items, movingId = "", dropCenterY = null }) {
  const ordered = orderItemsForDrop(items, movingId, dropCenterY);
  const x = containerRect.x + CONTAINER_PADDING_X;
  let y = Math.max(
    containerRect.y + CONTAINER_PADDING_Y,
    headerRect.y + headerRect.height + CONTAINER_PADDING_Y,
  );
  const placements = [];
  let widest = Math.max(0, headerRect.width);
  for (const item of ordered) {
    placements.push({ id: item.id, x, y, width: item.rect.width, height: item.rect.height });
    widest = Math.max(widest, item.rect.width + CONTAINER_PADDING_X * 2);
    y += item.rect.height + CONTAINER_ITEM_GAP;
  }
  const contentBottom = ordered.length ? y - CONTAINER_ITEM_GAP : headerRect.y + headerRect.height;
  return {
    placements,
    width: widest,
    height: Math.max(headerRect.height, contentBottom + CONTAINER_PADDING_Y - containerRect.y),
  };
}

function areaItemOrder(a, b) {
  return a.rect.y - b.rect.y || a.rect.x - b.rect.x || a.id.localeCompare(b.id);
}

export function orderAreaItemsForDrop(items, movingId = "", dropPoint = null) {
  const moving = movingId ? items.find((item) => item.id === movingId) : null;
  const ordered = items.filter((item) => item !== moving).sort(areaItemOrder);
  if (!moving) return ordered;
  if (!dropPoint || !ordered.length) return [...ordered, moving];
  const closest = ordered.map((item, index) => ({
    index,
    distance: Math.hypot(dropPoint.x - (item.rect.x + item.rect.width / 2), dropPoint.y - (item.rect.y + item.rect.height / 2)),
    after: dropPoint.x > item.rect.x + item.rect.width / 2 || dropPoint.y > item.rect.y + item.rect.height / 2,
  })).sort((a, b) => a.distance - b.distance || a.index - b.index)[0];
  ordered.splice(closest.index + (closest.after ? 1 : 0), 0, moving);
  return ordered;
}

export function packAreaGrid({ areaRect, items, movingId = "", dropPoint = null, headerHeight = AREA_HEADER_HEIGHT }) {
  const ordered = orderAreaItemsForDrop(items, movingId, dropPoint);
  const widest = Math.max(0, ...ordered.map((item) => item.rect.width));
  const width = Math.max(520, widest + CONTAINER_PADDING_X * 2, Number(areaRect.width || 0));
  const left = areaRect.x + CONTAINER_PADDING_X;
  const right = areaRect.x + width - CONTAINER_PADDING_X;
  let x = left;
  let y = areaRect.y + headerHeight + CONTAINER_PADDING_Y;
  let rowHeight = 0;
  const placements = [];
  for (const item of ordered) {
    if (x > left && x + item.rect.width > right) {
      x = left;
      y += rowHeight + AREA_ITEM_GAP;
      rowHeight = 0;
    }
    placements.push({ id: item.id, x, y, width: item.rect.width, height: item.rect.height });
    x += item.rect.width + AREA_ITEM_GAP;
    rowHeight = Math.max(rowHeight, item.rect.height);
  }
  const contentBottom = placements.length ? y + rowHeight : areaRect.y + headerHeight;
  return {
    placements,
    slot: placements.find((item) => item.id === movingId) || null,
    width,
    height: Math.max(260, contentBottom + CONTAINER_PADDING_Y - areaRect.y),
  };
}

export function displaceOverlappingAreas(areaRects, anchorId, gap = 96) {
  const output = new Map([...areaRects].map(([id, rect]) => [id, { ...rect }]));
  const queue = [anchorId]; const moved = new Set(); let guard = 0;
  while (queue.length && guard < output.size * output.size * 2) {
    guard += 1;
    const fixedId = queue.shift(); const fixed = output.get(fixedId); if (!fixed) continue;
    for (const [id, candidate] of output) {
      if (id === fixedId || !rectanglesOverlap(fixed, candidate, gap)) continue;
      const rightShift = fixed.x + fixed.width + gap - candidate.x;
      const downShift = fixed.y + fixed.height + gap - candidate.y;
      const moveRight = rightShift <= downShift;
      output.set(id, { ...candidate, x: candidate.x + (moveRight ? rightShift : 0), y: candidate.y + (moveRight ? 0 : downShift) });
      moved.add(id); queue.push(id);
    }
  }
  return { rects: output, moved: [...moved] };
}

function entityStructureBounds(entityId, byId, descendants, positions) {
  const ids = [entityId, ...(descendants.get(entityId) || [])];
  const rects = ids.map((id) => {
    const node = byId.get(`entity:${id}`);
    if (!node) return null;
    const position = positions.get(node.id) || node.position;
    if (node.type === "group") {
      return {
        x: position.x,
        y: position.y,
        width: Math.max(280, Number(node.data?.headerWidth || node.style?.width || 0)),
        height: Math.max(76, Number(node.data?.headerHeight || 0)),
      };
    }
    return { ...nodeRect(node), x: position.x, y: position.y };
  }).filter(Boolean);
  return boundingRect(rects);
}

function entityDepth(entityId, byEntity) {
  let result = 0;
  let current = byEntity.get(entityId);
  const seen = new Set();
  while (current?.parentId && !seen.has(current.parentId)) {
    seen.add(current.parentId);
    result += 1;
    current = byEntity.get(current.parentId);
  }
  return result;
}

export function compactContainerMembership(snapshot, nodes, context, nextParentId, initialTranslation, dropCenterY) {
  const draft = {
    ...snapshot,
    entities: snapshot.entities.map((entity) => entity.id === context.entityId ? { ...entity, parentId: nextParentId } : entity),
  };
  const hierarchy = graphHierarchy(draft);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const byEntity = new Map(draft.entities.map((entity) => [entity.id, entity]));
  const positions = new Map(
    nodes.filter((node) => node.id.startsWith("entity:")).map((node) => [node.id, { ...node.position }]),
  );
  const touched = new Set();
  for (const [id, initial] of context.positions) {
    if (!id.startsWith("entity:")) continue;
    positions.set(id, { x: initial.x + initialTranslation.dx, y: initial.y + initialTranslation.dy });
    touched.add(id);
  }

  const parentIds = new Set();
  const addParentChain = (startId) => {
    let current = byEntity.get(startId);
    const seen = new Set();
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      parentIds.add(current.id);
      current = current.parentId ? byEntity.get(current.parentId) : null;
    }
  };
  if (context.originalParentId) addParentChain(context.originalParentId);
  if (nextParentId) addParentChain(nextParentId);

  const orderedParents = [...parentIds].sort(
    (a, b) => entityDepth(b, byEntity) - entityDepth(a, byEntity) || a.localeCompare(b),
  );
  for (const parentId of orderedParents) {
    const parentNode = byId.get(`entity:${parentId}`);
    if (!parentNode?.data) continue;
    const parentPosition = positions.get(parentNode.id) || parentNode.position;
    const headerRect = {
      x: parentPosition.x,
      y: parentPosition.y,
      width: Math.max(280, Number(parentNode.data.headerWidth || parentNode.style?.width || 0)),
      height: Math.max(76, Number(parentNode.data.headerHeight || 0)),
    };
    const currentBounds = entityStructureBounds(parentId, byId, hierarchy.descendants, positions);
    const containerRect = {
      x: parentPosition.x,
      y: parentPosition.y,
      width: Math.max(headerRect.width, currentBounds.width),
      height: Math.max(headerRect.height, currentBounds.height),
    };
    const items = (hierarchy.direct.get(parentId) || []).map((id) => ({
      id,
      rect: entityStructureBounds(id, byId, hierarchy.descendants, positions),
    })).filter((item) => item.rect.width > 0 && item.rect.height > 0);
    const packed = packVerticalContainer({
      containerRect,
      headerRect,
      items,
      movingId: parentId === nextParentId ? context.entityId : "",
      dropCenterY: parentId === nextParentId ? dropCenterY : null,
    });
    const itemById = new Map(items.map((item) => [item.id, item]));
    for (const placement of packed.placements) {
      const current = itemById.get(placement.id)?.rect;
      if (!current) continue;
      const dx = placement.x - current.x;
      const dy = placement.y - current.y;
      if (Math.abs(dx) < .01 && Math.abs(dy) < .01) continue;
      for (const entityId of [placement.id, ...(hierarchy.descendants.get(placement.id) || [])]) {
        const nodeId = `entity:${entityId}`;
        const position = positions.get(nodeId);
        if (!position) continue;
        positions.set(nodeId, { x: position.x + dx, y: position.y + dy });
        touched.add(nodeId);
      }
    }
  }
  return {
    hierarchy,
    parentIds: [...parentIds],
    moves: [...touched].map((id) => ({ id, ...positions.get(id) })),
  };
}

export function compactAreaMembership(snapshot, nodes, context, nextAreaId, initialTranslation, dropPoint) {
  const movedEntityIds = new Set([...context.affected].filter((id) => id.startsWith("entity:")).map((id) => id.replace(/^entity:/, "")));
  const draft = {
    ...snapshot,
    entities: snapshot.entities.map((entity) => movedEntityIds.has(entity.id)
      ? { ...entity, areaId: nextAreaId, parentId: entity.id === context.entityId ? "" : entity.parentId }
      : entity),
  };
  const hierarchy = graphHierarchy(draft);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const byEntity = new Map(draft.entities.map((entity) => [entity.id, entity]));
  const positions = new Map(nodes.filter((node) => node.id.startsWith("entity:")).map((node) => [node.id, { ...node.position }]));
  const touched = new Set();
  for (const [id, initial] of context.positions) {
    if (!id.startsWith("entity:")) continue;
    positions.set(id, { x: initial.x + initialTranslation.dx, y: initial.y + initialTranslation.dy });
    touched.add(id);
  }
  const translateSubtree = (entityId, dx, dy) => {
    for (const id of [entityId, ...(hierarchy.descendants.get(entityId) || [])]) {
      const nodeId = `entity:${id}`; const position = positions.get(nodeId); if (!position) continue;
      positions.set(nodeId, { x: position.x + dx, y: position.y + dy }); touched.add(nodeId);
    }
  };
  const areaRects = new Map(nodes.filter((node) => node.type === "area").map((node) => [node.data.area.id, nodeRect(node)]));
  const areaItems = new Map();
  const affectedAreas = [...new Set([context.originalAreaId, nextAreaId].filter(Boolean))];
  for (const areaId of affectedAreas) {
    const areaRect = areaRects.get(areaId); if (!areaRect) continue;
    const roots = draft.entities.filter((entity) => entity.kind !== "person" && entity.areaId === areaId && (!entity.parentId || byEntity.get(entity.parentId)?.areaId !== areaId));
    const items = roots.map((entity) => ({ id: entity.id, rect: entityStructureBounds(entity.id, byId, hierarchy.descendants, positions) })).filter((item) => item.rect.width && item.rect.height);
    const packed = packAreaGrid({ areaRect, items, movingId: areaId === nextAreaId ? context.entityId : "", dropPoint: areaId === nextAreaId ? dropPoint : null });
    const itemById = new Map(items.map((item) => [item.id, item]));
    for (const placement of packed.placements) {
      const current = itemById.get(placement.id)?.rect; if (!current) continue;
      translateSubtree(placement.id, placement.x - current.x, placement.y - current.y);
    }
    const nextRect = { ...areaRect, width: packed.width, height: packed.height };
    areaRects.set(areaId, nextRect); areaItems.set(areaId, nextRect);
  }
  const displaced = displaceOverlappingAreas(areaRects, nextAreaId);
  for (const areaId of displaced.moved) {
    const before = areaRects.get(areaId); const after = displaced.rects.get(areaId); if (!before || !after) continue;
    const dx = after.x - before.x; const dy = after.y - before.y;
    for (const entity of draft.entities.filter((item) => item.areaId === areaId && item.kind !== "person")) {
      const nodeId = `entity:${entity.id}`; const position = positions.get(nodeId); if (!position) continue;
      positions.set(nodeId, { x: position.x + dx, y: position.y + dy }); touched.add(nodeId);
    }
    areaItems.set(areaId, after);
  }
  for (const areaId of affectedAreas) if (displaced.rects.has(areaId)) areaItems.set(areaId, displaced.rects.get(areaId));
  return {
    hierarchy,
    movedEntityIds: [...movedEntityIds],
    moves: [...touched].map((id) => ({ id, ...positions.get(id) })),
    areas: [...areaItems].map(([id, rect]) => ({ id: `area:${id}`, ...rect })),
  };
}

function calculatedGroupContour(node, byId, descendants) {
  const width = Math.max(280, Number(node.data?.headerWidth || node.style?.width || 0));
  const height = Math.max(76, Number(node.data?.headerHeight || 0));
  let left = 0;
  let top = 0;
  let right = width;
  let bottom = height;
  const entityId = node.id.replace(/^entity:/, "");
  for (const childId of descendants.get(entityId) || []) {
    const child = byId.get(`entity:${childId}`);
    if (!child) continue;
    const childWidth = child.type === "group"
      ? Math.max(280, Number(child.data?.headerWidth || child.style?.width || 0))
      : Number(child.style?.width || 0);
    const childHeight = child.type === "group"
      ? Math.max(76, Number(child.data?.headerHeight || 0))
      : Number(child.style?.height || 0);
    left = Math.min(left, child.position.x - node.position.x - 18);
    top = Math.min(top, child.position.y - node.position.y - 18);
    right = Math.max(right, child.position.x + childWidth - node.position.x + 18);
    bottom = Math.max(bottom, child.position.y + childHeight - node.position.y + 18);
  }
  return { left, top, width: right - left, height: bottom - top };
}

export function absoluteGroupContour(node, byId, descendants) {
  const contour = calculatedGroupContour(node, byId, descendants);
  return {
    x: node.position.x + contour.left,
    y: node.position.y + contour.top,
    width: contour.width,
    height: contour.height,
  };
}

export function fitGroupContours(nodes, descendants) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  return nodes.map((node) => {
    if (node.type !== "group") return node;
    const contour = calculatedGroupContour(node, byId, descendants);
    const current = node.data?.contour;
    if (current && current.left === contour.left && current.top === contour.top && current.width === contour.width && current.height === contour.height) return node;
    return { ...node, data: { ...node.data, contour } };
  });
}

export function hierarchyWithLayoutItems(snapshot, items) {
  const parents = new Map(
    items.filter((item) => item.kind === "entity" && Object.hasOwn(item, "parentId"))
      .map((item) => [item.id, item.parentId]),
  );
  const areas = new Map(
    items.filter((item) => item.kind === "entity" && Object.hasOwn(item, "areaId"))
      .map((item) => [item.id, item.areaId]),
  );
  if (!parents.size && !areas.size) return graphHierarchy(snapshot).descendants;
  return graphHierarchy({
    ...snapshot,
    entities: snapshot.entities.map((entity) => ({
      ...entity,
      ...(parents.has(entity.id) ? { parentId: parents.get(entity.id) } : {}),
      ...(areas.has(entity.id) ? { areaId: areas.get(entity.id) } : {}),
    })),
  }).descendants;
}
