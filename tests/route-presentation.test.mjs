import test from "node:test";
import assert from "node:assert/strict";

import { persistentRouteLabel, routesForTier } from "../client/src/route-presentation.js";

test("route selection never depends on endpoint viewport visibility", () => {
  const areaRoutes = [{ id: "area-offscreen" }];
  const detailedRoutes = [{ id: "detail-offscreen" }, { id: "detail-onscreen" }];
  assert.equal(routesForTier("area", areaRoutes, detailedRoutes), areaRoutes);
  assert.equal(routesForTier("entity", areaRoutes, detailedRoutes), detailedRoutes);
});

test("a relation label stays visible whenever collision placement is safe", () => {
  const route = { label: "передаёт нормализованный поток" };
  assert.equal(persistentRouteLabel(route, { safe: true }), true);
  assert.equal(persistentRouteLabel(route, { safe: false }), false);
  assert.equal(persistentRouteLabel({ label: "" }, { safe: true }), false);
});
