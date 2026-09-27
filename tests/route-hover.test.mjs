import test from "node:test";
import assert from "node:assert/strict";
import {hoveredRouteAt} from "../client/src/route-hover.js";
const routes=[{id:"upper",points:[{x:0,y:20},{x:200,y:20}]},{id:"lower",points:[{x:0,y:30},{x:200,y:30}]}];
test("hover follows geometric proximity, not the DOM stacking order",()=>{
  assert.equal(hoveredRouteAt(routes,{x:100,y:29},1),"lower");
  assert.equal(hoveredRouteAt([...routes].reverse(),{x:100,y:21},1),"upper");
});
test("small cursor movements at a hit-area boundary do not make a line flicker",()=>{
  let current="upper";
  for(const y of [24.8,25.1,24.9,25.2,24.8]){current=hoveredRouteAt(routes,{x:100,y},1,current);assert.equal(current,"upper");}
  assert.equal(hoveredRouteAt(routes,{x:100,y:29},1,current),"lower");
  assert.equal(hoveredRouteAt(routes,{x:100,y:60},1,"lower"),null);
});
