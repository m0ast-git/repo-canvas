import test from 'node:test';
import assert from 'node:assert/strict';
import {routeScene,routeSceneKey,presentSceneRoutes,isContainmentRoute} from '../client/src/route-scene.js';
import {graphHierarchy} from '../client/src/graph-contract.js';
import {settleCanvasDrop} from '../client/src/drag-settlement.js';
import {settleViewportTransform} from '../client/src/viewport-geometry.js';
import {normalizeArchitecture,validateArchitecture} from '../repo-canvas/scripts/semantic-model.mjs';

const node=(id,type,x,y,width,height,data={})=>({id,type,position:{x,y},width,height,style:{width,height},data});
test('routing is a property of world geometry, unaffected by viewport culling and LOD',()=>{
  const nodes=[node('area:a','area',-80,-150,950,700),node('entity:a','entity',0,0,100,60),node('entity:b','entity',600,0,100,60),node('entity:block','group',260,-30,200,250,{headerHeight:76})];
  const routes=[{id:'ab',source:'entity:a',target:'entity:b',points:[{x:100,y:30},{x:600,y:30}]}];
  const scene=routeScene(nodes),expected=presentSceneRoutes(routes,scene);
  for(const zoom of [.1,.25,.55,1,1.7]) {
    const changed=nodes.map(n=>({...n,hidden:zoom>.4,data:{...n.data,detail:zoom>.5?'full':'compact',selected:zoom===1}}));
    assert.equal(routeSceneKey(changed),routeSceneKey(nodes));
    assert.deepEqual(presentSceneRoutes(routes,routeScene(changed)),expected);
  }
  assert.equal(expected[0].points.length,0,'An obstructed preview waits for the native router');
  assert.equal(expected[0].preview,true);
});

test('group connections terminate on the outside frame, with outward tangents',()=>{
  const nodes=[node('entity:g','group',0,0,400,360,{headerHeight:76}),node('entity:child','entity',30,130,130,80),node('entity:out','entity',120,620,140,80)];
  const route={id:'edge',source:'entity:g',target:'entity:out',points:[{x:180,y:76},{x:180,y:100},{x:190,y:600},{x:190,y:620}]};
  const actual=presentSceneRoutes([route],routeScene(nodes))[0];
  assert.ok(actual.points.length);assert.equal(actual.points[0].y,360);
  assert.ok(actual.points[1].y>360);
  const hierarchy=graphHierarchy({entities:[{id:'g'},{id:'child',parentId:'g'},{id:'nested',parentId:'child'}]}).descendants;
  assert.equal(isContainmentRoute({source:'entity:g',target:'entity:nested'},hierarchy),true);
  assert.equal(isContainmentRoute({source:'entity:child',target:'entity:g'},hierarchy),true);
  assert.equal(isContainmentRoute({source:'entity:child',target:'entity:out'},hierarchy),false);
});

function dragFixture() {
  const snapshot={areas:[{id:'a'}],entities:[{id:'n',areaId:'a',kind:'module'}],work:[]};
  const nodes=[node('area:a','area',0,0,600,500,{area:snapshot.areas[0]}),node('entity:n','entity',200,200,100,80,{entity:snapshot.entities[0]})];
  const origin={id:'area:a',type:'area',areaId:'a',rect:{x:0,y:0,width:600,height:500}};
  const context={id:'entity:n',entityId:'n',kind:'entity',canReparent:true,originalAreaId:'a',originalParentId:'',snapshot,origin,containers:[origin],positions:new Map([['entity:n',nodes[1].position]]),sourceBounds:{x:200,y:200,width:100,height:80},affected:new Set(['entity:n']),pointer:{x:0,y:0}};
  return {snapshot,nodes,context};
}
test('dragging out in every direction releases ownership without resizing or moving the source area',()=>{
  for(const [dx,dy] of [[400,0],[0,350],[-280,0],[0,-260]]) {
    const {snapshot,nodes,context}=dragFixture();context.lastTranslation={dx,dy};
    const result=settleCanvasDrop(snapshot,nodes,context);
    assert.equal(result.nextAreaId,'');assert.equal(result.nextParentId,'');
    assert.deepEqual([...result.changedAreaEntityIds],['n']);
    assert.equal(result.finalMoves.some(move=>move.id==='area:a'),false);
  }
});
test('source area stays fixed while a partially overlapping node approaches its boundary',()=>{
  const {snapshot,nodes,context}=dragFixture();context.lastTranslation={dx:330,dy:0};
  const result=settleCanvasDrop(snapshot,nodes,context);
  assert.equal(result.nextAreaId,'a');assert.equal(result.finalMoves.some(move=>move.id==='area:a'),false);
});
test('an incoming node grows only the destination and leaves its source frame untouched',()=>{
  const {snapshot,nodes,context}=dragFixture();
  snapshot.areas.push({id:'b'});nodes.push(node('area:b','area',1000,0,300,230,{area:snapshot.areas[1]}));
  context.containers.push({id:'area:b',type:'area',areaId:'b',rect:{x:1000,y:0,width:300,height:230},depth:-1});
  context.lastTranslation={dx:850,dy:0};context.pointer={x:1100,y:220};
  const result=settleCanvasDrop(snapshot,nodes,context);
  assert.equal(result.nextAreaId,'b');assert.equal(result.finalMoves.some(move=>move.id==='area:a'),false);
  const grown=result.finalMoves.find(move=>move.id==='area:b');assert.ok(grown.width>=300&&grown.height>=230);
});
test('wheel zoom does not jump to a different scale when a gesture finishes',()=>{
  assert.equal(settleViewportTransform({x:12,y:24,zoom:.513},{width:1000,height:800}).zoom,.513);
});
test('architect refresh respects an explicit owner choice to keep an object outside all areas',()=>{
  const snapshot={areas:[{id:'a',title:'Area'}],entities:[{id:'n',label:'Node',kind:'module',areaId:'',ownerAreaId:'',ownerParentId:''}],relations:[]};
  const value={areas:[],entities:[{id:'n',label:'Node',kind:'module',areaId:'a',parentId:''}],relations:[],removedAreaIds:[],removedEntityIds:[],removedRelationIds:[]};
  const actual=normalizeArchitecture(value,snapshot);
  assert.equal(actual.entities[0].areaId,'');assert.doesNotThrow(()=>validateArchitecture(actual,snapshot));
});
