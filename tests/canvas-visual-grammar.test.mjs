import test from 'node:test';
import assert from 'node:assert/strict';
import { roundedRoute, routeInk } from '../client/src/design-system/graph-theme.js';
import { protectRouteHeaders, pathEntersBoxes } from '../client/src/protected-routes.js';
import { presentSceneRoutes, routeScene } from '../client/src/route-scene.js';
import { hoveredRouteAt } from '../client/src/route-hover.js';

test('a group connection can leave its own header while other headers remain obstacles',()=>{
  const route={source:'entity:group',target:'entity:b',points:[{x:200,y:38},{x:240,y:38},{x:240,y:180},{x:400,y:180}]};
  const boxes=[{id:'entity:group',x:0,y:0,width:200,height:76},{id:'entity:b',x:400,y:140,width:120,height:80}];
  const headers=[{nodeId:'entity:group',x:0,y:0,width:200,height:76},{nodeId:'area:other',x:215,y:80,width:110,height:45}];
  const result=protectRouteHeaders(route,headers,boxes,.25);
  assert.ok(result.points.length);
  assert.deepEqual(result.points[0],route.points[0]);
  assert.deepEqual(result.points.at(-1),route.points.at(-1));
  assert.equal(pathEntersBoxes(result.points,[headers[1]]),false);
});

test('lane nudging cannot reverse a boundary port through its own node title',()=>{
  const boxes=[{id:'entity:group',x:100,y:100,width:300,height:76},{id:'b',x:500,y:0,width:120,height:80}];
  const route={source:'entity:group',target:'b',points:[{x:250,y:100},{x:250,y:210},{x:480,y:210},{x:480,y:40},{x:500,y:40}]};
  const corrected=protectRouteHeaders(route,[{nodeId:'entity:group',x:100,y:100,width:300,height:76}],boxes);
  assert.ok(corrected.points.length);
  assert.equal(pathEntersBoxes(corrected.points,boxes),false);
  assert.equal(corrected.points[0].y,100);
  assert.ok(corrected.points[1].y<100,'a north port must leave upward');
});

test('routing a row of obstacles prefers one continuous detour over a staircase',()=>{
  const route={source:'a',target:'b',points:[{x:0,y:100},{x:600,y:100}]};
  const boxes=[100,240,380].map((x,i)=>({id:'block'+i,x,y:20+i,width:80,height:140-i}));
  const result=protectRouteHeaders(route,[],boxes);
  assert.ok(result.points.length<=4,JSON.stringify(result.points));
  assert.equal(pathEntersBoxes(result.points,boxes),false);
});

test('duplicate and collinear router coordinates do not create phantom rounded corners',()=>{
  assert.equal(roundedRoute([{x:0,y:0},{x:20,y:0},{x:20,y:0},{x:40,y:0}]),'M 0 0 L 40 0');
});

test('arrow size fits the straight approach across zoom and selection',()=>{
  const points=[{x:0,y:0},{x:0,y:0},{x:24,y:0},{x:24,y:200},{x:48,y:200}];
  for(const zoom of [.1,.25,.55,1,1.7]) {
    const normal=routeInk(points,zoom),selected=routeInk(points,zoom,true);
    assert.equal(normal.arrow,selected.arrow,'selection does not resize arrowheads');
    assert.ok(normal.arrow>0&&normal.arrow<=24*zoom*.45);
    assert.ok(Number.isFinite(normal.width));
  }
});

test('a free corridor preserves orthogonal routing and only rounds its corners',()=>{
  const route={id:'ab',source:'a',target:'b',points:[{x:100,y:50},{x:140,y:50},{x:140,y:240},{x:400,y:240}]};
  const shape=presentSceneRoutes([route],routeScene([]))[0];
  assert.doesNotMatch(roundedRoute(shape.points),/ C /);
  assert.match(roundedRoute(shape.points),/ Q /);
  assert.equal(hoveredRouteAt([shape],{x:140,y:145},1),'ab');
  assert.deepEqual(shape.points,route.points,'stored geometry stays intact');
});

test('an obstacle detour uses the same rounded orthogonal pattern as a free corridor',()=>{
  const route={id:'ab',source:'a',target:'b',points:[{x:100,y:50},{x:120,y:50},{x:120,y:-80},{x:420,y:-80},{x:420,y:50},{x:440,y:50}]};
  const obstacle={id:'other',x:160,y:0,width:220,height:100};
  const shape=presentSceneRoutes([route],routeScene([{id:obstacle.id,type:'entity',position:{x:obstacle.x,y:obstacle.y},width:obstacle.width,height:obstacle.height}]))[0];
  assert.doesNotMatch(roundedRoute(shape.points),/ C /);
  assert.equal(pathEntersBoxes(shape.points,[obstacle]),false);
});
