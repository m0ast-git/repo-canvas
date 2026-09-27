import {separateParallelRoutes} from "./route-clearance.js";
import {graphWithConnectionPorts} from "./connection-ports.js";
import {protectRouteHeaders} from "./protected-routes.js";

function sameRect(left, right) {
  return Math.abs(left.x - right.x) < .01
    && Math.abs(left.y - right.y) < .01
    && Math.abs(left.width - right.width) < .01
    && Math.abs(left.height - right.height) < .01;
}

function finiteRect(rect = {}) {
  return {
    x: Number(rect.x || 0),
    y: Number(rect.y || 0),
    width: Math.max(0, Number(rect.width || 0)),
    height: Math.max(0, Number(rect.height || 0)),
  };
}

function addBinding(bindings, inputId, nodeId, offsetX = 0, offsetY = 0) {
  if (!inputId || !nodeId) return;
  if (!bindings.has(inputId)) bindings.set(inputId, []);
  const current = bindings.get(inputId);
  if (!current.some((item) => item.nodeId === nodeId)) current.push({ nodeId, offsetX, offsetY });
}

export function createRoutingScope({ id, edges = [], boxes = new Map(), obstacles = [] }) {
  const nodes = new Map();
  const bindings = new Map();

  for (const [nodeId, value] of boxes) {
    const rect = finiteRect(value);
    const node = { id: nodeId, ...rect };
    nodes.set(nodeId, node);
    addBinding(bindings, nodeId, nodeId);
  }

  obstacles.forEach((value, index) => {
    const rect = finiteRect(value);
    let nodeId = String(value.id || `obstacle-${index}`);
    const current = nodes.get(nodeId);
    if (current && sameRect(current, rect)) {
      if (value.moveWith) addBinding(bindings, value.moveWith, nodeId, Number(value.moveOffsetX || 0), Number(value.moveOffsetY || 0));
      return;
    }
    if (current) nodeId = `obstacle:${index}:${nodeId}`;
    nodes.set(nodeId, { id: nodeId, ...rect });
    if (value.moveWith) addBinding(bindings, value.moveWith, nodeId, Number(value.moveOffsetX || 0), Number(value.moveOffsetY || 0));
  });

  const scopedEdges = edges.filter((edge) => edge?.source !== edge?.target && nodes.has(edge?.source) && nodes.has(edge?.target));
  return {
    id,
    nodes,
    bindings,
    edges: scopedEdges,
    edgeIds: new Set(scopedEdges.map((edge) => edge.id)),
    graph: {
      id,
      ...graphWithConnectionPorts([...nodes.values()], scopedEdges),
    },
  };
}

export function routingMovesForScope(scope, moves = []) {
  const resolved = new Map();
  for (const move of moves) {
    if (!Number.isFinite(move?.x) || !Number.isFinite(move?.y)) continue;
    for (const binding of scope.bindings.get(String(move.id || "")) || []) {
      if (!scope.nodes.has(binding.nodeId)) continue;
      const current=scope.nodes.get(binding.nodeId);if(!move.force&&Math.abs(current.x-(move.x+binding.offsetX))<.01&&Math.abs(current.y-(move.y+binding.offsetY))<.01)continue;
      resolved.set(binding.nodeId, {
        id: binding.nodeId,
        x: move.x + binding.offsetX,
        y: move.y + binding.offsetY,
      });
    }
  }
  return [...resolved.values()];
}

export function applyRoutingMoves(scope, moves = []) {
  const resolved = routingMovesForScope(scope, moves);
  for (const move of resolved) {
    const node = scope.nodes.get(move.id);
    node.x = move.x;
    node.y = move.y;
    // A later session rebuild must start from the same geometry as live moves.
    const graphNode=scope.graph.children.find(item=>item.id===move.id);
    if(graphNode){graphNode.x=move.x;graphNode.y=move.y;}
  }
  return resolved;
}

export function routingResultsComplete(scope, results) {
  if (!results || typeof results.has !== "function") return false;
  for (const edgeId of scope.edgeIds) if (!results.has(edgeId)) return false;
  return true;
}

export function routesFromRoutingResults(scope, results) {
  const graphEdges=new Map(scope.graph.edges.map(edge=>[edge.id,edge]));
  const ports=new Map(scope.graph.children.flatMap(node=>(node.ports||[]).map(port=>[port.id,{...port,nodeId:node.id}])));
  const resolvePort=id=>{const port=ports.get(id),node=port&&scope.nodes.get(port.nodeId);return node?{x:node.x+port.x,y:node.y+port.y,side:port.properties['port.side']}:null;};
  const routes = scope.edges.map((edge) => {
    const route = results.get(edge.id);
    if (!route) return null;
    const source = scope.nodes.get(edge.source);
    const target = scope.nodes.get(edge.target);
    let points=[route.sourcePoint, ...(route.bendPoints || []), route.targetPoint];
    const graphEdge=graphEdges.get(edge.id),start=resolvePort(graphEdge?.sourcePort),end=resolvePort(graphEdge?.targetPort);
    const invalid=points.some((point,i)=>i&&Math.abs(point.x-points[i-1].x)>.1&&Math.abs(point.y-points[i-1].y)>.1)
      || start&&Math.hypot(points[0].x-start.x,points[0].y-start.y)>.5
      || end&&Math.hypot(points.at(-1).x-end.x,points.at(-1).y-end.y)>.5;
    if(invalid&&start&&end){
      const stub=port=>({x:port.x+(port.side==='EAST'?24:port.side==='WEST'?-24:0),y:port.y+(port.side==='SOUTH'?24:port.side==='NORTH'?-24:0)});
      const a=stub(start),b=stub(end);
      const fallback={...edge,points:[{x:start.x,y:start.y},a,{x:a.x,y:b.y},b,{x:end.x,y:end.y}]};
      // libavoid can return a straight centre-to-centre fallback without throwing.
      // Repair that result before it reaches SVG, retaining the allocated ports.
      points=protectRouteHeaders(fallback,[],[...scope.nodes.values()]).points;
    }
    return {
      ...edge,
      sourceBase: { x: source.x, y: source.y },
      targetBase: { x: target.x, y: target.y },
      points,
      sourceSide: route.sourceSide,
      targetSide: route.targetSide,
    };
  }).filter(Boolean);
  const obstacles=[...scope.nodes.values()];
  return separateParallelRoutes(routes,obstacles).map(route=>protectRouteHeaders(route,[],obstacles));
}
