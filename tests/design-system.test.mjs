import test from "node:test";
import assert from "node:assert/strict";
import { AREA_TOKENS, NEUTRAL_EDGE, sourceAreaId, sourceEdgeColor, describeEdge } from "../client/src/design-system/graph-theme.js";
import { mergeReciprocalRoutes } from "../client/src/reciprocal-routes.js";

const areas = new Map([
  ["sources", { title: "Источники", colorKey: "olive" }],
  ["review", { title: "Проверка", colorKey: "leaf" }],
  ["output", { title: "Карта", colorKey: "teal" }],
]);
const makeNodes = () => new Map([
  ["a", { id: "a", data: { title: "Код", areaId: "sources" } }],
  ["b", { id: "b", data: { title: "Проверка", areaId: "review" }, selected: true }],
  ["c", { id: "c", data: { title: "Карта", areaId: "output" } }],
  ["owner", { id: "owner", data: { title: "Владелец", areaId: null } }],
]);

test("a selected destination cannot recolor a cross-area connection", () => {
  const nodes = makeNodes();
  assert.equal(sourceEdgeColor("a", nodes, areas), AREA_TOKENS.olive);
  nodes.get("a").selected = true;
  nodes.get("b").selected = false;
  assert.equal(sourceEdgeColor("a", nodes, areas), AREA_TOKENS.olive);
  assert.equal(sourceEdgeColor("b", nodes, areas), AREA_TOKENS.leaf);
});

test("area list order has no effect; returning edges keep their own source color", () => {
  const nodes = makeNodes(), reordered = new Map([...areas].reverse());
  assert.equal(sourceEdgeColor("b", nodes, reordered), AREA_TOKENS.leaf);
  assert.equal(sourceEdgeColor("c", nodes, reordered), AREA_TOKENS.teal);
  assert.notEqual(sourceEdgeColor("b", nodes, areas), sourceEdgeColor("c", nodes, areas));
});

test("a neutral source remains grey even when a parent has an area", () => {
  const nodes = makeNodes();
  nodes.get("owner").parentId = "a";
  assert.equal(sourceEdgeColor("owner", nodes, areas), NEUTRAL_EDGE);
});

test("unassigned nested nodes inherit the nearest explicitly assigned parent", () => {
  const nodes = makeNodes();
  nodes.set("child", { id: "child", parentId: "b", data: { title: "Вложенный модуль" } });
  nodes.set("deep", { id: "deep", parentId: "child", data: {} });
  assert.equal(sourceAreaId("deep", nodes), "review");
  assert.equal(sourceEdgeColor("deep", nodes, areas), AREA_TOKENS.leaf);
});

test("an unconfigured area must not silently become a neutral connection", () => {
  const nodes = makeNodes();
  nodes.get("a").data.areaId = "new-area";
  assert.throws(() => sourceEdgeColor("a", nodes, areas), /не назначен цвет/);
  const extended = new Map([...areas, ["new-area", { title: "Новая область", color: "var(--project-area-4)" }]]);
  assert.equal(sourceEdgeColor("a", nodes, extended), "var(--project-area-4)");
});

test("the accessible edge description exposes source ownership in words", () => {
  assert.equal(describeEdge({ source: "a", target: "b" }, makeNodes(), areas), "Код → Проверка. Источник: Источники.");
  assert.match(describeEdge({ source: "owner", target: "c" }, makeNodes(), areas), /Источник: вне областей/);
});

test("reciprocal exchange renders one route and retains both directed records", () => {
  const nodes = makeNodes();
  nodes.set("history", { id: "history", data: { title: "История", areaId: "output" } });
  const result = mergeReciprocalRoutes([
    { source: "c", target: "history", status: "confirmed", relations: [{ id: "save" }] },
    { source: "history", target: "c", status: "confirmed", relations: [{ id: "restore" }] },
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].bidirectional, true);
  assert.deepEqual(result[0].relations.map(item => item.id), ["save", "restore"]);
  assert.equal(sourceEdgeColor(result[0].source, nodes, areas), AREA_TOKENS.teal);
  assert.match(describeEdge(result[0], nodes, areas), /Карта ↔ История\. Взаимообмен/);
});
