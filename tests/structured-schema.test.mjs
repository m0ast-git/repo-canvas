import assert from 'node:assert/strict';
import test from 'node:test';
import { structuredValidator, validateStructuredValue } from '../repo-canvas/scripts/structured-schema.mjs';
import { ARCHITECT_OUTPUT_SCHEMA, ARCHITECT_REVIEW_SCHEMA, OBSERVER_OUTPUT_SCHEMA } from '../repo-canvas/scripts/semantic-model.mjs';
import { KNOWLEDGE_SCHEMA } from '../repo-canvas/scripts/project-knowledge.mjs';
import { CORRECTION_SCHEMA } from '../repo-canvas/scripts/corrections.mjs';
import { EVIDENCE_REVIEW_SCHEMA } from '../repo-canvas/scripts/evidence-review.mjs';
import { architectureRepairSchema, architectureReviewSchema } from '../repo-canvas/scripts/architect.mjs';

test('all model contracts compile in strict mode, including empty initial repair sets',()=>{
  const empty={areas:[],entities:[],relations:[],keyFlows:[]};
  for(const schema of [ARCHITECT_OUTPUT_SCHEMA,ARCHITECT_REVIEW_SCHEMA,OBSERVER_OUTPUT_SCHEMA,KNOWLEDGE_SCHEMA,CORRECTION_SCHEMA,EVIDENCE_REVIEW_SCHEMA,architectureRepairSchema(empty,empty),architectureReviewSchema(empty)])assert.equal(typeof structuredValidator(schema),'function');
  const repair=architectureRepairSchema(empty,empty);
  assert.equal(repair.properties.removedEntityIds.maxItems,0);
  assert.equal(repair.properties.relations.maxItems,0);
  assert.throws(()=>validateStructuredValue(['invented'],repair.properties.removedEntityIds));
});

test('validation enforces array unions, bounds, nested references and additional properties without mutation',()=>{
  const schema={type:'object',additionalProperties:false,required:['items'],properties:{items:{type:['array','null'],minItems:1,maxItems:2,items:{$ref:'#/$defs/item'}}},$defs:{item:{type:'integer',minimum:1,maximum:5}}};
  assert.deepEqual(validateStructuredValue({items:[1,5]},schema),{items:[1,5]});
  assert.deepEqual(validateStructuredValue({items:null},schema),{items:null});
  for(const items of [[],[0],[6],[1,2,3],['2']])assert.throws(()=>validateStructuredValue({items},schema));
  const value={items:[2],extra:true},before=structuredClone(value);
  assert.throws(()=>validateStructuredValue(value,schema));assert.deepEqual(value,before);
  assert.throws(()=>validateStructuredValue('x',{type:'string',maxLength:0}));
  assert.throws(()=>validateStructuredValue('',{type:'string',minLength:1}));
});

test('equivalent schema objects reuse compilation and unknown keywords fail explicitly',()=>{
  const schema={type:'object',properties:{ok:{type:'boolean'}},required:['ok'],additionalProperties:false};
  assert.equal(structuredValidator(schema),structuredValidator(structuredClone(schema)));
  assert.throws(()=>structuredValidator({type:'string',minLenght:2}),/unknown keyword/);
  assert.throws(()=>validateStructuredValue({ok:'true'},schema),/ожидается/);
});
