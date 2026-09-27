export function applySnapshotDelta(previous,packet) {
  if(packet.type==="snapshot")return packet.snapshot;
  if(!previous||(packet.baseRevision!==previous.revision&&packet.revision!==previous.revision))return null;
  const next={...previous,...packet.fields};
  for(const key of packet.removedFields||[])delete next[key];
  for(const [kind,change] of Object.entries(packet.changes)) {
    const items=new Map((previous[kind]||[]).map(item=>[item.id,item]));
    for(const id of change.remove)items.delete(id);
    for(const item of change.upsert)items.set(item.id,item);
    next[kind]=change.order.map(id=>items.get(id)).filter(Boolean);
  }
  return next;
}
