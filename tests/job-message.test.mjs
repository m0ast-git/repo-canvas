import test from "node:test";
import assert from "node:assert/strict";
import {jobMessage,jobStatistics,jobElapsedMs} from "../client/src/job-message.js";
import {trackModelUsage} from "../repo-canvas/scripts/model-usage.mjs";

test("an unverified result cannot appear as a successful update or expose a verifier monologue",()=>{
  const job={status:"done",kind:"code-review",result:{verified:false,summary:"Пакет доказательств: независимый эксперт не подтвердил ELK worker"}};
  const message=jobMessage(job);assert.equal(message.tone,"warning");assert.equal(message.label,"Обновить");
  assert.doesNotMatch(message.body,/пакет|эксперт|ELK|валидатор/);assert.match(message.body,/Текущая карта сохранена/);
});
test("missing old files explain why the Canvas needs an update",()=>{
  const message=jobMessage({status:"done",result:{verified:false,issue:{code:"stale-sources"}}});
  assert.equal(message.title,"Canvas устарел");assert.match(message.body,/перемещена или удалена/);assert.equal(message.action,"update");
});
test("completed duration is frozen and actual zero use differs from missing usage",()=>{
  const job={startedAt:"2026-09-06T09:00:00Z",finishedAt:"2026-09-06T09:00:47Z",result:{calls:0,usage:{totalTokens:0}}};
  assert.equal(jobElapsedMs(job,Date.now()+999999),47000);assert.equal(jobStatistics(job).tokens,"0");assert.equal(jobStatistics(job).models,"не запускалась");
  assert.match(jobStatistics({...job,result:{}}).tokens,/не записаны/);
});
test("review usage includes both the proposal and independent verification",async()=>{
  let call=0;const tracked=trackModelUsage(async()=>({profile:{model:++call===1?"architect-model":"verifier-model"},usage:{input_tokens:100,output_tokens:20}}));
  await tracked.runner({});await tracked.runner({});const result=tracked.summary();
  assert.equal(result.calls,2);assert.equal(result.usage.totalTokens,240);assert.deepEqual(result.models,["architect-model","verifier-model"]);
});

test("network loss and cancellation never look like an active model response",()=>{
  assert.equal(jobMessage({running:true,connectionLost:true}).tone,"warning");
  assert.equal(jobMessage({running:true,cancelRequested:true}).title,"Останавливаем обновление");
  assert.equal(jobMessage({status:"failed",error:"Codex Exec exited with code 4294967295"}).action,"update");
  assert.equal(jobMessage({status:"failed",error:"HTTP 429"}).action,"settings");
  const paused=jobMessage({status:"failed",error:"Достигнут предел расхода",result:{canResume:true}});
  assert.equal(paused.label,"Продолжить");assert.match(paused.body,/отдельным лимитом/);
});
