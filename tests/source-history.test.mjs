import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
const root=fs.mkdtempSync(path.join(os.tmpdir(),"canvas-source-history-"));
process.env.REPO_CANVAS_ROOT=root;process.env.REPO_CANVAS_DATA_DIR=path.join(root,".repo-canvas");
fs.writeFileSync(path.join(root,"package.json"),'{"name":"history"}');
const store=await import("../repo-canvas/scripts/canvas-store.mjs");
const {readCodeSource}=await import("../repo-canvas/scripts/project-sources.mjs");
const {archiveEvidence,readHistoricalEvidence}=await import("../repo-canvas/scripts/source-archive.mjs");
const {readGitSource,commitHistory}=await import("../repo-canvas/scripts/git-history.mjs");
const {answerProjectQuestion}=await import("../repo-canvas/scripts/project-questions.mjs");
const {reconstructHistory,readReconstruction,saveReconstructionGeometry}=await import("../repo-canvas/scripts/history-reconstruction.mjs");
const {normalizeArchitecture,validateArchitecture}=await import("../repo-canvas/scripts/semantic-model.mjs");
const {startCodeWatcher}=await import("../repo-canvas/scripts/code-observer.mjs");
const {normalizeObserverEvidence}=await import("../repo-canvas/scripts/observer-verification.mjs");
test.after(()=>fs.rmSync(root,{recursive:true,force:true,maxRetries:8,retryDelay:100}));
test("a model explanation after a source address cannot turn that address into a missing filename",()=>{
 fs.writeFileSync(path.join(root,"reference.js"),'export const ready = true;\n');
 const value=normalizeObserverEvidence(root,{entityChanges:[{entityId:"node",evidence:["reference.js:1 подтверждает наличие функции","reference.js#ready объявляет значение","missing.js:1 пояснение","Просто слова без ссылки"]}],relationChanges:[]});
 assert.deepEqual(value.entityChanges[0].evidence,["reference.js:1","reference.js#ready","missing.js:1 пояснение","Просто слова без ссылки"]);
});
test("browser QA artifacts do not trigger model reviews but source changes do",async()=>{
 const calls=[];const watcher=startCodeWatcher(root,{delayMs:5,run:files=>{calls.push(files);return true;}});
 try {watcher.schedule([".playwright-cli/page.yml",".playwright-cli/console.log","runtime.log","app.js"]);await new Promise(resolve=>setTimeout(resolve,35));assert.deepEqual(calls,[["app.js"]]);}
 finally {watcher.stop();}
});
test("historical sources survive deletion; missing old evidence never shows today's code",()=>{
 fs.writeFileSync(path.join(root,"entry.js"),'export function accept(){return "old";}');
 const source=readCodeSource(root,"entry.js#accept");archiveEvidence(root,{sources:[source]});
 const snapshot={map:{verification:{sourceHashes:[{reference:source.reference,hash:source.hash}]}},entities:[],relations:[]};
 fs.unlinkSync(path.join(root,"entry.js"));
 assert.match(readHistoricalEvidence(root,snapshot,source.reference).text,/old/);
 fs.writeFileSync(path.join(root,"entry.js"),'export function accept(){return "new";}');
 assert.match(readHistoricalEvidence(root,{...snapshot,map:{}},source.reference).error,/не был записан/);
});
test("Git reads immutable code without checking out the user's working tree",async()=>{
 const git=args=>execFileSync("git",args,{cwd:root,encoding:"utf8",windowsHide:true,stdio:["ignore","pipe","ignore"]}).trim();
 git(["init","--quiet"]);git(["add","entry.js"]);git(["-c","user.name=Canvas","-c","user.email=canvas@test.local","commit","--quiet","-m","Initial"]);
 const commit=git(["rev-parse","HEAD"]);fs.writeFileSync(path.join(root,"entry.js"),'current uncommitted content');
 const old=await readGitSource(root,commit,"entry.js#accept");assert.match(old.text,/new/);assert.equal(fs.readFileSync(path.join(root,"entry.js"),"utf8"),'current uncommitted content');
 assert.equal((await commitHistory(root)).length,1);
 await assert.rejects(readGitSource(root,commit,"../outside.js"),/вне разрешённого/);
});
test("manual grouping survives regeneration and a retained dangling parent is rejected",()=>{
 const snapshot={areas:[{id:"a",title:"Area"}],entities:[{id:"g",areaId:"a",label:"Group",ownerGroup:true,kind:"capability"},{id:"x",areaId:"a",parentId:"g",ownerParentId:"g",label:"Child",kind:"module"}],relations:[],map:{}};
 const result=normalizeArchitecture({areas:[],entities:[{id:"x",areaId:"a",parentId:"",label:"Child",kind:"module"}],relations:[],removedEntityIds:["g"],removedAreaIds:[],removedRelationIds:[]},snapshot);
 assert.equal(result.entities.find(item=>item.id==="x").parentId,"g");assert.equal(result.removedEntityIds.length,0);validateArchitecture(result,snapshot);
 assert.throws(()=>validateArchitecture({areas:[],entities:[],relations:[],removedEntityIds:["g"]},snapshot),/Unknown entity parent/);
});
test("questions use the selected snapshot and reject fabricated source IDs",async()=>{
 const snapshot={map:{projectTitle:"Past"},areas:[],entities:[{id:"x",path:"entry.js"}],relations:[],work:[],revision:2,_history:{id:"cp-test",at:"2025-01-01"}};
 let prompt;
 const result=await answerProjectQuestion({root,snapshot,question:"Что происходит?",runner:async options=>{prompt=options.prompt;return {value:{answer:"Сохранённое состояние",sourceIds:["entry.js"]}};}});
 assert.equal(result.checkpointId,"cp-test");assert.match(prompt,/2025-01-01/);
 await assert.rejects(answerProjectQuestion({root,snapshot,question:"Что происходит?",runner:async()=>({value:{answer:"",sourceIds:["invented.js"]}})}),/неизвестный источник/);
});
test("historical reconstruction is bounded, cached, and never rewrites Live or the original date",async()=>{
 const commit=(await commitHistory(root))[0];const before=store.getSnapshot().revision;let calls=0;
 const value={projectTitle:"Приём данных",projectSummary:"Возвращает результат",areas:[{id:"a",title:"Обработка",evidence:["entry.js#accept"]}],entities:[{id:"x",areaId:"a",kind:"module",label:"Приём",status:"operational",path:"entry.js",evidence:["entry.js#accept"]}],relations:[],keyFlows:[],removedEntityIds:[],removedAreaIds:[],removedRelationIds:[]};
 const runner=async options=>{calls++;return {usage:{totalTokens:100},value:options.role==="verifier"?{passed:true,summary:"Согласовано",issues:[]}:options.outputSchema.properties.files?{files:["entry.js#accept"]}:value};};
 const result=await reconstructHistory({root,ids:[commit.id],runner});assert.equal(result.completed.length,1);assert.equal(calls,3);
 const restored=readReconstruction(commit.id);assert.equal(restored._history.at,commit.at);assert.equal(restored._history.reconstruction,true);assert.ok(Date.parse(restored._history.recordedAt));assert.equal(store.getSnapshot().revision,before);
 await reconstructHistory({root,ids:[commit.id],runner});assert.equal(calls,3,"reading a completed reconstruction cannot spend tokens again");
 saveReconstructionGeometry(commit.id,restored.revision,{areas:[{id:"a",x:0,y:0,width:600,height:400}],entities:[{id:"x",x:30,y:100,width:300,height:130}],routes:[],work:[]});
 assert.equal(readReconstruction(commit.id)._geometry.entities[0].x,30);assert.equal(store.getSnapshot().revision,before);
});
