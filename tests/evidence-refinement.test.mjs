import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const root=fs.mkdtempSync(path.join(os.tmpdir(),"canvas-proof-"));
process.env.REPO_CANVAS_ROOT=root;process.env.REPO_CANVAS_DATA_DIR=path.join(root,".repo-canvas");
const {runArchitect}=await import("../repo-canvas/scripts/architect.mjs");
const {evidencePackage,focusEvidenceMap}=await import("../repo-canvas/scripts/evidence-review.mjs");
const {getSnapshot}=await import("../repo-canvas/scripts/canvas-store.mjs");
test.after(()=>{assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep+"canvas-proof-"));fs.rmSync(root,{recursive:true,force:true});});
test("a precise requested range retains its middle rather than asking for the same code again",()=>{
  fs.writeFileSync(path.join(root,"wide.mjs"),Array.from({length:100},(_,i)=>`// line ${i+1} ${"content ".repeat(60)}`).join("\n"));
  const result=evidencePackage(root,{entities:[],relations:[],areas:[]},{extraRefs:["wide.mjs:10-90"]});
  assert.equal(result.sources[0].truncated,false);assert.match(result.sources[0].text,/line 50 content/);
});
test("after a factual correction only its affected objects are rechecked",async()=>{
  fs.writeFileSync(path.join(root,"server.mjs"),"export function run() {}\n");fs.writeFileSync(path.join(root,"other.mjs"),"// unrelated-proof-marker\n");
  const entity=(id,purpose)=>({id,areaId:"area",parentId:"",kind:"service",status:"operational",label:id,purpose,path:`${id}.mjs`,evidence:[`${id}.mjs`],note:"",order:1});
  const candidate={projectTitle:"Fixture",projectSummary:"Accepts requests and returns results.",layoutIntent:"domain",layoutDirection:"AUTO",areas:[{id:"area",title:"Product",note:"Responsibilities",color:"#2864cf",order:1,evidence:[]}],entities:[entity("server","Handles server requests"),entity("other","Preserved separate function")],relations:[],keyFlows:[],unresolvedQuestions:[],removedAreaIds:[],removedEntityIds:[],removedRelationIds:[]};
  const fixed={...candidate.entities[0],note:"Only server jobs share the lock"};let reviews=0;
  const response=value=>({value,profile:{model:"fixture",effort:"medium"},usage:{input_tokens:10,output_tokens:5}});
  const result=await runArchitect({root,refresh:false,collectSources:false,runner:async options=>response(options.outputSchema.properties.projectTitle?candidate:{entities:[fixed]}),evidenceReviewer:async options=>{
    reviews++;if(reviews===1){assert.match(options.prompt,/unrelated-proof-marker/);return response({passed:false,summary:"Narrow the guarantee",sourceRequests:[],issues:[{severity:"critical",scope:"entity",id:"server",message:"The lock scope is unclear",recommendation:"State that the lock covers server jobs"}]});}
    assert.doesNotMatch(options.prompt,/unrelated-proof-marker/);assert.match(options.prompt,/Only server jobs share the lock/);return response({passed:true,summary:"Correct",sourceRequests:[],issues:[]});
  },reviewer:async()=>response({passed:true,summary:"Clear",answers:{project:"Requests",composition:"Services",lifecycle:"Input to result"},issues:[]})});
  assert.equal(reviews,2);assert.equal(result.acceptanceRepairs,1);assert.equal(getSnapshot().map.verification.state,"source-checked");
  const focus=focusEvidenceMap({...candidate,relations:[{id:"uses",from:"server",to:"other",label:"Calls"}]},[{scope:"entity",id:"server"}]);
  assert.equal(focus.acceptedContext.relations[0].id,"uses");assert.equal(focus.acceptedContext.entities[0].purpose,"Preserved separate function");
});
