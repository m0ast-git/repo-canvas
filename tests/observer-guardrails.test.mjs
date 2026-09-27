import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root=fs.mkdtempSync(path.join(os.tmpdir(),"canvas-guardrails-"));
process.env.REPO_CANVAS_ROOT=root;process.env.REPO_CANVAS_DATA_DIR=path.join(root,".repo-canvas");
const store=await import("../repo-canvas/scripts/canvas-store.mjs");
const {CodexObserver}=await import("../repo-canvas/scripts/observer.mjs");
const {historyPage}=await import("../repo-canvas/scripts/canvas-history.mjs");
const {measureModelCall,modelUsageSummary}=await import("../repo-canvas/scripts/model-usage.mjs");
test.after(()=>fs.rmSync(root,{recursive:true,force:true}));
const emit=payload=>store.appendEvent(store.createEvent("work.upsert",{actor:"observer",payload:{provisional:true,...payload}}));
const empty={workTitle:"Проверка завершена",workSummary:"Изменений нет",workStatus:"done",targetEntityIds:[],entityChanges:[],relationChanges:[]};

test("1000 observer ticks consume one changed verification stamp and leave no stale proposal",async()=>{
  const turn={turnId:"once",workId:"once",sessionId:"s",finished:true,finalKind:"complete",events:[],verificationPending:{decision:empty,stamp:"old"}};
  emit({id:"once",title:"Проверка",status:"done",targets:[],proposedChanges:empty,verification:{state:"needs-review"}});
  let calls=0;
  const observer=new CodexObserver({config:{repoRoot:root},state:{sessions:{fixture:{relevant:true,meta:{id:"s"},turns:{once:turn}}}},runner:async()=>{calls++;return {value:structuredClone(empty)};},verifier:async()=>{throw new Error("No proposal to verify");},writeState:()=>{}});
  const before=store.getSnapshot().revision;
  for(let i=0;i<1000;i++)await observer.runDue();
  assert.equal(calls,1);assert.equal(store.getSnapshot().revision-before,1);
  assert.equal(turn.verificationPending,null);assert.equal(store.getSnapshot().work.find(item=>item.id==="once").proposedChanges,null);
});

test("duplicate work is idempotent and only turn boundaries become checkpoints",async()=>{
  const value={id:"dedupe",title:"Работа",status:"active",targets:[],note:"Начало",session:{kind:"codex-app",id:"dedupe-session",cwd:root}};
  emit(value);const revision=store.getSnapshot().revision;const count=(await historyPage()).total;
  for(let i=0;i<1000;i++)emit({...value,updatedAt:new Date(i).toISOString(),actor:"different",_checkpoint:{id:`ignored-${i}`}});
  assert.equal(store.getSnapshot().revision,revision);
  emit({...value,note:"Читаем файл"});assert.equal((await historyPage()).total,count);
  emit({...value,status:"done",note:"Готово"});assert.equal((await historyPage()).total,count+1);
});

test("final retry cap persists across observer instances",async()=>{
  const turn={turnId:"limited",workId:"limited",sessionId:"s",finished:true,finalPending:true,finalKind:"complete",events:[],finalAttempts:3};
  let calls=0;
  const observer=new CodexObserver({config:{repoRoot:root},state:{sessions:{fixture:{relevant:true,meta:{id:"s"},turns:{limited:turn}}}},runner:async()=>{calls++;throw new Error("must not run");},writeState:()=>{}});
  for(let i=0;i<1000;i++)await observer.runDue();
  assert.equal(calls,0);assert.equal(turn.finalPending,false);assert.ok(turn.paused.reason);
});

test("background reservations are atomic, survive restart and count failed calls",async()=>{
  const now=()=>Date.parse("2026-09-27T10:00:00Z");let calls=0;
  const options={cwd:root,role:"observer",background:true,prompt:"small"};
  const run=()=>measureModelCall(options,async()=>{calls++;throw new Error("provider failed");},{config:{backgroundMaxCallsPerHour:2},now});
  const results=await Promise.allSettled([run(),run(),run()]);
  assert.equal(calls,2);assert.equal(results.filter(item=>item.reason?.code==="BACKGROUND_LIMIT").length,1);
  const summary=modelUsageSummary(root,{now:now()});assert.equal(summary.calls,2);assert.equal(summary.roles.observer.errors,2);assert.equal(summary.pauses.length,1);
  await assert.rejects(run(),{code:"BACKGROUND_LIMIT"});
  await measureModelCall({...options,background:false},async()=>({usage:{input_tokens:2,output_tokens:3}}),{now});
  assert.equal(modelUsageSummary(root,{now:now()}).knownTokens,5);
});
