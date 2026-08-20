import test from "node:test";
import assert from "node:assert/strict";

import {
  buildSearchItems, focusForSelection, OFFSCREEN_CHIP_SIZE, offscreenChip, routeMatchesFocus,
  routeSelection, screenTextReadable, searchCanvas, selectionKey, spreadOffscreenChips,
} from "../client/src/interaction-model.js";

const entities = new Map([
  ["source", { id: "source", areaId: "alpha" }],
  ["target", { id: "target", areaId: "beta" }],
  ["distant", { id: "distant", areaId: "gamma" }],
]);
const relation = { id: "flow", from: "source", to: "target", label: "передаёт заказ" };
const route = { id: "route:flow", source: "entity:source", target: "entity:target", relations: [relation] };

test("route selection produces a one-hop focus without transitive entities", () => {
  const selection = routeSelection(route);
  const focus = focusForSelection(selection, entities);
  assert.deepEqual([...focus.relationIds], ["flow"]);
  assert.equal(focus.nodeIds.has("entity:source"), true);
  assert.equal(focus.nodeIds.has("entity:target"), true);
  assert.equal(focus.nodeIds.has("entity:distant"), false);
  assert.equal(routeMatchesFocus(route, focus), true);
  assert.equal(selectionKey(selection), "route:flow:");
});

test("a concrete relation inside a bundle narrows the focus", () => {
  const second = { id: "audit", from: "source", to: "distant", label: "проверяет" };
  const bundle = { ...route, relations: [relation, second] };
  const focus = focusForSelection(routeSelection(bundle, "audit"), entities);
  assert.deepEqual([...focus.relationIds], ["audit"]);
  assert.equal(focus.nodeIds.has("entity:target"), false);
  assert.equal(focus.nodeIds.has("entity:distant"), true);
});

test("readability is based on screen pixels rather than click count", () => {
  assert.equal(screenTextReadable(.25, "entity", 12), false);
  assert.equal(screenTextReadable(.8, "entity", 12), true);
});

test("search ranks exact and prefix matches across areas, entities and work", () => {
  const items = buildSearchItems({
    areas: [{ id: "orders", title: "Заказы" }],
    entities: [{ id: "checkout", areaId: "orders", label: "Оформление заказа", purpose: "Создаёт заказ" }],
  }, [{ id: "run", title: "Проверка заказа", actor: "codex", targets: ["checkout"] }]);
  assert.equal(searchCanvas(items, "заказы")[0].kind, "area");
  assert.equal(searchCanvas(items, "оформление")[0].id, "checkout");
  assert.equal(searchCanvas(items, "codex заказ")[0].kind, "work");
});

test("off-screen chips project targets to the nearest viewport edge", () => {
  const viewport = { x: 0, y: 0, zoom: 1 };
  const size = { width: 800, height: 600 };
  const right = offscreenChip(viewport, size, { x: 1000, y: 280, width: 20, height: 20 });
  const top = offscreenChip(viewport, size, { x: 390, y: -200, width: 20, height: 20 });
  assert.equal(right.side, "right");
  assert.equal(right.x - OFFSCREEN_CHIP_SIZE.width, size.width - OFFSCREEN_CHIP_SIZE.margin - OFFSCREEN_CHIP_SIZE.width);
  assert.ok(right.y >= OFFSCREEN_CHIP_SIZE.margin + OFFSCREEN_CHIP_SIZE.height / 2);
  assert.equal(top.side, "top");
  assert.ok(top.x >= OFFSCREEN_CHIP_SIZE.margin + OFFSCREEN_CHIP_SIZE.width / 2);
  assert.equal(offscreenChip(viewport, size, { x: 390, y: 280, width: 20, height: 20 }), null);
});

test("off-screen mini-nodes spread along a shared edge without overlapping", () => {
  const spread = spreadOffscreenChips([
    { id: "a", side: "left", x: 12, y: 200 },
    { id: "b", side: "left", x: 12, y: 204 },
  ], { width: 800, height: 600 });
  assert.ok(spread[1].y - spread[0].y >= OFFSCREEN_CHIP_SIZE.height + 8);
  assert.ok(spread[0].y >= OFFSCREEN_CHIP_SIZE.margin + OFFSCREEN_CHIP_SIZE.height / 2);
  assert.ok(spread[1].y <= 600 - OFFSCREEN_CHIP_SIZE.margin - OFFSCREEN_CHIP_SIZE.height / 2);
});
