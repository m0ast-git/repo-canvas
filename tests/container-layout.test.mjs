import test from "node:test";
import assert from "node:assert/strict";

import {
  CONTAINER_ITEM_GAP, CONTAINER_PADDING_X, CONTAINER_PADDING_Y,
  compactContainerMembership, normalizeStoredEntityPositions, orderItemsForDrop, packVerticalContainer,
} from "../client/src/container-layout.js";

test("legacy stored overlaps fall back to collision-free layout positions", () => {
  const snapshot = {
    entities: [
      { id: "first", areaId: "area", parentId: "" },
      { id: "second", areaId: "area", parentId: "" },
    ],
  };
  const current = new Map([
    ["first", { x: 100, y: 200, width: 120, height: 80 }],
    ["second", { x: 120, y: 220, width: 120, height: 80 }],
  ]);
  const defaults = new Map([
    ["first", { x: 100, y: 200, width: 120, height: 80 }],
    ["second", { x: 420, y: 200, width: 120, height: 80 }],
  ]);
  const normalized = normalizeStoredEntityPositions(snapshot, current, defaults, new Map([
    ["area", { x: 0, y: 0, width: 800, height: 600 }],
  ]));
  assert.deepEqual(normalized.get("first"), current.get("first"));
  assert.deepEqual(normalized.get("second"), defaults.get("second"));
});

test("legacy children clear their container header and each other as whole subtrees", () => {
  const snapshot = {
    entities: [
      { id: "group", areaId: "area", parentId: "" },
      { id: "first", areaId: "area", parentId: "group" },
      { id: "second", areaId: "area", parentId: "group" },
    ],
  };
  const group = { x: 500, y: 200, width: 420, height: 520, headerWidth: 320, headerHeight: 76 };
  const defaultGroup = { ...group, x: 100 };
  const current = new Map([
    ["group", group],
    ["first", { x: 530, y: 220, width: 120, height: 80 }],
    ["second", { x: 540, y: 230, width: 120, height: 80 }],
  ]);
  const defaults = new Map([
    ["group", defaultGroup],
    ["first", { x: 140, y: 330, width: 120, height: 80 }],
    ["second", { x: 140, y: 490, width: 120, height: 80 }],
  ]);
  const normalized = normalizeStoredEntityPositions(snapshot, current, defaults, new Map([
    ["area", { x: 0, y: 0, width: 900, height: 800 }],
  ]));
  const header = { x: group.x, y: group.y, width: group.headerWidth, height: group.headerHeight };
  const overlap = (a, b, gap = 0) => a.x - gap < b.x + b.width && a.x + a.width + gap > b.x && a.y - gap < b.y + b.height && a.y + a.height + gap > b.y;
  assert.equal(overlap(normalized.get("first"), header, 36), false);
  assert.equal(overlap(normalized.get("second"), header, 36), false);
  assert.equal(overlap(normalized.get("first"), normalized.get("second"), 36), false);
  assert.equal(normalized.get("first").x, 540);
  assert.equal(normalized.get("second").x, 540);
});

test("drop order uses the pointer only as an insertion index", () => {
  const items = [
    { id: "first", rect: { x: 40, y: 200, width: 100, height: 80 } },
    { id: "last", rect: { x: 40, y: 600, width: 100, height: 80 } },
    { id: "moving", rect: { x: 900, y: 900, width: 100, height: 80 } },
  ];
  assert.deepEqual(orderItemsForDrop(items, "moving", 500).map((item) => item.id), ["first", "moving", "last"]);
});

test("container packing removes holes and grows around every item", () => {
  const containerRect = { x: 300, y: 100, width: 240, height: 900 };
  const headerRect = { x: 300, y: 100, width: 240, height: 76 };
  const items = [
    { id: "first", rect: { x: 340, y: 210, width: 120, height: 80 } },
    { id: "last", rect: { x: 340, y: 700, width: 140, height: 100 } },
    { id: "moving", rect: { x: 900, y: 900, width: 130, height: 90 } },
  ];
  const packed = packVerticalContainer({ containerRect, headerRect, items, movingId: "moving", dropCenterY: 500 });
  assert.deepEqual(packed.placements.map(({ id, x, y }) => ({ id, x, y })), [
    { id: "first", x: containerRect.x + CONTAINER_PADDING_X, y: headerRect.y + headerRect.height + CONTAINER_PADDING_Y },
    { id: "moving", x: containerRect.x + CONTAINER_PADDING_X, y: headerRect.y + headerRect.height + CONTAINER_PADDING_Y + 80 + CONTAINER_ITEM_GAP },
    { id: "last", x: containerRect.x + CONTAINER_PADDING_X, y: headerRect.y + headerRect.height + CONTAINER_PADDING_Y + 80 + CONTAINER_ITEM_GAP + 90 + CONTAINER_ITEM_GAP },
  ]);
  assert.equal(packed.height, packed.placements.at(-1).y + 100 + CONTAINER_PADDING_Y - containerRect.y);
});

test("membership change compacts the source and inserts into the target atomically", () => {
  const snapshot = {
    entities: [
      { id: "group", parentId: "" },
      { id: "first", parentId: "group" },
      { id: "moving", parentId: "group" },
      { id: "last", parentId: "group" },
    ],
  };
  const group = {
    id: "entity:group", type: "group", position: { x: 0, y: 0 },
    style: { width: 280, height: 500 }, data: { headerWidth: 280, headerHeight: 76 },
  };
  const card = (id, y) => ({ id: `entity:${id}`, type: "entity", position: { x: 40, y }, style: { width: 100, height: 80 } });
  const nodes = [group, card("first", 116), card("moving", 272), card("last", 428)];
  const detached = compactContainerMembership(snapshot, nodes, {
    entityId: "moving", originalParentId: "group",
    positions: new Map([["entity:moving", { x: 40, y: 272 }]]),
  }, "", { dx: 500, dy: 0 }, 312);
  const detachedMoves = new Map(detached.moves.map((move) => [move.id, move]));
  assert.deepEqual({ x: detachedMoves.get("entity:last").x, y: detachedMoves.get("entity:last").y }, { x: 40, y: 272 });
  assert.deepEqual({ x: detachedMoves.get("entity:moving").x, y: detachedMoves.get("entity:moving").y }, { x: 540, y: 272 });

  const detachedSnapshot = { ...snapshot, entities: snapshot.entities.map((entity) => entity.id === "moving" ? { ...entity, parentId: "" } : entity) };
  const detachedNodes = [group, card("first", 116), card("last", 272), { ...card("moving", 272), position: { x: 540, y: 272 } }];
  const attached = compactContainerMembership(detachedSnapshot, detachedNodes, {
    entityId: "moving", originalParentId: "",
    positions: new Map([["entity:moving", { x: 540, y: 272 }]]),
  }, "group", { dx: 0, dy: 0 }, 250);
  const attachedMoves = new Map(attached.moves.map((move) => [move.id, move]));
  assert.deepEqual({ x: attachedMoves.get("entity:moving").x, y: attachedMoves.get("entity:moving").y }, { x: 40, y: 272 });
  assert.deepEqual({ x: attachedMoves.get("entity:last").x, y: attachedMoves.get("entity:last").y }, { x: 40, y: 428 });
});
