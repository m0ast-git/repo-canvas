import { graphWithConnectionPorts } from './connection-ports.js';

export const INTERACTIVE_ROUTING_OPTIONS=Object.freeze({
  routingType:'orthogonal',shapeBufferDistance:4,idealNudgingDistance:12,
  segmentPenalty:20,crossingPenalty:0,fixedSharedPathPenalty:0,
  reverseDirectionPenalty:24,portDirectionPenalty:100,
  nudgeOrthogonalSegmentsConnectedToShapes:true,
  nudgeOrthogonalTouchingColinearSegments:true,
  performUnifyingNudgingPreprocessingStep:true,
  nudgeSharedPathsWithCommonEndPoint:true,
});

// Feed libavoid the final visible geometry. A group is transparent to child
// connections: its header is an obstacle and its frame has independent pins.
export function presentationRoutingScope(routes,scene) {
  const graph=graphWithConnectionPorts([...scene.boundaries.values()],routes,[...scene.boxes,...scene.headers]);
  const byId=new Map(graph.children.map(node=>[node.id,node]));
  const children=graph.children.filter(node=>!scene.groups.has(node.id));
  for(const header of scene.headers)children.push({...header,id:'header:'+header.nodeId,ports:[]});
  for(const edge of graph.edges)for(const end of ['source','target']) {
    if(!scene.groups.has(edge[end]))continue;
    const group=byId.get(edge[end]),port=group.ports.find(p=>p.id===edge[end+'Port']);
    const id='boundary:'+edge.id+':'+end;
    children.push({id,x:group.x+port.x-1,y:group.y+port.y-1,width:2,height:2,ports:[{...port,x:1,y:1}]});
    edge[end]=id;
  }
  const nodes=new Map(children.map(node=>[node.id,node]));
  return {
    id:'presentation',graph:{id:'presentation',children,edges:graph.edges},nodes,
    edges:graph.edges,edgeIds:new Set(graph.edges.map(edge=>edge.id)),
    bindings:new Map(children.map(node=>[node.id,[{nodeId:node.id,offsetX:0,offsetY:0}]])),
    logicalRoutes:routes,scene,
    structure:JSON.stringify([children.map(n=>[n.id,n.width,n.height,n.ports]),graph.edges]),
  };
}

// No per-edge rerouting is allowed after libavoid has separated the channels.
export function presentationRoutesFromResults(scope,results) {
  return scope.logicalRoutes.map(route=>{
    const result=results.get(route.id);
    if(!result)throw new Error(`Missing final route: ${route.id}`);
    const points=[result.sourcePoint,...(result.bendPoints||[]),result.targetPoint];
    if(points.some((p,i)=>!Number.isFinite(p.x)||!Number.isFinite(p.y)||i&&Math.abs(p.x-points[i-1].x)>.05&&Math.abs(p.y-points[i-1].y)>.05))throw new Error(`Invalid final route: ${route.id}`);
    const {fallback,preview,blockedByHeader,headerProtected,...logical}=route;
    return {...logical,points,sourceBase:{...scope.scene.boundaries.get(route.source)},targetBase:{...scope.scene.boundaries.get(route.target)},finalGeometry:true};
  });
}
