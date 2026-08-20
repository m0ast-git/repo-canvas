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
      children: [...nodes.values()],
      edges: scopedEdges.map((edge) => ({ id: edge.id, source: edge.source, target: edge.target })),
    },
  };
}

export function routingMovesForScope(scope, moves = []) {
  const resolved = new Map();
  for (const move of moves) {
    if (!Number.isFinite(move?.x) || !Number.isFinite(move?.y)) continue;
    for (const binding of scope.bindings.get(String(move.id || "")) || []) {
      if (!scope.nodes.has(binding.nodeId)) continue;
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
  }
  return resolved;
}

export function routingResultsComplete(scope, results) {
  if (!results || typeof results.has !== "function") return false;
  for (const edgeId of scope.edgeIds) if (!results.has(edgeId)) return false;
  return true;
}

export function routesFromRoutingResults(scope, results) {
  return scope.edges.map((edge) => {
    const route = results.get(edge.id);
    if (!route) return null;
    const source = scope.nodes.get(edge.source);
    const target = scope.nodes.get(edge.target);
    return {
      ...edge,
      sourceBase: { x: source.x, y: source.y },
      targetBase: { x: target.x, y: target.y },
      points: [route.sourcePoint, ...(route.bendPoints || []), route.targetPoint],
      sourceSide: route.sourceSide,
      targetSide: route.targetSide,
    };
  }).filter(Boolean);
}
