import test from 'node:test';
import assert from 'node:assert/strict';
import { assignAreaColors, areaColor, routeColors } from '../client/src/design-system/project-theme.js';
import { protectRouteHeaders, pathEntersBoxes } from '../client/src/protected-routes.js';
import { mergeReciprocalRoutes } from '../client/src/reciprocal-routes.js';

test('area colors survive reorder, deletion, insertion, and theme changes',()=>{
  const areas=['a','b','c','d'].map(id=>({id}));const first=assignAreaColors(areas);
  assert.equal(new Set(areas.map(area=>areaColor({...area,colorSlot:first[area.id]}))).size,4);
  assert.deepEqual(assignAreaColors([...areas].reverse(),first),first);
  const next=assignAreaColors([{id:'0'},areas[2],areas[0]],first);
  for(const area of areas)assert.equal(next[area.id],first[area.id]);
  assert.notEqual(areaColor({...areas[0],colorSlot:first.a},'dark'),areaColor({...areas[0],colorSlot:first.a},'light'));
});
test('cross-area exchange carries both source colors and neutral sources stay grey',()=>{
  const entities=new Map([['a',{id:'a',areaId:null}],['b',{id:'b',areaId:'green'}]]),colors=new Map([['green','#5B8F69']]);
  const route={source:'entity:a',target:'entity:b',sourceAreaId:'green',bidirectional:true};
  assert.deepEqual(routeColors(route,entities,colors),{color:'#777777',reverseColor:'#5B8F69'});
});
test('reciprocal routes merge only compatible physical ports and channels',()=>{
  const forward={source:'a',target:'b',sourceHandle:'source-right',targetHandle:'target-left',status:'existing',channel:'events',relations:[{id:'one'}]};
  const reverse={source:'b',target:'a',sourceHandle:'source-left',targetHandle:'target-right',status:'existing',channel:'events',relations:[{id:'two'}]};
  assert.equal(mergeReciprocalRoutes([forward,reverse]).length,1);
  assert.equal(mergeReciprocalRoutes([forward,{...reverse,channel:'files'}]).length,2);
  assert.equal(mergeReciprocalRoutes([forward,{...reverse,targetHandle:'target-top'}]).length,2);
});
test('a line detours around measured area text without moving its endpoints or stored path',()=>{
  const route={source:'a',target:'b',points:[{x:0,y:50},{x:300,y:50}]},original=structuredClone(route);
  const headers=[{x:100,y:30,width:100,height:40}];
  const fixed=protectRouteHeaders(route,headers,[],1);
  assert.equal(fixed.blockedByHeader,undefined);
  assert.equal(pathEntersBoxes(fixed.points,headers),false);
  assert.deepEqual(fixed.points[0],route.points[0]);assert.deepEqual(fixed.points.at(-1),route.points.at(-1));
  assert.deepEqual(route,original);
});
test('zoom, longer titles, and moved obstacles are included in route protection',()=>{
  const route={source:'a',target:'b',points:[{x:0,y:0},{x:500,y:0}]};
  for(const zoom of [.2,.6,1,1.7]){
    const headers=[{x:180,y:-15,width:120,height:40}],nodes=[{id:'other',x:160,y:60,width:180,height:100}];
    const fixed=protectRouteHeaders(route,headers,nodes,zoom);
    assert.ok(fixed.points.length>2);
    assert.equal(pathEntersBoxes(fixed.points,[...headers,...nodes]),false);
  }
});
test('area endpoints move along the boundary when the old port enters its title',()=>{
  const node={id:'area:a',x:0,y:0,width:220,height:180};
  const route={source:node.id,target:'b',points:[{x:110,y:0},{x:110,y:-120},{x:400,y:-120}]};
  const fixed=protectRouteHeaders(route,[{nodeId:node.id,x:10,y:4,width:200,height:35}],[node],1);
  assert.ok(fixed.points.length);
  assert.equal(pathEntersBoxes(fixed.points,[node]),false);
  assert.ok(fixed.points[0].x===node.x||fixed.points[0].x===node.x+node.width||fixed.points[0].y===node.y+node.height);
});
test('a clear route is reused, so unblocked routes do not get unnecessary geometry changes',()=>{
  const route={source:'a',target:'b',points:[{x:0,y:0},{x:50,y:0}]};
  assert.equal(protectRouteHeaders(route,[{x:500,y:200,width:100,height:40}],[],1),route);
});
test('resized cards remain obstacles and the detour leaves room for rounded corners',()=>{
  const route={source:'a',target:'b',points:[{x:20,y:50},{x:320,y:50}]};
  const cards=[{id:'a',x:0,y:30,width:20,height:40},{id:'other',x:100,y:30,width:100,height:40},{id:'b',x:320,y:30,width:20,height:40}];
  const fixed=protectRouteHeaders(route,[],cards,1);
  assert.ok(fixed.points.length>2);
  assert.deepEqual(fixed.points[0],route.points[0]);assert.deepEqual(fixed.points.at(-1),route.points.at(-1));
  assert.equal(pathEntersBoxes(fixed.points,cards),false);
  assert.ok(fixed.points.some(point=>point.y<=12||point.y>=88));
});
