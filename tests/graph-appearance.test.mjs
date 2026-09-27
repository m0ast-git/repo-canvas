import test from 'node:test';
import assert from 'node:assert/strict';
import { activeWorkRollup, areaImplementationStatuses, LIVE_WORK_MS } from '../client/src/graph-contract.js';
import { areaColor, assignAreaColors, routeColors } from '../client/src/design-system/project-theme.js';
import { routeVisualKind } from '../client/src/route-presentation.js';

const now = Date.parse('2026-09-14T12:00:00Z');
const areas = ['mixed', 'future', 'empty'].map(id => ({id}));
const entities = [
  {id:'group', areaId:'mixed', status:'operational'},
  {id:'running', areaId:'mixed', parentId:'group', status:'operational'},
  {id:'planned', areaId:'mixed', parentId:'group', status:'planned'},
  {id:'future-node', areaId:'future', status:'planned'},
  {id:'neutral', areaId:'', status:'operational'},
];
const byId = new Map(entities.map(entity => [entity.id, entity]));
const work = (id, status, targets, age=0) => ({id, status, targets, updatedAt:new Date(now-age).toISOString()});

test('areas derive implementation from contents without turning a mixed or empty area into a plan', () => {
  assert.deepEqual([...areaImplementationStatuses({areas, entities})], [['mixed','existing'], ['future','planned'], ['empty','existing']]);
  const updated = entities.map(entity => entity.id === 'future-node' ? {...entity,status:'operational'} : entity);
  assert.equal(areaImplementationStatuses({areas,entities:updated}).get('future'), 'existing');
  assert.equal(areaImplementationStatuses({areas:[{id:'empty',status:'planned'}],entities:[]}).get('empty'), 'planned');
});

test('both ends of a dependency participate in planned ink, independently of source color', () => {
  const statuses = areaImplementationStatuses({areas,entities});
  const slots = assignAreaColors(areas);
  const colors = new Map(areas.map(area=>[area.id,areaColor({...area,colorSlot:slots[area.id]})]));
  for (const [source,target,kind] of [['running','planned','planned'],['planned','neutral','planned'],['running','neutral','confirmed']]) {
    const route = {source:`entity:${source}`,target:`entity:${target}`,status:'existing',type:'relation'};
    assert.equal(routeVisualKind(route,byId,statuses),kind);
    assert.equal(routeColors(route,byId,colors).color, colors.get('mixed'));
  }
  assert.equal(routeVisualKind({source:'area:future',target:'entity:running'},byId,statuses),'planned');
  assert.equal(routeVisualKind({source:'entity:running',target:'entity:neutral',status:'planned'},byId,statuses),'planned');
});

test('one active task counts once per parent/area; blocked, planned, stale and terminal work never pulse', () => {
  const snapshot = {areas,entities,work:[
    work('active','active',['running','planned']),
    work('blocked','blocked',['future-node']), work('planned','planned',['future-node']),
    work('done','done',['future-node']), work('stopped','stopped',['future-node']),
    work('expired','active',['future-node'],LIVE_WORK_MS+1),
    work('unmapped','active',[]), work('free','active',['neutral']),
  ]};
  const result=activeWorkRollup(snapshot,now);
  assert.deepEqual([...result.areas],[['mixed',1]]);
  assert.equal(result.entities.get('group'),1);
  assert.equal(result.entities.get('running'),1);
  assert.equal(result.entities.get('planned'),1);
  assert.equal(result.entities.get('neutral'),1);
  assert.equal(result.entities.has('future-node'),false);
  assert.equal(activeWorkRollup({...snapshot,work:[work('active','done',['running'])]},now).areas.size,0);
});

test('nested ownership and reciprocal colors use current membership rather than saved route colors', () => {
  const map = new Map([...byId,['inherited',{id:'inherited',parentId:'group'}]]);
  const colors = new Map([['mixed','#838752'],['future','#5B8F69']]);
  const route={source:'entity:inherited',target:'entity:future-node',bidirectional:true,color:'#777777',reverseColor:'#777777'};
  assert.deepEqual(routeColors(route,map,colors),{color:'#838752',reverseColor:'#5B8F69'});
  map.set('inherited',{id:'inherited',areaId:'',parentId:'group'});
  assert.deepEqual(routeColors(route,map,colors),{color:'#777777',reverseColor:'#5B8F69'});
});
