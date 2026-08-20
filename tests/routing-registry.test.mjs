import assert from "node:assert/strict";
import test from "node:test";

import { createRoutingSession, routeEdges } from "@mr_mint/elkjs-libavoid";

import { RoutingRegistry } from "../client/src/routing-registry.js";
import {
  applyRoutingMoves,
  createRoutingScope,
  routesFromRoutingResults,
  routingMovesForScope,
} from "../client/src/routing-scopes.js";

function scopeAt({ width = 100, withSecondEdge = false } = {}) {
  const boxes = new Map([
    ["entity:a", { x: 0, y: 0, width, height: 60 }],
    ["entity:b", { x: 320, y: 0, width: 100, height: 60 }],
    ["entity:c", { x: 640, y: 0, width: 100, height: 60 }],
  ]);
  const edges = [
    { id: "edge:ab", source: "entity:a", target: "entity:b", label: "a to b" },
    ...(withSecondEdge ? [{ id: "edge:bc", source: "entity:b", target: "entity:c", label: "b to c" }] : []),
  ];
  return createRoutingScope({
    id: "detail:test",
    boxes,
    obstacles: [{ id: "area-header:test", x: 20, y: -120, width: 280, height: 80, moveWith: "area:test", moveOffsetX: 20, moveOffsetY: 14 }],
    edges,
  });
}

function resultMap(scope) {
  return new Map(scope.edges.map((edge) => {
    const source = scope.nodes.get(edge.source); const target = scope.nodes.get(edge.target);
    return [edge.id, {
      sourcePoint: { x: source.x + source.width, y: source.y + source.height / 2 },
      targetPoint: { x: target.x, y: target.y + target.height / 2 },
      bendPoints: [], sourceSide: "east", targetSide: "west",
    }];
  }));
}

function fakeFactory(counters) {
  return async (graph) => {
    counters.created += 1;
    const nodes = new Map(graph.children.map((node) => [node.id, node]));
    return {
      moveNode(id, position) {
        const node = nodes.get(id); if (!node) throw new Error(`unknown ${id}`);
        node.x = position.x; node.y = position.y;
      },
      processTransaction() {
        counters.transactions += 1;
        return new Map(graph.edges.map((edge) => {
          const source = nodes.get(edge.source); const target = nodes.get(edge.target);
          return [edge.id, {
            sourcePoint: { x: source.x + source.width, y: source.y + source.height / 2 },
            targetPoint: { x: target.x, y: target.y + target.height / 2 },
            bendPoints: [], sourceSide: "east", targetSide: "west",
          }];
        }));
      },
      destroy() { counters.destroyed += 1; },
    };
  };
}

test("routing scope filters moves and maps an area move to its header obstacle", () => {
  const scope = scopeAt();
  const moves = routingMovesForScope(scope, [
    { id: "area:test", x: 100, y: 200 },
    { id: "entity:a", x: 150, y: 260 },
    { id: "work:unknown", x: 10, y: 20 },
  ]);
  assert.deepEqual(moves, [
    { id: "area-header:test", x: 120, y: 214 },
    { id: "entity:a", x: 150, y: 260 },
  ]);
});

test("registry keeps one session per scope and uses incremental settles without rebuilds", async () => {
  const counters = { created: 0, destroyed: 0, transactions: 0 };
  const registry = new RoutingRegistry({
    createSession: fakeFactory(counters),
    routeOnce: async (scope) => routesFromRoutingResults(scope, resultMap(scope)),
  });
  await registry.replace([scopeAt()]);
  for (let index = 0; index < 100; index += 1) {
    const routes = await registry.settle([{ id: "entity:a", x: index * 2, y: index }]);
    assert.equal(routes.length, 1);
  }
  assert.deepEqual(registry.stats(), {
    created: 1, destroyed: 0, rebuilds: 0, transactions: 100, fallbacks: 0, active: 1,
  });
  registry.destroy();
  assert.equal(registry.stats().active, 0);
  assert.equal(registry.stats().created, registry.stats().destroyed);
  assert.equal(counters.created, counters.destroyed);
});

test("registry rebuild lifecycle stays bounded across geometry revisions", async () => {
  const counters = { created: 0, destroyed: 0, transactions: 0 };
  const registry = new RoutingRegistry({
    createSession: fakeFactory(counters),
    routeOnce: async (scope) => routesFromRoutingResults(scope, resultMap(scope)),
  });
  for (let index = 0; index < 100; index += 1) {
    const routes = await registry.replace([scopeAt({ width: 100 + index })]);
    assert.equal(routes.length, 1);
    assert.equal(registry.stats().active, 1);
  }
  registry.destroy();
  assert.equal(registry.stats().created, registry.stats().destroyed);
  assert.equal(counters.created, counters.destroyed);
});

test("an initial transaction throw destroys its WASM session before one-shot fallback", async () => {
  let destroyed = 0; let fallbackCalls = 0;
  const registry = new RoutingRegistry({
    createSession: async () => ({
      processTransaction() { throw new Error("initial transaction failed"); },
      destroy() { destroyed += 1; },
    }),
    routeOnce: async (scope) => {
      fallbackCalls += 1;
      return routesFromRoutingResults(scope, resultMap(scope));
    },
  });
  const routes = await registry.replace([scopeAt()]);
  assert.equal(routes.length, 1);
  assert.equal(fallbackCalls, 1);
  assert.equal(destroyed, 1);
  assert.deepEqual(registry.stats(), {
    created: 1, destroyed: 1, rebuilds: 0, transactions: 0, fallbacks: 1, active: 0,
  });
  registry.destroy();
});

test("real libavoid session preserves complete orthogonal routes after an incremental move", async () => {
  const registry = new RoutingRegistry({
    createSession: (graph) => createRoutingSession(graph, { routingType: "orthogonal", shapeBufferDistance: 12 }),
    routeOnce: async (scope) => routesFromRoutingResults(scope, await routeEdges(scope.graph, { routingType: "orthogonal", shapeBufferDistance: 12 })),
  });
  await registry.replace([scopeAt({ withSecondEdge: true })]);
  const routes = await registry.settle([{ id: "entity:b", x: 340, y: 180 }]);
  assert.equal(routes.length, 2);
  for (const route of routes) {
    assert.ok(route.points.length >= 2);
    for (let index = 1; index < route.points.length; index += 1) {
      const previous = route.points[index - 1]; const current = route.points[index];
      assert.ok(Math.abs(previous.x - current.x) < .01 || Math.abs(previous.y - current.y) < .01);
    }
  }
  assert.equal(registry.stats().rebuilds, 0);
  registry.destroy();
});
