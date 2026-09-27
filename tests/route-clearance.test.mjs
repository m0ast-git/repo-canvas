import test from "node:test";
import assert from "node:assert/strict";
import {separateParallelRoutes} from "../client/src/route-clearance.js";
test("compressed interior lanes separate without moving endpoints or entering nodes",()=>{
  const routes=[{id:"a",source:"source",target:"one",points:[{x:10,y:0},{x:10,y:20},{x:200,y:20},{x:200,y:200}]},{id:"b",source:"source",target:"two",points:[{x:30,y:0},{x:30,y:23.6},{x:180,y:23.6},{x:180,y:220}]}];
  const result=separateParallelRoutes(routes,[{id:"source",x:0,y:-40,width:50,height:40}]);
  assert.ok(Math.abs(result[0].points[1].y-result[1].points[1].y)>=12);
  for(let i=0;i<routes.length;i++){
    assert.deepEqual(result[i].points[0],routes[i].points[0]);assert.deepEqual(result[i].points.at(-1),routes[i].points.at(-1));
    assert.ok(result[i].points.slice(1).every((b,j)=>Math.abs(b.x-result[i].points[j].x)<.01||Math.abs(b.y-result[i].points[j].y)<.01));
  }
  assert.equal(routes[0].points[1].y,20,"Input geometry must stay immutable");
});
