import test from "node:test";
import assert from "node:assert/strict";

import { settleViewportTransform } from "../client/src/viewport-geometry.js";

test("zoom snapping keeps the cursor's world point fixed", () => {
  const current = { x: -320, y: 140, zoom: .513 };
  const anchor = { x: 760, y: 410 };
  const worldBefore = {
    x: (anchor.x - current.x) / current.zoom,
    y: (anchor.y - current.y) / current.zoom,
  };
  const next = settleViewportTransform(current, { width: 1200, height: 800 }, anchor, 1);
  assert.ok(Math.abs(worldBefore.x * next.zoom + next.x - anchor.x) <= .5);
  assert.ok(Math.abs(worldBefore.y * next.zoom + next.y - anchor.y) <= .5);
});

test("toolbar zoom falls back to the viewport centre", () => {
  const current = { x: -200, y: -100, zoom: .387 };
  const size = { width: 1000, height: 700 };
  const centre = { x: size.width / 2, y: size.height / 2 };
  const worldBefore = {
    x: (centre.x - current.x) / current.zoom,
    y: (centre.y - current.y) / current.zoom,
  };
  const next = settleViewportTransform(current, size, null, 1);
  assert.ok(Math.abs(worldBefore.x * next.zoom + next.x - centre.x) <= .5);
  assert.ok(Math.abs(worldBefore.y * next.zoom + next.y - centre.y) <= .5);
});
