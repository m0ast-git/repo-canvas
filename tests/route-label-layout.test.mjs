import test from "node:test";
import assert from "node:assert/strict";

import { placeRouteLabels, rectanglesOverlap, routeLabelScale, ROUTE_LABEL_FONT_SIZE } from "../client/src/route-label-layout.js";

function placementBox(placement) {
  return {
    x: placement.x - placement.width * placement.scale / 2,
    y: placement.y - placement.height * placement.scale / 2,
    width: placement.width * placement.scale,
    height: placement.height * placement.scale,
  };
}

test("relationship text stays subordinate to the elements it connects", () => {
  assert.equal(ROUTE_LABEL_FONT_SIZE*routeLabelScale(.05,true)*.05, 12);
  for(const zoom of [.05,.2,.5,1,1.4,2]) {
    const caption=ROUTE_LABEL_FONT_SIZE*routeLabelScale(zoom)*zoom;
    assert.ok(caption<=15*zoom,"Caption exceeds node body text");
    assert.ok(caption<=18*zoom*.75,"Caption approaches the node heading");
  }
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

test("no caption is placed over occupied space, including pinned or hovered routes", () => {
  const route = { id: "blocked", label: "передаёт результат", points: [{ x: 20, y: 100 }, { x: 480, y: 100 }] };
  const placements = placeRouteLabels([route], { x: 0, y: 0, zoom: 1 }, { width: 500, height: 220 }, [{ x: 0, y: 0, width: 500, height: 220 }]);
  assert.equal(placements.has("blocked"), false);
});
