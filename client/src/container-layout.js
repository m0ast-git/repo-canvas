import { boundingRect, nodeRect } from "./drag-geometry.js";
import { graphHierarchy } from "./graph-contract.js";

export const CONTAINER_PADDING_X = 40;
export const CONTAINER_PADDING_Y = 40;
export const CONTAINER_ITEM_GAP = 76;

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
      height: 82,
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
  if (!parents.size) return graphHierarchy(snapshot).descendants;
  return graphHierarchy({
    ...snapshot,
    entities: snapshot.entities.map((entity) => parents.has(entity.id) ? { ...entity, parentId: parents.get(entity.id) } : entity),
  }).descendants;
}
