import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root=fs.mkdtempSync(path.join(os.tmpdir(),"canvas-sources-"));
process.env.REPO_CANVAS_ROOT=root;process.env.REPO_CANVAS_DATA_DIR=path.join(root,".repo-canvas");
fs.writeFileSync(path.join(root,"package.json"),'{"name":"source-fixture"}');
fs.writeFileSync(path.join(root,"entry.js"),'export function accept(input) { return input.trim(); }\n');
const source=await import("../repo-canvas/scripts/project-sources.mjs");
const knowledge=await import("../repo-canvas/scripts/project-knowledge.mjs");
const {codexSessionAdapter}=await import("../repo-canvas/scripts/session-adapters.mjs");
const {architectureEvidenceIssues}=await import("../repo-canvas/scripts/architect.mjs");
const {validateArchitecture}=await import("../repo-canvas/scripts/semantic-model.mjs");
test.after(()=>fs.rmSync(root,{recursive:true,force:true}));
const makeRecord=(type,payload)=>JSON.stringify({type,payload,timestamp:"2026-09-01T10:00:00Z"});
test("dialog sources deduplicate forks, preserve full text and detect edited messages",async()=>{
  const original=path.join(root,"rollout-original.jsonl"),fork=path.join(root,"rollout-fork.jsonl");
  const long="Я мыслю процессом заявки. ".repeat(250);
  const body=[makeRecord("session_meta",{id:"first",cwd:root,originator:"codex_desktop"}),makeRecord("event_msg",{type:"task_started",turn_id:"turn"}),makeRecord("event_msg",{type:"user_message",message:long})].join("\n")+"\n";
  fs.writeFileSync(original,body);fs.writeFileSync(fork,body.replace('"id":"first"','"id":"fork"'));
  const adapters=[{...codexSessionAdapter,listFiles:()=>[original,fork]}];
  const first=await source.indexProjectDialogs(root,{adapters});assert.equal(first.records.length,1);
  assert.equal(source.readDialogSource(root,first.records[0].id,first).text,long);
  const second=await source.indexProjectDialogs(root,{adapters});assert.equal(second.newIds.length,0);assert.equal(second.coverage.bytesRead,0);
  fs.appendFileSync(original,makeRecord("event_msg",{type:"user_message",message:"Предыдущее решение отменяем"})+"\n");
  const third=await source.indexProjectDialogs(root,{adapters});assert.equal(third.newIds.length,1);
  fs.writeFileSync(original,fs.readFileSync(original,"utf8").replace("Предыдущее решение отменяем","Предыдущее решение подтверждаем"));
  const fourth=await source.indexProjectDialogs(root,{adapters});assert.ok(fourth.invalidated.includes(third.newIds[0]));
  assert.equal(fourth.records.filter(row=>row.preview.includes("подтверждаем")).length,1);
});
test("reader profile cannot be inferred from agent words and an agent proposal is not owner approval",()=>{
  const previous={intent:"",decisions:[],profile:knowledge.defaultExplanationProfile(),processedIds:[],unresolved:[]};
  const index={records:[{id:"u",author:"user",at:"2026-09-01T00:00:00Z"},{id:"a",author:"agent",at:"2026-09-02T00:00:00Z"}]};
  const profile={language:"ru",framing:"Процесс заявки",detail:"Через результат",terms:["заявка"],sourceIds:["a"],uncertainty:"",shouldUpdate:true};
  assert.throws(()=>knowledge.mergeProjectKnowledge(previous,{intent:"",decisions:[],profile,unresolved:[]},index),/чужой текст/);
  assert.throws(()=>knowledge.mergeProjectKnowledge(previous,{decisions:[{id:"d",text:"Сделать очередь",reason:"",status:"accepted",sourceIds:["a"],supersedes:[]}],profile:{...profile,sourceIds:["u"]}},index),/пользователя/);
  const merged=knowledge.mergeProjectKnowledge(previous,{decisions:[],profile:{...profile,sourceIds:["u"]}},index);
  assert.equal(merged.profile.framing,"Процесс заявки");assert.equal(merged.profile.language,"ru");
});
test("evidence checks real symbols and ranges, and flow steps need directed connections",()=>{
  assert.equal(source.readCodeSource(root,"entry.js#accept").error,undefined);
  const value={areas:[],entities:[{id:"e",path:"entry.js#fakeFunction",evidence:[]}],relations:[]};
  assert.match(architectureEvidenceIssues(value,root).join(" "),/Символ/);
  assert.ok(source.readCodeSource(root,"entry.js:999").error);
  assert.ok(source.readCodeSource(root,"../outside.txt").error);
  const map={areas:[{id:"a"}],entities:[{id:"x",areaId:"a"},{id:"y",areaId:"a"}],relations:[],keyFlows:[{id:"f",steps:["x","y"]}]};
  const empty={areas:[],entities:[],relations:[]};
  assert.throws(()=>validateArchitecture(map,empty),/disconnected/);
  assert.doesNotThrow(()=>validateArchitecture({...map,relations:[{id:"r",from:"x",to:"y",status:"planned"}]},empty));
});
test("symbol reading prefers the declaration and reaches calls beyond the old fixed window",()=>{
 fs.writeFileSync(path.join(root,"long.js"),`import { dependency } from './dep.js';\n// execute appears in commentary before its declaration\nexport async function execute() {\n${Array.from({length:100},(_,i)=>`  const item${i} = ${i};`).join("\n")}\n  return dependency();\n}\n`);
 const result=source.readCodeSource(root,"long.js#execute");assert.match(result.text,/return dependency/);assert.equal(result.truncated,false);
 const compact=source.readCodeSource(root,"long.js#execute",{maxChars:200});assert.equal(compact.truncated,true);assert.match(compact.text,/Средняя часть пропущена/);assert.match(compact.text,/return dependency/);
});
test("concurrent live dialog indexes preserve both new tails",async()=>{
 const files=["alpha","beta"].map(id=>{const file=path.join(root,`${id}.jsonl`);fs.writeFileSync(file,[makeRecord("session_meta",{id,cwd:root}),makeRecord("event_msg",{type:"user_message",message:`Новое решение ${id}`})].join("\n")+"\n");return file;});
 await Promise.all(files.map(file=>source.indexProjectDialogs(root,{providers:["codex"],adapters:[codexSessionAdapter],onlyFiles:[file],includeArchives:false})));
 const index=source.readSourceJson(source.sourceIndexFile(root),null);
 assert.equal(index.records.filter(row=>row.preview.startsWith("Новое решение")).length,2);
});
test("a completed user turn updates intent and profile once, without rebuilding the map",async()=>{
 const file=path.join(root,"alpha.jsonl");const index=source.readSourceJson(source.sourceIndexFile(root),null);const row=index.records.find(item=>item.sessionId==="alpha");let calls=0;
 const runner=async()=>{calls++;return {value:{intent:"Принимаем заказы",intentSourceIds:[row.id],decisions:[],profile:{language:"ru",framing:"Через результат заказа",detail:"Коротко",terms:["заказ"],sourceIds:[row.id],uncertainty:"",shouldUpdate:true},unresolved:[]}};};
 const first=await knowledge.updateTurnKnowledge(root,{config:{dialogSources:true,providers:["codex"]},sessionId:"alpha",provider:"codex",file,runner});
 assert.equal(first.changed,true);const store=await import("../repo-canvas/scripts/canvas-store.mjs");assert.equal(store.getSnapshot().map.knowledge.intent,"Принимаем заказы");assert.equal(store.getSnapshot().map.explanationProfile.framing,"Через результат заказа");
 await knowledge.updateTurnKnowledge(root,{config:{dialogSources:true,providers:["codex"]},sessionId:"alpha",provider:"codex",file,runner});assert.equal(calls,1);
});
