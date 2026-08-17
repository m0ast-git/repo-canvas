export function patchSnapshotPositions(snapshot, items, revision) {
  if (!snapshot) return snapshot;
  const positions = new Map(items.map((item) => [`${item.kind}:${item.id}`, item]));
  const patch = (kind, entries) => entries.map((entry) => { const position = positions.get(`${kind}:${entry.id}`); return position ? { ...entry, x: position.x, y: position.y } : entry; });
  return { ...snapshot, revision, areas: patch("area", snapshot.areas), entities: patch("entity", snapshot.entities) };
}
