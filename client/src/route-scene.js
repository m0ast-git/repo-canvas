import { nodeRect, groupContourRect, groupHeaderRect } from './drag-geometry.js';
import { AREA_HEADER_HEIGHT } from './node-geometry.js';
import { graphWithConnectionPorts } from './connection-ports.js';
import { pathEntersBoxes } from './protected-routes.js';

// Routing uses the complete world, never the subset mounted by viewport culling.
export function routeSceneKey(nodes) {
  return JSON.stringify(nodes.filter(n=>!n.id.startsWith('removed:')).map(n=>[n.id,n.type,n.position.x,n.position.y,n.width,n.height,n.data?.headerHeight,n.data?.contour]));
}

export function routeScene(nodes) {
  const headers=[], boxes=[], boundaries=new Map(), groups=new Set();
  for(const node of nodes) {
    if(node.id.startsWith('removed:'))continue;
    const rect=node.type==='group'?groupContourRect(node):nodeRect(node);
    if(node.type==='area') {
      headers.push({...rect,height:AREA_HEADER_HEIGHT,nodeId:node.id});
      continue;
    }
    boundaries.set(node.id,{...rect,id:node.id});
    if(node.type==='group') {
      groups.add(node.id);
      const header=groupHeaderRect(node);
      headers.push({...header,nodeId:node.id});
      boxes.push({...header,id:node.id});
    } else boxes.push({...rect,id:node.id});
  }
  return {headers,boxes,boundaries,groups};
}

export function isContainmentRoute(route, descendants) {
  const source=route.source?.replace(/^entity:/,''),target=route.target?.replace(/^entity:/,'');
  return descendants.get(source)?.has(target)||descendants.get(target)?.has(source)||false;
}

// Fast temporary geometry while dragging or awaiting the worker's final routes.
export function presentSceneRoutes(routes,scene) {
  const graph=graphWithConnectionPorts([...scene.boundaries.values()],routes);
  const byEdge=new Map(graph.edges.map(edge=>[edge.id,edge]));
  const ports=new Map(graph.children.flatMap(node=>node.ports.map(port=>[port.id,{x:node.x+port.x,y:node.y+port.y,side:port.properties['port.side']}])));
  const stub=port=>({x:port.x+(port.side==='EAST'?24:port.side==='WEST'?-24:0),y:port.y+(port.side==='SOUTH'?24:port.side==='NORTH'?-24:0)});
  return routes.map(route=>{
    let next=route;
    const ends=[route.source,route.target].filter(id=>scene.groups.has(id));
    if(ends.length&&route.points?.length>1&&!route.finalGeometry) {
      const edge=byEdge.get(route.id),points=route.points;
      const a=scene.groups.has(route.source)?ports.get(edge.sourcePort):null;
      const b=scene.groups.has(route.target)?ports.get(edge.targetPort):null;
      const start=a?{x:a.x,y:a.y}:points[0],end=b?{x:b.x,y:b.y}:points.at(-1);
      const from=a?stub(a):points[1],to=b?stub(b):points.at(-2);
      next={...route,points:[start,from,{x:from.x,y:to.y},to,end]};
    }
    // Containers are transparent to their children's edges, but an edge of
    // the container itself must depart from its complete outside boundary.
    const boxes=ends.length?scene.boxes.map(box=>ends.includes(box.id)?scene.boundaries.get(box.id):box):scene.boxes;
    // Preview never searches for a path on the UI thread. An occluded preview
    // waits for the one worker transaction instead of covering readable content.
    const headers=scene.headers.filter(box=>box.nodeId!==route.source&&box.nodeId!==route.target);
    return pathEntersBoxes(next.points||[],[...headers,...boxes])?{...next,points:[],preview:true}:next;
  });
}
