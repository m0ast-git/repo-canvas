import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const root=path.resolve(process.argv[2]||"output/playwright/builder-live");
if(fs.existsSync(root)) throw new Error(`Probe directory already exists: ${root}`);
fs.mkdirSync(root,{recursive:true});fs.mkdirSync(path.join(root,"src"));fs.mkdirSync(path.join(root,"sessions"));
execFileSync("git",["init","--quiet",root],{windowsHide:true});
fs.writeFileSync(path.join(root,"package.json"),'{"name":"orders-probe","type":"module","private":true}');
fs.writeFileSync(path.join(root,"README.md"),'# Заявки мастерской\nКлиент оставляет заявку. Приём проверяет телефон и описание. Хранилище сохраняет заявку в памяти. Отчёт показывает принятые заявки. Оплата пока только в планах.\n');
fs.writeFileSync(path.join(root,"src","store.js"),'const orders = [];\nexport function saveOrder(order) { const saved = { ...order, id: orders.length + 1 }; orders.push(saved); return saved; }\nexport function listOrders() { return orders.slice(); }\n');
fs.writeFileSync(path.join(root,"src","intake.js"),'import { saveOrder } from "./store.js";\nexport function acceptOrder(input) { if (!input.phone || !input.description) throw new Error("Нужен телефон и описание"); return saveOrder({phone:input.phone,description:input.description,status:"accepted"}); }\n');
fs.writeFileSync(path.join(root,"src","report.js"),'import { listOrders } from "./store.js";\nexport function buildReport() { return listOrders().map(order => ({id:order.id,description:order.description,status:order.status})); }\n');
const records=[
  {type:"session_meta",payload:{id:"owner-probe",cwd:root,originator:"codex_desktop"}},
  {type:"event_msg",payload:{type:"task_started",turn_id:"plan"}},
  {type:"event_msg",payload:{type:"user_message",message:"Я не разработчик. Объясняй через путь заявки и результат для клиента. У нас это называется заявкой, а не тикетом. Не надо объяснять мне бизнес, с ним я знаком."}},
  {type:"event_msg",payload:{type:"agent_message",message:"Предлагаю добавить оплату в приём заявки."}},
  {type:"event_msg",payload:{type:"user_message",message:"Оплату откладываем. Согласовано: сначала приём, сохранение заявки и отчёт по принятым заявкам."}},
].map((record,index)=>({...record,timestamp:`2026-09-01T10:00:0${index}Z`}));
const journal=path.join(root,"sessions","rollout-probe.jsonl");fs.writeFileSync(journal,records.map(record=>JSON.stringify(record)).join("\n")+"\n");
process.env.REPO_CANVAS_ROOT=root;process.env.REPO_CANVAS_DATA_DIR=path.join(root,".repo-canvas");
const {runArchitect}=await import("../repo-canvas/scripts/architect.mjs");
const {codexSessionAdapter}=await import("../repo-canvas/scripts/session-adapters.mjs");
const {getSnapshot}=await import("../repo-canvas/scripts/canvas-store.mjs");
const started=Date.now();
const result=await runArchitect({root,language:"ru",maxModelCalls:10,maxModelTokens:110000,sourceOptions:{includeArchives:false,adapters:[{...codexSessionAdapter,listFiles:()=>[journal]}]},onProgress:progress=>{if(["knowledge","sources","evidence","reviewing","applying","repairing"].includes(progress.phase))console.log(JSON.stringify({phase:progress.phase,detail:progress.detail||"",elapsedMs:Date.now()-started}));}});
const snapshot=getSnapshot();
assert.equal(snapshot.map.explanationProfile.language,"ru");
assert.equal(snapshot.map.verification.state,"source-checked");
assert.ok(snapshot.map.projectSummary.length>30);
assert.ok(snapshot.entities.length>=3);
assert.ok(snapshot.map.knowledge.decisions.some(item=>item.status==="accepted"));
const report={...result,elapsedMs:Date.now()-started,profile:snapshot.map.explanationProfile,decisions:snapshot.map.knowledge.decisions};
fs.writeFileSync(path.join(root,"result.json"),JSON.stringify(report,null,2));
console.log(JSON.stringify(report));
