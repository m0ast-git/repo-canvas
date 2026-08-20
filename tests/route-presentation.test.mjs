import test from "node:test";
import assert from "node:assert/strict";

import { persistentRouteLabel, routesForTier, sharedTrunkRoutes } from "../client/src/route-presentation.js";

test("route selection never depends on endpoint viewport visibility", () => {
  const areaRoutes = [{ id: "area-offscreen" }];
  const detailedRoutes = [{ id: "detail-offscreen" }, { id: "detail-onscreen" }];
  assert.equal(routesForTier("area", areaRoutes, detailedRoutes), areaRoutes);
  assert.equal(routesForTier("entity", areaRoutes, detailedRoutes), detailedRoutes);
});

test("live work remains connected on the area overview", () => {
  const areaRoutes = [{ id: "areas", type: "area-relation" }];
  const detailedRoutes = [{ id: "detail", type: "relation" }, { id: "live", type: "work" }];
  assert.deepEqual(routesForTier("area", areaRoutes, detailedRoutes).map((route) => route.id), ["areas", "live"]);
});

test("a relation label stays visible whenever collision placement is safe", () => {
  const route = { label: "передаёт нормализованный поток" };
  assert.equal(persistentRouteLabel(route, { safe: true }), true);
  assert.equal(persistentRouteLabel(route, { safe: false }), false);
  assert.equal(persistentRouteLabel({ label: "" }, { safe: true }), false);
});

test("compatible binary relations receive a short selectable shared trunk", () => {
  const relation = (id, target, y) => ({
    id: `route:${id}`, source: "entity:source", target, type: "relation", color: "#e88962",
    points: [{ x: 100, y: 100 }, { x: 220, y: 100 }, { x: 220, y }],
    relations: [{ id, from: "source", to: target.replace("entity:", "") }],
  });
  const trunks = sharedTrunkRoutes([relation("a", "entity:a", 40), relation("b", "entity:b", 180)]);
  assert.equal(trunks.length, 1);
  assert.deepEqual(trunks[0].points, [{ x: 100, y: 100 }, { x: 172, y: 100 }]);
  assert.deepEqual(trunks[0].relations.map((item) => item.id), ["a", "b"]);
});

test("dense or directionally incompatible branches stay as ordinary binary routes", () => {
  const routes = Array.from({ length: 5 }, (_, index) => ({
    id: `route:${index}`, source: "entity:source", target: `entity:${index}`, type: "relation", color: "#e88962",
    points: [{ x: 100, y: 100 }, { x: 200, y: 100 }], relations: [{ id: String(index), from: "source", to: String(index) }],
  }));
  assert.equal(sharedTrunkRoutes(routes).length, 0);
});
