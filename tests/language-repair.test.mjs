import test from 'node:test';
import assert from 'node:assert/strict';
import {languageRepairFields,applyLanguageRepair,validateArchitectureLanguage,refinementFragment,mergeRefinementFragment,mergeFlowText} from '../repo-canvas/scripts/architect.mjs';
import {focusEvidenceMap} from '../repo-canvas/scripts/evidence-review.mjs';

test('a wording repair changes only rejected phrases, retaining map structure and evidence',()=>{
  const value={projectTitle:'Карта',projectSummary:'Описание',areas:[],entities:[{id:'bootstrap',label:'Запуск',purpose:'Запускает проект',note:'Локальный runtime',evidence:['server.mjs:1-10']}],relations:[],keyFlows:[]};
  const fields=languageRepairFields(value,'ru',{});
  assert.deepEqual(fields,[{field:'entity.bootstrap.note',text:'Локальный runtime'}]);
  const fixed=applyLanguageRepair(value,[{field:fields[0].field,text:'Среда запуска на этом компьютере'}],fields);
  validateArchitectureLanguage(fixed,'ru',{});
  assert.equal(value.entities[0].note,'Локальный runtime');assert.deepEqual(fixed.entities[0].evidence,value.entities[0].evidence);
  assert.throws(()=>applyLanguageRepair(value,[{field:'entity.bootstrap.id',text:'different'}],fields),/пределы/);
  assert.throws(()=>applyLanguageRepair(value,[],fields),/не все/);
});

test('a verification follow-up retains the affected flow and its endpoints, not unrelated details',()=>{
  const value={areas:[{id:'a'},{id:'b'}],entities:[{id:'one',areaId:'a',label:'One'},{id:'two',areaId:'a',label:'Two'},{id:'other',areaId:'b',label:'Other',purpose:'Long unrelated explanation'}],relations:[{id:'link',from:'one',to:'two'}],keyFlows:[{id:'main',steps:['one','two']}],unresolvedQuestions:[]};
  const focused=focusEvidenceMap(value,[{scope:'flow',id:'main'}]);
  assert.deepEqual(focused.entities.map(item=>item.id),['one','two']);assert.equal(focused.relations[0].id,'link');
  assert.deepEqual(focused.otherComponents,[{id:'other',label:'Other'}]);
  assert.equal(focusEvidenceMap(value,[{scope:'map',id:'map'}]),value);
});

test('a flow correction cannot replace unrelated map objects',()=>{
  const value={projectTitle:'Project',entities:[{id:'node',label:'Protected'}],areas:[],relations:[],keyFlows:[{id:'history',outcome:'Old condition'},{id:'other',outcome:'Unchanged'}]};
  const scope=refinementFragment(value,{issues:[{scope:'flow',id:'history',severity:'critical'}]});
  assert.deepEqual(Object.keys(scope),['keyFlows']);
  const fixed=mergeRefinementFragment(value,{keyFlows:[{id:'history',outcome:'Recorded or reconstructed history'}]},scope);
  assert.deepEqual(fixed.entities,value.entities);assert.deepEqual(fixed.keyFlows[1],value.keyFlows[1]);
  assert.throws(()=>mergeRefinementFragment(value,{entities:[],keyFlows:scope.keyFlows},scope),/пределы/);
  assert.throws(()=>mergeRefinementFragment(value,{keyFlows:[{id:'other'}]},scope),/состав/);
});

test('editing a flow condition retains return visits and every directed transition',()=>{
  const flow={id:'history',steps:['owner','server','history','server','owner'],transitions:[{relationId:'request',condition:'Read'},{relationId:'lookup',condition:'Find'},{relationId:'result',condition:'Missing snapshot means gap'},{relationId:'display',condition:'Show'}]};
  const result=mergeFlowText(flow,{title:'History',trigger:'Choose time',outcome:'Show state',conditions:{request:'Read',lookup:'Find',result:'Use a snapshot or reconstruction; otherwise show a gap',display:'Show'}});
  assert.deepEqual(result.steps,flow.steps);assert.deepEqual(result.transitions.map(item=>item.relationId),flow.transitions.map(item=>item.relationId));
  assert.equal(result.transitions.length,result.steps.length-1);
});

test('a flow can add its missing return edge and derives steps from directed transitions',()=>{
  const value={entities:[{id:'owner'},{id:'editor'}],areas:[],relations:[{id:'request',from:'owner',to:'editor'}],keyFlows:[{id:'edit',steps:['owner','editor'],transitions:[{relationId:'request',condition:'Ask'}]}]};
  const expected={keyFlows:value.keyFlows};
  const result=mergeRefinementFragment(value,{keyFlows:[{id:'edit',transitionMode:'append',transitions:[{relationId:'reply',condition:'Return checked result'}]}],relations:[{id:'reply',from:'editor',to:'owner'}]},expected);
  assert.deepEqual(result.keyFlows[0].steps,['owner','editor','owner']);
  assert.equal(mergeRefinementFragment(value,{keyFlows:value.keyFlows,relations:[{id:'unrelated',from:'editor',to:'owner'}]},expected).relations.length,1);
});
