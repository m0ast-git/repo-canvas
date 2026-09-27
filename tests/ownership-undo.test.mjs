import test from 'node:test';
import assert from 'node:assert/strict';
import {reduceEvents} from '../repo-canvas/scripts/snapshot-reducer.mjs';
import {semanticSignature} from '../repo-canvas/scripts/semantic-signature.mjs';

test('undoing a move removes only its ownership overrides and restores semantic identity',()=>{
  const event=(type,payload)=>({id:Math.random().toString(),type,payload,actor:'owner',ts:'2026-09-09T00:00:00Z'});
  const initial=[event('area.upsert',{id:'a',title:'A'}),event('area.upsert',{id:'b',title:'B'}),event('entity.upsert',{id:'node',areaId:'a',parentId:'',label:'Node',kind:'module',status:'operational'})];
  const before=reduceEvents(initial);
  const moved=event('entity.upsert',{id:'node',areaId:'b',ownerAreaId:'b',ownerParentId:''});
  const undo=event('entity.upsert',{id:'node',areaId:'a',ownerAreaId:null,ownerParentId:null});
  const restored=reduceEvents([...initial,moved,undo]);
  assert.equal(Object.hasOwn(restored.entities[0],'ownerAreaId'),false);
  assert.equal(Object.hasOwn(restored.entities[0],'ownerParentId'),false);
  assert.equal(semanticSignature(before),semanticSignature(restored));
});
