import test from "node:test";
import assert from "node:assert/strict";

import { persistentRouteLabel, routeVisualKind } from "../client/src/route-presentation.js";

test("only explicitly pinned labels persist; hover and selection reveal other labels", () => {
  const route = { label: "передаёт нормализованный поток" };
  assert.equal(persistentRouteLabel(route, { safe: true }), false);
  assert.equal(persistentRouteLabel({...route,labelPinned:true}, { safe: true }), true);
  assert.equal(persistentRouteLabel(route, { safe: false }), false);
  assert.equal(persistentRouteLabel({ label: "" }, { safe: true }), false);
});

test("line semantics distinguish confirmed, planned and live work routes", () => {
  assert.equal(routeVisualKind({ type: "relation", status: "existing" }), "confirmed");
  assert.equal(routeVisualKind({ type: "relation", status: "planned" }), "planned");
  assert.equal(routeVisualKind({ type: "work", status: "active" }), "work-association");
  assert.equal(routeVisualKind({ type: "work", status: "blocked" }), "work-association");
  assert.equal(routeVisualKind({ type: "work", status: "planned" }), "planned");
});
