import test from "node:test";
import assert from "node:assert/strict";

import { placeRouteLabels, rectanglesOverlap, routeLabelScale } from "../client/src/route-label-layout.js";

function placementBox(placement) {
  return {
    x: placement.x - placement.width * placement.scale / 2,
    y: placement.y - placement.height * placement.scale / 2,
    width: placement.width * placement.scale,
    height: placement.height * placement.scale,
  };
}

test("route labels remain bounded at distant zoom", () => {
  assert.equal(routeLabelScale(.05), 2.6);
  assert.equal(routeLabelScale(.5), 2);
  assert.equal(routeLabelScale(1.4), 1);
});

test("route labels avoid visible nodes and each other", () => {
  const routes = [
    { id: "first", label: "передаёт результат", points: [{ x: 80, y: 220 }, { x: 720, y: 220 }] },
    { id: "second", label: "проверяет результат", points: [{ x: 80, y: 220 }, { x: 720, y: 220 }] },
  ];
  const obstacle = { x: 340, y: 180, width: 120, height: 80 };
  const placements = placeRouteLabels(routes, { x: 0, y: 0, zoom: 1 }, { width: 800, height: 500 }, [obstacle]);
  const first = placements.get("first");
  const second = placements.get("second");
  assert.equal(first.safe, true);
  assert.equal(second.safe, true);
  assert.equal(rectanglesOverlap(placementBox(first), obstacle, 5), false);
  assert.equal(rectanglesOverlap(placementBox(second), obstacle, 5), false);
  assert.equal(rectanglesOverlap(placementBox(first), placementBox(second), 10), false);
});

test("an unsafe fallback remains hover-only instead of pretending it is collision-free", () => {
  const route = { id: "blocked", label: "передаёт результат", points: [{ x: 20, y: 100 }, { x: 480, y: 100 }] };
  const placements = placeRouteLabels([route], { x: 0, y: 0, zoom: 1 }, { width: 500, height: 220 }, [{ x: 0, y: 0, width: 500, height: 220 }]);
  assert.equal(placements.get("blocked").safe, false);
});
