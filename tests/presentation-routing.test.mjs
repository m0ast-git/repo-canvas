import test from 'node:test';
import assert from 'node:assert/strict';
import {createRoutingSession} from '@mr_mint/elkjs-libavoid';
import {routeScene} from '../client/src/route-scene.js';
import {RoutingRegistry} from '../client/src/routing-registry.js';
import {findRouteOverlaps,separateParallelRoutes} from '../client/src/route-clearance.js';
import {pathEntersBoxes} from '../client/src/protected-routes.js';
import {INTERACTIVE_ROUTING_OPTIONS,presentationRoutingScope,presentationRoutesFromResults} from '../client/src/presentation-routing.js';

function fixture() {
  const rects=[['area:a','area',-40,-110,1000,700],['g','group',0,0,400,320],['child-a','entity',30,130,120,80],['child-b','entity',230,130,120,80],['one','entity',650,0,120,80],['two','entity',650,280,120,80],['block','entity',460,110,100,100]];
  const nodes=rects.map(([id,type,x,y,width,height])=>({id,type,position:{x,y},width,height,data:{headerHeight:76}}));
  const routes=[['g','one'],['g','two'],['child-a','two'],['child-b','one'],['one','two']].map(([source,target],i)=>({id:'r'+i,source,target,points:[]}));
  const scene=routeScene(nodes);
  return {nodes,routes,scene,scope:presentationRoutingScope(routes,scene)};
}

test('native final routing separates channels while preserving group boundary pins and obstacles',async()=>{
  const {scene,scope}=fixture(),session=await createRoutingSession(scope.graph,INTERACTIVE_ROUTING_OPTIONS);
  try {
    const routes=presentationRoutesFromResults(scope,session.processTransaction());
    assert.equal(routes.length,5);assert.deepEqual(findRouteOverlaps(routes),[]);
    for(const route of routes) {
      const obstacles=[...scene.boxes.filter(box=>box.id!==route.source&&box.id!==route.target),...scene.headers.filter(box=>box.nodeId!==route.source&&box.nodeId!==route.target)];
      assert.equal(pathEntersBoxes(route.points,obstacles),false,route.id);
      for(const end of ['source','target'])if(scene.groups.has(route[end])) {
        const rect=scene.boundaries.get(route[end]),point=end==='source'?route.points[0]:route.points.at(-1);
        assert.ok(Math.min(Math.abs(point.x-rect.x),Math.abs(point.y-rect.y),Math.abs(point.x-rect.x-rect.width),Math.abs(point.y-rect.y-rect.height))<.05);
      }
    }
  } finally {session.destroy();}
});

test('the final native routing session is reused for moved nodes and idle updates do no work',async()=>{
  const {scope}=fixture();
  const registry=new RoutingRegistry({createSession:graph=>createRoutingSession(graph,INTERACTIVE_ROUTING_OPTIONS),routeOnce:()=>{throw new Error('Unexpected fallback');},convertResults:presentationRoutesFromResults});
  try {
    await registry.replace([scope]);
    for(let i=1;i<=3;i++)await registry.settle([{id:'two',x:650+i*20,y:280}]);
    const before=registry.stats();
    for(let i=0;i<30;i++)assert.deepEqual(await registry.settle([]),[]);
    assert.deepEqual(registry.stats(),before);
    assert.equal(before.created,1);assert.equal(before.rebuilds,0);assert.equal(before.transactions,3);
    assert.deepEqual(findRouteOverlaps(registry.routes()),[]);
  } finally {registry.destroy();}
});

test('splitting a coincident terminal segment does not introduce diagonal segments',()=>{
  const routes=[{id:'a',points:[{x:0,y:0},{x:300,y:0}]},{id:'b',points:[{x:50,y:0},{x:350,y:0}]}];
  const separated=separateParallelRoutes(routes);
  for(let i=0;i<routes.length;i++) {
    assert.deepEqual(separated[i].points[0],routes[i].points[0]);assert.deepEqual(separated[i].points.at(-1),routes[i].points.at(-1));
    assert.ok(separated[i].points.slice(1).every((p,j)=>Math.abs(p.x-separated[i].points[j].x)<.01||Math.abs(p.y-separated[i].points[j].y)<.01));
  }
});

test('a group north pin can leave its own header without a diagonal fallback',async()=>{
  const scene=routeScene([{id:'g',type:'group',position:{x:0,y:0},width:400,height:320,data:{headerHeight:76}},{id:'above',type:'entity',position:{x:140,y:-240},width:120,height:80}]);
  const scope=presentationRoutingScope([{id:'r',source:'g',target:'above'}],scene),session=await createRoutingSession(scope.graph,INTERACTIVE_ROUTING_OPTIONS);
  try {const [route]=presentationRoutesFromResults(scope,session.processTransaction());assert.equal(route.points[0].y,0);assert.ok(route.points[1].y<0);}
  finally {session.destroy();}
});

test('an overlapping neighbour cannot bury a fixed port inside its card',async()=>{
  const nodes=[['source',160,100,288,148],['overlap',120,34,176,164],['target',-208,100,288,148]].map(([id,x,y,width,height])=>({id,type:'entity',position:{x,y},width,height,data:{}}));
  const scene=routeScene(nodes),scope=presentationRoutingScope([{id:'one',source:'source',target:'target'}],scene);
  const session=await createRoutingSession(scope.graph,INTERACTIVE_ROUTING_OPTIONS);
  try {const [route]=presentationRoutesFromResults(scope,session.processTransaction());assert.equal(pathEntersBoxes(route.points,[scene.boundaries.get('overlap')]),false);}
  finally {session.destroy();}
});

test('historical comparison ghosts cannot invalidate the routing scene',async()=>{
  const {nodes,scene}=fixture();const {routeSceneKey}=await import('../client/src/route-scene.js');
  const decorated=[...nodes,{id:'removed:old',type:'entity',position:{x:500,y:0},width:200,height:200,data:{}}];
  assert.equal(routeSceneKey(decorated),routeSceneKey(nodes));assert.deepEqual(routeScene(decorated),scene);
});
