import test from "node:test";
import assert from "node:assert/strict";

import {
  CAPTURE_RATIO, DROP_GAP, MAGNET_SCREEN_PX, boundingRect, followRouteDuringDrag,
  groupContourRect, magneticTranslation, nearestFreeTranslation, overlapRatio,
  pickDropContainer, translateRect,
} from "../client/src/drag-geometry.js";

test("an enclosing area cannot steal a partially entered nested group",()=>{
  const area={id:"area",type:"area",depth:-1,rect:{x:0,y:0,width:1000,height:1000}};
  const group={id:"group",type:"group",depth:0,rect:{x:400,y:400,width:300,height:300}};
  const moved={x:350,y:450,width:200,height:100};
  assert.equal(pickDropContainer(moved,[area,group],area.id)?.id,group.id);
});

test("group contours use their visible offset instead of the React Flow shell", () => {
  const rect = groupContourRect({ position: { x: 100, y: 200 }, style: { width: 500, height: 400 }, data: { contour: { left: -20, top: 10, width: 560, height: 430 } } });
  assert.deepEqual(rect, { x: 80, y: 210, width: 560, height: 430 });
});

test("magnetic resistance is finite in screen pixels and releases after full exit", () => {
  const source = { x: 50, y: 50, width: 100, height: 100 };
  const origin = { x: 0, y: 0, width: 200, height: 200 };
  const partial = magneticTranslation({ dx: 120, dy: 0 }, source, origin, .5);
  assert.equal(partial.resisted, true);
  assert.ok(Math.abs(partial.dx - 120) <= MAGNET_SCREEN_PX / .5 + .001);
  assert.ok(partial.dx < 120);
  const outside = magneticTranslation({ dx: 200, dy: 0 }, source, origin, .5);
  assert.deepEqual(outside, { dx: 200, dy: 0, resisted: false, detached: true });
});

test("drop targets use partial overlap with hysteresis and prefer deeper groups", () => {
  const moved = { x: 80, y: 20, width: 100, height: 100 };
  const shallow = { id: "shallow", depth: 1, rect: { x: 100, y: 0, width: 200, height: 200 } };
  const deep = { id: "deep", depth: 2, rect: { x: 100, y: 0, width: 200, height: 200 } };
  assert.ok(overlapRatio(moved, shallow.rect) >= CAPTURE_RATIO);
  assert.equal(pickDropContainer(moved, [shallow, deep])?.id, "deep");
  const barelyMoved = { ...moved, x: 191 };
  assert.equal(pickDropContainer(barelyMoved, [deep], "deep")?.id, "deep");
});

test("nearest free drop preserves the desired position when possible and clears collisions otherwise", () => {
  const source = { x: 0, y: 0, width: 100, height: 80 };
  const obstacle = { x: 180, y: 100, width: 120, height: 100 };
  assert.deepEqual(nearestFreeTranslation(source, { dx: 0, dy: 0 }, [obstacle]), { dx: 0, dy: 0, adjusted: false });
  const moved = nearestFreeTranslation(source, { dx: 190, dy: 110 }, [obstacle]);
  const settled = { ...source, x: source.x + moved.dx, y: source.y + moved.dy };
  assert.equal(overlapRatio(settled, { x: obstacle.x - DROP_GAP, y: obstacle.y - DROP_GAP, width: obstacle.width + DROP_GAP * 2, height: obstacle.height + DROP_GAP * 2 }), 0);
  assert.equal(moved.adjusted, true);
});

test("boundingRect follows a moved subtree as one composition", () => {
  assert.deepEqual(boundingRect([{ x: 20, y: 30, width: 100, height: 80 }, { x: 170, y: 10, width: 50, height: 70 }]), { x: 20, y: 10, width: 200, height: 100 });
});

test("live route preview translates a shared move and stays orthogonal for one moving endpoint", () => {
  const route = { points: [{ x: 10, y: 20 }, { x: 60, y: 20 }, { x: 60, y: 90 }, { x: 120, y: 90 }] };
  const source = { x: 0, y: 0 }; const target = { x: 100, y: 70 };
  const translated = followRouteDuringDrag(route, source, target, { x: 30, y: 40 }, { x: 130, y: 110 });
  assert.deepEqual(translated.points, [{ x: 40, y: 60 }, { x: 90, y: 60 }, { x: 90, y: 130 }, { x: 150, y: 130 }]);
  const preview = followRouteDuringDrag(route, source, target, source, { x: 300, y: 240 });
  assert.deepEqual(preview.points[0], route.points[0]);
  assert.deepEqual(preview.points.at(-1), { x: 320, y: 260 });
  for (let index = 1; index < preview.points.length; index += 1) {
    assert.ok(preview.points[index - 1].x === preview.points[index].x || preview.points[index - 1].y === preview.points[index].y);
  }
});
