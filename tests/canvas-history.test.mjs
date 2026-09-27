import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
const root=fs.mkdtempSync(path.join(os.tmpdir(),"canvas-history-"));
process.env.REPO_CANVAS_ROOT=root;process.env.REPO_CANVAS_DATA_DIR=path.join(root,".repo-canvas");
fs.writeFileSync(path.join(root,"package.json"),'{"name":"history-fixture"}');
const store=await import("../repo-canvas/scripts/canvas-store.mjs");
const history=await import("../repo-canvas/scripts/canvas-history.mjs");
test.after(()=>fs.rmSync(root,{recursive:true,force:true}));
const emit=(type,payload)=>store.createEvent(type,{actor:"test",payload});
test("one atomic action produces one checkpoint and exact historical state",async()=>{
  store.appendEvents([emit("map.upsert",{projectTitle:"Проект"}),emit("area.upsert",{id:"a",title:"Приём"}),emit("entity.upsert",{id:"x",areaId:"a",label:"Приём заявки",status:"operational",x:10,y:20})]);
  const first=(await history.historyPage()).checkpoints;assert.equal(first.length,1);assert.equal(first[0].revision,3);
  store.appendEvents([emit("entity.upsert",{id:"x",areaId:"a",label:"Приём заявки",ownerLabel:"Вход заявки",status:"operational",x:110,y:120}),emit("entity.upsert",{id:"y",areaId:"a",label:"Хранение",status:"planned",x:400,y:100}),emit("relation.upsert",{id:"xy",from:"x",to:"y",label:"передаёт заявку",status:"planned"})]);
  const points=(await history.historyPage()).checkpoints;assert.equal(points.length,2);
  const old=await history.stateAtCheckpoint(points[0].id);assert.equal(old.entities.length,1);assert.equal(old.entities[0].x,10);assert.equal(old.entities[0].ownerLabel,undefined);
  const current=await history.stateAtCheckpoint(points[1].id);assert.equal(current.entities.length,2);assert.equal(current.entities[0].ownerLabel,"Вход заявки");
  assert.equal(old._history.readOnly,true);assert.equal(old._history.geometry,"reconstructed");
  assert.equal(store.getSnapshot().revision,6,"reading history must not append events");
});
test("geometry is bound to a revision and cannot silently replace recorded history",async()=>{
  const {checkpoints}=await history.historyPage();const point=checkpoints.at(-1);
  const geometry={areas:[{id:"a",x:0,y:0,width:800,height:600}],entities:[{id:"x",x:110,y:120,width:300,height:160},{id:"y",x:400,y:100,width:300,height:160}],routes:[],areaRoutes:[],work:[]};
  assert.equal((await history.saveCheckpointGeometry(point.id,point.revision,geometry)).saved,true);
  assert.equal((await history.saveCheckpointGeometry(point.id,point.revision,{...geometry,areas:[]})).reason,"already-recorded");
  const old=await history.stateAtCheckpoint(point.id);assert.equal(old._geometry.entities[0].x,110);assert.equal(old._history.geometry,"recorded");
  store.appendEvent(emit("entity.upsert",{id:"x",areaId:"a",label:"Приём заявки",status:"operational",x:200,y:120}));
  assert.equal((await history.saveCheckpointGeometry(point.id,point.revision,geometry)).reason,"revision-changed");
  assert.equal((await history.stateAtCheckpoint(point.id)).entities.find(item=>item.id==="x").x,110);
});
test("manual anchors, comments and comparison keep the past unchanged",async()=>{
  const before=(await history.historyPage()).checkpoints[0];const mark=await history.createCheckpoint("Перед доработкой отчёта");assert.equal(mark.kind,"manual");
  await history.addHistoryComment(before.id,"Здесь ещё не было хранилища");assert.equal(history.historyComments(before.id).length,1);
  const diff=history.compareSnapshots(await history.stateAtCheckpoint(before.id),store.getSnapshot());assert.ok(diff.added.some(item=>item.id==="y"));assert.ok(diff.changed.some(item=>item.id==="x"));
  assert.equal((await history.stateAtCheckpoint(before.id)).entities.length,1);
});
