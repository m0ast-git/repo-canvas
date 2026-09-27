import test from 'node:test';
import assert from 'node:assert/strict';
import {canvasDetail} from '../client/src/canvas-detail.js';
import {graphWithConnectionPorts} from '../client/src/connection-ports.js';
import {protectRouteHeaders,compactRoutePoints} from '../client/src/protected-routes.js';
import {packAreaGrid} from '../client/src/container-layout.js';
import {createRoutingScope,routesFromRoutingResults,applyRoutingMoves} from '../client/src/routing-scopes.js';

test('LOD removes detail by screen size without modifying world geometry',()=>{
  const rect={id:'node',x:30,y:40,width:268,height:132},before={...rect};
  assert.equal(canvasDetail(rect,1),'full');
  assert.equal(canvasDetail(rect,.75),'preview');
  assert.equal(canvasDetail(rect,.55),'compact');
  assert.equal(canvasDetail(rect,.25),'label');
  assert.equal(canvasDetail(rect,.1),'silhouette');
  assert.equal(canvasDetail({...rect,width:536,height:264},.5),'full');
  assert.deepEqual(rect,before);
});
test('each fan-out connection has its own boundary port and allocation is deterministic',()=>{
  const nodes=[{id:'a',x:0,y:0,width:260,height:132},...Array.from({length:5},(_,i)=>({id:`b${i}`,x:400,y:i*180,width:260,height:132}))];
  const edges=nodes.slice(1).map(node=>({id:`a-${node.id}`,source:'a',target:node.id}));
  const graph=graphWithConnectionPorts(nodes,edges);
  assert.equal(new Set(graph.children[0].ports.map(p=>`${p.x},${p.y}`)).size,5);
  for(const node of graph.children)for(const port of node.ports){assert.ok(port.x===0||port.y===0||port.x===node.width||port.y===node.height);assert.ok(port.x>=0&&port.y>=0&&port.x<=node.width&&port.y<=node.height);}
  assert.deepEqual(graph,graphWithConnectionPorts(nodes,edges));
  assert.equal(nodes[0].ports,undefined);
});
test('low zoom header protection leaves an exit for a group connection',()=>{
  const group={id:'a',x:0,y:0,width:320,height:96};
  const route={source:'a',target:'b',points:[{x:320,y:48},{x:480,y:48},{x:480,y:250}]};
  const result=protectRouteHeaders(route,[{nodeId:'a',x:38,y:16,width:240,height:34}],[group],.2);
  assert.ok(result.points.length>1);assert.equal(result.blockedByHeader,undefined);
});
test('initial packing keeps the model order even when every local position is zero',()=>{
  const items=['sources','core','result'].map(id=>({id,rect:{x:0,y:0,width:268,height:132}}));
  const packed=packAreaGrid({areaRect:{x:0,y:0},items,preserveOrder:true});
  assert.deepEqual(packed.placements.map(item=>item.id),items.map(item=>item.id));
});

test('near-duplicate coordinates cannot erase a right-angle bend',()=>{
  const points=compactRoutePoints([{x:0,y:0},{x:50,y:0},{x:50.00001,y:0},{x:50.00001,y:100}]);
  assert.equal(points.length,3);
  for(let i=1;i<points.length;i++)assert.ok(Math.abs(points[i].x-points[i-1].x)<.05||Math.abs(points[i].y-points[i-1].y)<.05);
});

test('a silent diagonal router fallback is repaired to boundary ports and avoids obstacles',()=>{
  const nodes=[{id:'a',x:0,y:0,width:260,height:132},{id:'b',x:400,y:180,width:260,height:132}];
  const scope=createRoutingScope({id:'repair',edges:[{id:'ab',source:'a',target:'b'}],boxes:new Map(nodes.map(n=>[n.id,n]))});
  const [route]=routesFromRoutingResults(scope,new Map([['ab',{sourcePoint:{x:130,y:66},targetPoint:{x:530,y:246},bendPoints:[]}]]));
  assert.ok(route.points.length>=2);
  assert.notDeepEqual(route.points[0],{x:130,y:66});
  assert.notDeepEqual(route.points.at(-1),{x:530,y:246});
  for(let i=1;i<route.points.length;i++)assert.ok(Math.abs(route.points[i].x-route.points[i-1].x)<.01||Math.abs(route.points[i].y-route.points[i-1].y)<.01);
});

test('a router rebuild after moving a node retains its new position and local ports',()=>{
  const scope=createRoutingScope({id:'moving',edges:[{id:'ab',source:'a',target:'b'}],boxes:new Map([['a',{x:0,y:0,width:260,height:132}],['b',{x:400,y:180,width:260,height:132}]])});
  const before=structuredClone(scope.graph.children.find(n=>n.id==='a').ports);
  applyRoutingMoves(scope,[{id:'a',x:25,y:45}]);
  const graphNode=scope.graph.children.find(n=>n.id==='a');
  assert.equal(graphNode.x,25);assert.equal(graphNode.y,45);assert.deepEqual(graphNode.ports,before);
});
