import test from "node:test";
import assert from "node:assert/strict";
import { settleCanvasDrop } from "../client/src/drag-settlement.js";
import { intersectionArea } from "../client/src/drag-geometry.js";

test('a small move in the first row does not eject a card past its area header',()=>{
  const snapshot={areas:[{id:'a'}],entities:[{id:'moving',areaId:'a'},{id:'below',areaId:'a'}],relations:[],work:[]};
  const nodes=[{id:'area:a',type:'area',position:{x:32,y:32},width:1352,height:680,data:{area:snapshot.areas[0]}},...snapshot.entities.map((entity,i)=>({id:`entity:${entity.id}`,type:'entity',position:{x:56,y:i?344:156},width:268,height:132,data:{entity}}))];
  const origin={id:'area:a',type:'area',areaId:'a',rect:{x:32,y:32,width:1352,height:680}};
  const context={id:'entity:moving',kind:'entity',entityId:'moving',canReparent:true,originalAreaId:'a',originalParentId:'',origin,containers:[origin],affected:new Set(['entity:moving']),positions:new Map([['entity:moving',nodes[1].position]]),sourceBounds:{x:56,y:156,width:268,height:132},lastTranslation:{dx:12,dy:26},pointer:{x:148,y:220}};
  const result=settleCanvasDrop(snapshot,nodes,context);
  const moved=result.finalMoves.find(item=>item.id==='entity:moving');
  assert.equal(moved.x,68);assert.equal(moved.y,182);assert.equal(result.nextAreaId,'a');
});

test("moving inside an area preserves neighbours and moves the entire selected subtree", () => {
  const snapshot = {areas:[{id:"a"}],entities:[{id:"parent",areaId:"a"},{id:"child",areaId:"a",parentId:"parent"},{id:"other",areaId:"a"}],relations:[],work:[]};
  const nodes = ["parent","child","other"].map((id,i)=>({id:`entity:${id}`,type:"entity",position:{x:i===2?500:100+i*100,y:200},width:80,height:60,data:{entity:snapshot.entities[i]}}));
  const origin={id:"area:a",type:"area",areaId:"a",rect:{x:0,y:0,width:1000,height:1000}};
  const context={id:"entity:parent",kind:"entity",entityId:"parent",canReparent:true,originalAreaId:"a",originalParentId:"",origin,containers:[origin],affected:new Set(["entity:parent","entity:child"]),positions:new Map(nodes.slice(0,2).map(n=>[n.id,n.position])),sourceBounds:{x:100,y:200,width:180,height:60},lastTranslation:{dx:35,dy:20},pointer:{x:135,y:220}};
  const result=settleCanvasDrop(snapshot,nodes,context);
  assert.deepEqual(result.finalMoves,[{id:"entity:parent",x:135,y:220},{id:"entity:child",x:235,y:220}]);
  assert.equal(result.nextParentId,"");
  assert.equal(result.nextAreaId,"a");
});

test("a drop onto a neighbour in the same area keeps both objects separate", () => {
  const snapshot={areas:[{id:"a"}],entities:[{id:"moving",areaId:"a"},{id:"fixed",areaId:"a"}],relations:[],work:[]};
  const nodes=snapshot.entities.map((entity,i)=>({id:`entity:${entity.id}`,type:"entity",position:{x:100+i*160,y:220},width:100,height:80,data:{entity}}));
  const origin={id:"area:a",type:"area",areaId:"a",rect:{x:0,y:0,width:1000,height:1000}};
  const context={id:"entity:moving",kind:"entity",canReparent:true,originalAreaId:"a",originalParentId:"",origin,containers:[origin],affected:new Set(["entity:moving"]),positions:new Map([["entity:moving",nodes[0].position]]),sourceBounds:{x:100,y:220,width:100,height:80},lastTranslation:{dx:160,dy:0},pointer:{x:300,y:250}};
  const result=settleCanvasDrop(snapshot,nodes,context);
  assert.equal(result.finalMoves.length,1,"The neighbour must not be repacked");
  assert.equal(result.nextAreaId,"a");
  assert.equal(intersectionArea({...result.finalMoves[0],width:100,height:80},{...nodes[1].position,width:100,height:80}),0);
  assert.deepEqual(nodes[1].position,{x:260,y:220});
});
