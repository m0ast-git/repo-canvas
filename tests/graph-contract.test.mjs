import test from "node:test";
import assert from "node:assert/strict";
import {
  LIVE_WORK_MS, STALE_WORK_MS, currentWork, graphHierarchy, graphItemMoveIds, workFreshness,
} from "../client/src/graph-contract.js";

const NOW = Date.parse("2026-08-20T12:00:00.000Z");
const snapshot = {
  entities: [
    { id: "parent", areaId: "a" },
    { id: "child", areaId: "a", parentId: "parent" },
    { id: "leaf", areaId: "a", parentId: "child" },
    { id: "person", kind: "person" },
    { id: "other", areaId: "b" },
  ],
  work: [
    { id: "live", status: "active", targets: ["leaf"], updatedAt: new Date(NOW - 1_000).toISOString() },
    { id: "old", status: "active", targets: ["parent"], updatedAt: new Date(NOW - STALE_WORK_MS - 1).toISOString() },
    { id: "done", status: "done", targets: ["parent"], updatedAt: new Date(NOW).toISOString() },
  ],
};

test("work freshness distinguishes live, recent, stale and terminal records", () => {
  assert.equal(workFreshness(snapshot.work[0], NOW), "live");
  assert.equal(workFreshness({ ...snapshot.work[0], updatedAt: new Date(NOW - LIVE_WORK_MS - 1).toISOString() }, NOW), "recent");
  assert.equal(workFreshness(snapshot.work[1], NOW), "stale");
  assert.equal(workFreshness(snapshot.work[2], NOW), "terminal");
  assert.deepEqual(currentWork(snapshot, NOW).map((work) => work.id), ["live"]);
});

test("hierarchy and movement use one contract for every graph item", () => {
  assert.deepEqual([...graphHierarchy(snapshot).descendants.get("parent")].sort(), ["child", "leaf"]);
  assert.deepEqual([...graphItemMoveIds(snapshot, "entity:parent", NOW)].sort(), ["entity:child", "entity:leaf", "entity:parent", "work:live"]);
  assert.deepEqual([...graphItemMoveIds(snapshot, "area:a", NOW)].sort(), ["area:a", "entity:child", "entity:leaf", "entity:parent", "work:live"]);
  assert.deepEqual([...graphItemMoveIds(snapshot, "entity:person", NOW)], ["entity:person"]);
  assert.deepEqual([...graphItemMoveIds(snapshot, "work:live", NOW)], ["work:live"]);
});
