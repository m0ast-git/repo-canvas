import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
const root=fs.mkdtempSync(path.join(os.tmpdir(),"canvas-corrections-"));
process.env.REPO_CANVAS_ROOT=root;process.env.REPO_CANVAS_DATA_DIR=path.join(root,".repo-canvas");
fs.writeFileSync(path.join(root,"package.json"),'{"name":"correction-fixture"}');
fs.writeFileSync(path.join(root,"entry.js"),'export function accept(data) { return data; }');
const store=await import("../repo-canvas/scripts/canvas-store.mjs");
const {runCorrection,undoCorrection}=await import("../repo-canvas/scripts/corrections.mjs");
const {applyArchitecture,observerEvents}=await import("../repo-canvas/scripts/semantic-model.mjs");
const {semanticSignature}=await import("../repo-canvas/scripts/semantic-signature.mjs");
test.after(()=>fs.rmSync(root,{recursive:true,force:true}));
store.appendEvents([
  store.createEvent("map.upsert",{payload:{projectTitle:"Заявки",language:"ru",keyFlows:[{id:"flow",title:"Передача",steps:["a","b"],transitions:[{relationId:"r",condition:""}]}]}}),
  store.createEvent("area.upsert",{payload:{id:"domain",title:"Обработка"}}),
  ...["a","b"].map(id=>store.createEvent("entity.upsert",{payload:{id,areaId:"domain",label:id,purpose:"Проверяет данные",status:"operational",kind:"module",path:"entry.js",evidence:["entry.js#accept"],x:id==="a"?50:400,y:200}})),
  store.createEvent("relation.upsert",{payload:{id:"r",from:"a",to:"b",label:"передаёт данные",status:"existing"}}),
]);
test("a natural wording correction is scoped, persists, and has a reversible outcome",async()=>{
  const before=store.getSnapshot();
  const result=await runCorrection({root,kind:"entity",id:"a",instruction:"Называй это приёмом заявки",runner:async({role})=>role==="reviewer"?{value:{passed:true,summary:"Смысл сохранён",issues:[]}}:{value:{mode:"wording",title:"Приём заявки",description:null,status:null,summary:"Название уточнено"}}});
  const after=store.getSnapshot();assert.equal(after.entities.find(e=>e.id==="a").ownerLabel,"Приём заявки");
  assert.deepEqual(after.entities.find(e=>e.id==="b"),before.entities.find(e=>e.id==="b"));
  assert.equal(after.entities.find(e=>e.id==="a").status,"operational");
  undoCorrection(result.id);assert.equal(store.getSnapshot().entities.find(e=>e.id==="a").ownerLabel,"");
});
test("meaning changes are checked even if an editor incorrectly calls them wording",async()=>{
  const revision=store.getSnapshot().revision;
  await assert.rejects(runCorrection({root,kind:"entity",id:"a",instruction:"Отметь отключённым",runner:async({role})=>role==="editor"?{value:{mode:"wording",title:null,description:null,status:"disabled",summary:""}}:{value:{passed:false,summary:"Код не подтверждает отключение",issues:[]}}}),/не подтверждает/);
  assert.equal(store.getSnapshot().revision,revision);
});
test("a wording edit cannot smuggle an unverified capability into a label",async()=>{
  const revision=store.getSnapshot().revision;
  await assert.rejects(runCorrection({root,kind:"entity",id:"a",instruction:"Короче",runner:async({role})=>role==="editor"?{value:{mode:"wording",title:"Перевод денег",description:null,status:null,summary:""}}:{value:{passed:false,summary:"Это новая неподтверждённая возможность",issues:[]}}}),/неподтверждённая/);
  assert.equal(store.getSnapshot().revision,revision);
});
test("explicit explanation preferences persist without a model call",async()=>{
  await runCorrection({root,kind:"profile",id:"profile",instruction:"Объясняй через результат для клиента",runner:()=>{throw new Error("Unnecessary model call");}});
  assert.ok(store.getSnapshot().map.explanationProfile.explicitInstructions.includes("Объясняй через результат для клиента"));
});
test("grouping keeps original identities and dependencies; removed links do not remain valid flows",async()=>{
  const result=await runCorrection({root,kind:"entity",id:"a",otherId:"b",action:"group",instruction:"Приём и обработка"});
  const snapshot=store.getSnapshot();assert.equal(snapshot.entities.length,3);assert.equal(snapshot.entities.find(e=>e.id==="a").parentId,snapshot.entities.find(e=>e.id==="b").parentId);
  const group=snapshot.entities.find(item=>item.ownerGroup);
  const proposed=observerEvents({entityChanges:[{operation:"upsert",entityId:"a",areaId:"elsewhere",parentId:"",label:"Изменённый приём",status:"operational"},{operation:"remove",entityId:group.id}],targetEntityIds:["a"],workStatus:"done"},{verified:true,final:true,workId:"group-check"});
  assert.equal(proposed.find(event=>event.type==="entity.upsert").payload.parentId,group.id);
  assert.equal(proposed.find(event=>event.type==="entity.upsert").payload.areaId,"domain");
  assert.equal(proposed.some(event=>event.type==="entity.remove"),false);
  assert.equal(snapshot.relations[0].from,"a");undoCorrection(result.id);
  assert.equal(store.getSnapshot().entities.find(item=>item.id==="a").parentId,"");
  await runCorrection({root,kind:"relation",id:"r",action:"remove",instruction:"Связь ошибочная"});
  assert.equal(store.getSnapshot().relations.length,0);assert.equal(store.getSnapshot().map.keyFlows[0].status,"unresolved");
});
test("a model response cannot overwrite an owner's intervening correction",async()=>{
  const before=store.getSnapshot();const signature=semanticSignature(before);
  const entity=before.entities.find(e=>e.id==="a");store.appendEvent(store.createEvent("entity.upsert",{actor:"owner",payload:{...entity,ownerLabel:"Моё название"}}));
  assert.throws(()=>applyArchitecture({projectTitle:"Заявки",areas:[],entities:[],relations:[],keyFlows:[]},{expectedSignature:signature}),/поправки владельца изменились/);
  assert.equal(store.getSnapshot().entities.find(e=>e.id==="a").ownerLabel,"Моё название");
});
