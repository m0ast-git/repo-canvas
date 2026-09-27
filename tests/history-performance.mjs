import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";

const root=path.resolve(process.argv[2]||"output/playwright/history-performance");
if(fs.existsSync(root))throw new Error(`Fixture already exists: ${root}`);
fs.mkdirSync(path.join(root,".repo-canvas"),{recursive:true});fs.writeFileSync(path.join(root,"package.json"),'{"name":"history-performance"}');
process.env.REPO_CANVAS_ROOT=root;process.env.REPO_CANVAS_DATA_DIR=path.join(root,".repo-canvas");
const store=await import("../repo-canvas/scripts/canvas-store.mjs");
const history=await import("../repo-canvas/scripts/canvas-history.mjs");
const initial=[store.createEvent("map.upsert",{payload:{projectTitle:"Нагрузочная карта"}}),store.createEvent("area.upsert",{payload:{id:"a",title:"Обработка"}}),...Array.from({length:250},(_,i)=>store.createEvent("entity.upsert",{payload:{id:`e${i}`,areaId:"a",label:`Модуль ${i}`,status:"operational",x:i*20,y:20}}))];
store.appendEvents(initial);
const descriptor=fs.openSync(store.eventsFile,"a");let revision=initial.length;
try {
  for(let checkpoint=1;checkpoint<=10000;checkpoint++) {
    const rows=Array.from({length:10},(_,i)=>store.createEvent("entity.upsert",{actor:"benchmark",payload:{id:`e${(checkpoint+i)%250}`,areaId:"a",label:`Модуль ${(checkpoint+i)%250}`,status:"operational",x:checkpoint+i,y:20}}));
    const last=rows.at(-1);last.payload._checkpoint={id:"cp-"+last.id,firstRevision:revision+1,revision:revision+10,kind:"map",recordedAt:last.ts};revision+=10;
    fs.writeSync(descriptor,rows.map(row=>JSON.stringify(row)).join("\n")+"\n");
  }
} finally{fs.closeSync(descriptor);}
const loadAt=performance.now();store.getSnapshot();const liveLoadMs=performance.now()-loadAt;
const indexAt=performance.now();const index=await history.historyIndex();const indexMs=performance.now()-indexAt;
const samples=[];
for(let i=0;i<100;i++){const point=index.checkpoints[(i*97)%index.checkpoints.length];const at=performance.now();const state=await history.stateAtCheckpoint(point.id);samples.push(performance.now()-at);assert.equal(state.revision,point.revision);}
samples.sort((a,b)=>a-b);
const appendAt=performance.now();store.appendEvent(store.createEvent("entity.upsert",{actor:"benchmark",payload:{id:"e0",areaId:"a",label:"Проверка сохранения",status:"operational",x:2,y:20}}));const appendMs=performance.now()-appendAt;
const result={checkpoints:index.checkpoints.length,events:revision,liveLoadMs,indexMs,seekP95Ms:samples[94],appendMs,rssMB:process.memoryUsage().rss/1024/1024,heapMB:process.memoryUsage().heapUsed/1024/1024};
fs.writeFileSync(path.join(root,"measurements.json"),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
