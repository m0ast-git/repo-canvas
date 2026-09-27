import { compactAreaMembership, compactContainerMembership, growDropAreas } from "./container-layout.js";
import { nearestFreeTranslation, nodeRect, dropObstacle, pickDropContainer, translateRect } from "./drag-geometry.js";
import { graphHierarchy } from "./graph-contract.js";

export function originalContainerIds(context) {
  const result=new Set(context.originalAreaId?[`area:${context.originalAreaId}`]:[]);
  const byId=new Map((context.snapshot?.entities||[]).map(item=>[item.id,item]));
  let id=context.originalParentId;
  while(id&&!result.has(`entity:${id}`)){result.add(`entity:${id}`);id=byId.get(id)?.parentId;}
  if(context.origin)result.add(context.origin.id);
  return result;
}

export function canvasDropTarget(bounds,context) {
  const owned=originalContainerIds(context),x=bounds.x+bounds.width/2,y=bounds.y+bounds.height/2;
  // A source frame cannot chase the pointer. Once the centre crosses its
  // original boundary, it is no longer a candidate for this outward drag.
  const candidates=context.containers.filter(item=>!owned.has(item.id)||(x>=item.rect.x&&x<=item.rect.x+item.rect.width&&y>=item.rect.y&&y<=item.rect.y+item.rect.height));
  return pickDropContainer(bounds,candidates,context.targetId);
}

// Preview and commit use the same result, calculated against the gesture's original geometry.
export function settleCanvasDrop(snapshot, nodes, context, activityTier = "entity") {
  const desired = context.lastTranslation;
  const rawBounds = translateRect(context.sourceBounds, desired.dx, desired.dy);
  const target = context.canReparent ? canvasDropTarget(rawBounds,context) : null;
  const nextAreaId = context.canReparent ? target?.areaId || "" : context.originalAreaId;
  const nextParentId = context.canReparent ? target?.type === "group" ? target.entityId : "" : context.originalParentId;
  const changed = context.canReparent && (nextParentId !== context.originalParentId || nextAreaId !== context.originalAreaId);
  const incoming=target&&!originalContainerIds(context).has(target.id);
  const draft=changed?{...snapshot,entities:snapshot.entities.map(entity=>context.affected.has(`entity:${entity.id}`)?{...entity,areaId:nextAreaId,...(entity.id===context.entityId?{parentId:nextParentId}:{})}:entity)}:snapshot;
  let finalMoves; let nextHierarchy = graphHierarchy(draft).descendants;
  let compactParentIds = []; let changedAreaEntityIds = new Set(nextAreaId!==context.originalAreaId?[...context.affected].filter(id=>id.startsWith('entity:')).map(id=>id.slice(7)):[]);
  if (context.canReparent && incoming) {
    if (target?.type === "area") {
      const result = compactAreaMembership(snapshot, nodes, context, nextAreaId, desired, context.pointer);
      finalMoves = [...result.moves, ...result.areas]; nextHierarchy = result.hierarchy.descendants;
      changedAreaEntityIds = new Set(result.movedEntityIds);
    } else {
      const result = compactContainerMembership(snapshot, nodes, context, nextParentId, desired, context.pointer.y);
      finalMoves = result.moves; nextHierarchy = result.hierarchy.descendants; compactParentIds = result.parentIds;
      if (nextAreaId !== context.originalAreaId) changedAreaEntityIds = new Set(result.movedEntityIds);
    }
  } else {
    const obstacles = nodes.filter((item) => !context.affected.has(item.id) && (item.type !== "work" || activityTier === "work") && (context.kind !== "area" || item.type === "area"))
      .map((item) => context.kind === "area" ? nodeRect(item) : dropObstacle(item));
    const translation = nearestFreeTranslation(context.sourceBounds, desired, obstacles);
    finalMoves = [...context.positions].map(([id, initial]) => ({ id, x: initial.x + translation.dx, y: initial.y + translation.dy }));
  }
  if (context.canReparent && incoming) finalMoves = growDropAreas(draft,nodes,finalMoves,changedAreaEntityIds,nextAreaId);
  const byId = new Map(nodes.map((item) => [item.id, item]));
  const moves = new Map(finalMoves.map((move) => [move.id, move]));
  for (const work of snapshot.work || []) {
    if (moves.has(`work:${work.id}`)) continue;
    const targetId = (work.targets || []).find((id) => moves.has(`entity:${id}`));
    const entity = byId.get(`entity:${targetId}`); const workNode = byId.get(`work:${work.id}`);
    if (!entity || !workNode) continue;
    const after = moves.get(entity.id);
    finalMoves.push({ id: workNode.id, x: workNode.position.x + after.x - entity.position.x, y: workNode.position.y + after.y - entity.position.y });
  }
  return { finalMoves, nextHierarchy, compactParentIds, changedAreaEntityIds, nextAreaId, nextParentId, target };
}
