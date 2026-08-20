export function patchSnapshotPositions(snapshot, items, revision) {
  if (!snapshot) return snapshot;
  const positions = new Map(items.map((item) => [`${item.kind}:${item.id}`, item]));
  const patch = (kind, entries) => entries.map((entry) => {
    const position = positions.get(`${kind}:${entry.id}`); if (!position) return entry;
    return {
      ...entry,
      x: position.x,
      y: position.y,
      ...(kind === "area" && Object.hasOwn(position, "width") ? { width: position.width } : {}),
      ...(kind === "area" && Object.hasOwn(position, "height") ? { height: position.height } : {}),
      ...(kind === "entity" && Object.hasOwn(position, "areaId") ? { areaId: position.areaId } : {}),
      ...(kind === "entity" && Object.hasOwn(position, "parentId") ? { parentId: position.parentId } : {}),
    };
  });
  return { ...snapshot, revision, areas: patch("area", snapshot.areas), entities: patch("entity", snapshot.entities), work: patch("work", snapshot.work || []) };
}
