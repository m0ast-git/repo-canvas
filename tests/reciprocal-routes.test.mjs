import test from 'node:test';
import assert from 'node:assert/strict';
import {mergeReciprocalRoutes} from '../client/src/reciprocal-routes.js';
test('reciprocal exchange draws once and retains both original directions',()=>{
 const edges=[{source:'a',target:'b',status:'existing',relations:[{id:'out',from:'a',to:'b',label:'Обмен'}]},{source:'b',target:'a',status:'existing',relations:[{id:'in',from:'b',to:'a',label:'Обмен'}]}];
 const [route]=mergeReciprocalRoutes(edges);
 assert.equal(mergeReciprocalRoutes(edges).length,1);
 assert.equal(route.bidirectional,true);assert.equal(route.sharedLabel,'Обмен');
 assert.deepEqual(route.relations.map(item=>item.id),['out','in']);
 assert.equal(edges[0].relations.length,1);
 assert.equal(mergeReciprocalRoutes([edges[0],{...edges[1],status:'planned'}]).length,2);
});
