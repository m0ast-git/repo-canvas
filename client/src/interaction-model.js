const READABLE_SCREEN_PX = Object.freeze({
  area: 8,
  group: 8,
  entity: 9,
  person: 9,
  work: 9,
  route: 9,
});

export function relationIds(route) {
  const values = (route?.relations || []).map((relation) => relation.id).filter(Boolean);
  if (route?.relationId) values.push(route.relationId);
  return [...new Set(values)];
}

export function routeSelection(route, relationId = "") {
  if (!route) return null;
  return { kind: "route", route, relationId: relationId || "" };
}

export function selectionKey(selection) {
  if (!selection) return "";
  if (selection.kind === "route") return `route:${relationIds(selection.route).join(",")}:${selection.relationId || ""}`;
  return `${selection.kind}:${selection.id || ""}`;
}

function chosenRelations(selection) {
  if (selection?.kind !== "route") return [];
  const relations = selection.route?.relations || [];
  if (!selection.relationId) return relations;
  return relations.filter((relation) => relation.id === selection.relationId);
}

export function focusForSelection(selection, entityById = new Map()) {
  const nodeIds = new Set();
  const areaIds = new Set();
  const relationIdSet = new Set();
  if (!selection) return { nodeIds, areaIds, relationIds: relationIdSet };

  if (selection.kind === "entity") {
    nodeIds.add(`entity:${selection.id}`);
    const entity = entityById.get(selection.id);
    if (entity?.areaId) areaIds.add(entity.areaId);
    return { nodeIds, areaIds, relationIds: relationIdSet };
  }
  if (selection.kind === "area") {
    nodeIds.add(`area:${selection.id}`);
    areaIds.add(selection.id);
    return { nodeIds, areaIds, relationIds: relationIdSet };
  }
  if (selection.kind === "work") {
    nodeIds.add(`work:${selection.id}`);
    for (const target of selection.work?.targets || []) {
      nodeIds.add(`entity:${target}`);
      const entity = entityById.get(target);
      if (entity?.areaId) areaIds.add(entity.areaId);
    }
    return { nodeIds, areaIds, relationIds: relationIdSet };
  }
  if (selection.kind !== "route") return { nodeIds, areaIds, relationIds: relationIdSet };

  const relations = chosenRelations(selection);
  for (const relation of relations) {
    if (relation.id) relationIdSet.add(relation.id);
    for (const id of [relation.from, relation.to]) {
      if (!id) continue;
      nodeIds.add(`entity:${id}`);
      const entity = entityById.get(id);
      if (entity?.areaId) {
        areaIds.add(entity.areaId);
        nodeIds.add(`area:${entity.areaId}`);
      }
    }
  }
  if (!relations.length) {
    if (selection.route?.source) nodeIds.add(selection.route.source);
    if (selection.route?.target) nodeIds.add(selection.route.target);
  }
  return { nodeIds, areaIds, relationIds: relationIdSet };
}

export function routeMatchesFocus(route, focus) {
  if (!route || !focus) return false;
  const ids = relationIds(route);
  if (ids.some((id) => focus.relationIds.has(id))) return true;
  return focus.nodeIds.has(route.source) && focus.nodeIds.has(route.target);
}

export function screenTextReadable(zoom, kind = "entity", baseFontPx = 12) {
  const threshold = READABLE_SCREEN_PX[kind] || READABLE_SCREEN_PX.entity;
  return Math.max(0, Number(zoom || 0)) * Math.max(1, Number(baseFontPx || 0)) >= threshold;
}

function normalize(value) {
  return String(value || "").toLocaleLowerCase("ru-RU").replace(/ё/g, "е").trim();
}

function searchText(parts) {
  return normalize(parts.filter(Boolean).join(" "));
}

export function buildSearchItems(snapshot, work = []) {
  const areas = snapshot?.areas || [];
  const entities = snapshot?.entities || [];
  const areaById = new Map(areas.map((area) => [area.id, area]));
  return [
    ...areas.map((area) => ({
      kind: "area", id: area.id, label: area.ownerTitle || area.title,
      description: area.ownerNote || area.note || "Область проекта",
      text: searchText([area.ownerTitle, area.title, area.ownerNote, area.note]),
    })),
    ...entities.map((entity) => ({
      kind: "entity", id: entity.id, label: entity.ownerLabel || entity.label,
      description: entity.ownerPurpose || entity.purpose || areaById.get(entity.areaId)?.ownerTitle || areaById.get(entity.areaId)?.title || "Элемент проекта",
      areaId: entity.areaId || "",
      text: searchText([entity.ownerLabel, entity.label, entity.ownerPurpose, entity.purpose, entity.path, entity.kind, areaById.get(entity.areaId)?.ownerTitle, areaById.get(entity.areaId)?.title]),
    })),
    ...work.map((item) => ({
      kind: "work", id: item.id, label: item.title, description: item.actor || "agent", work: item,
      text: searchText([item.title, item.actor, item.status, ...(item.targets || [])]),
    })),
  ];
}

export function searchCanvas(items, query, limit = 12) {
  const needle = normalize(query);
  if (!needle) return [];
  const terms = needle.split(/\s+/).filter(Boolean);
  return items.map((item, index) => {
    const label = normalize(item.label);
    if (!terms.every((term) => item.text.includes(term))) return null;
    const score = label === needle ? 0 : label.startsWith(needle) ? 1 : label.includes(needle) ? 2 : 3;
    return { item, score, index };
  }).filter(Boolean).sort((a, b) => a.score - b.score || a.index - b.index)
    .slice(0, limit).map(({ item }) => item);
}

export function offscreenChip(viewport, size, rect, margin = 24) {
  if (!rect || !size?.width || !size?.height || !viewport?.zoom) return null;
  const centre = {
    x: (rect.x + rect.width / 2) * viewport.zoom + viewport.x,
    y: (rect.y + rect.height / 2) * viewport.zoom + viewport.y,
  };
  if (centre.x >= margin && centre.x <= size.width - margin && centre.y >= margin && centre.y <= size.height - margin) return null;
  const viewportCentre = { x: size.width / 2, y: size.height / 2 };
  const dx = centre.x - viewportCentre.x; const dy = centre.y - viewportCentre.y;
  const sx = Math.abs(dx) < .001 ? Number.POSITIVE_INFINITY : (size.width / 2 - margin) / Math.abs(dx);
  const sy = Math.abs(dy) < .001 ? Number.POSITIVE_INFINITY : (size.height / 2 - margin) / Math.abs(dy);
  const scale = Math.min(sx, sy);
  const x = viewportCentre.x + dx * scale; const y = viewportCentre.y + dy * scale;
  const side = scale === sx ? dx < 0 ? "left" : "right" : dy < 0 ? "top" : "bottom";
  return { x, y, side };
}
