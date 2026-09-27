import fs from "node:fs";
import path from "node:path";
const root=path.resolve(process.argv[2]||".");
const data=path.resolve(process.argv[3]||"output/playwright/cold-build-0133");
if(fs.existsSync(data))throw new Error("Acceptance requires a new empty data directory");
process.env.REPO_CANVAS_ROOT=root;process.env.REPO_CANVAS_DATA_DIR=data;
const {writeRuntimeConfig}=await import("../repo-canvas/scripts/runtime-config.mjs");
const {roleModelPresets}=await import("../repo-canvas/scripts/model-providers.mjs");
const roles=roleModelPresets({modelProvider:"codex",allowedModelProviders:["codex"],modelPool:[]});
writeRuntimeConfig({enabled:false,dialogSources:true,modelProvider:"codex",allowedModelProviders:["codex"],modelPool:Object.entries(roles).map(([role,p])=>({provider:p.provider,model:p.model,effort:p.effort,roles:[role]})),maxModelCalls:14,maxModelTokens:300000});
const {getSnapshot}=await import("../repo-canvas/scripts/canvas-store.mjs");
const {runArchitect}=await import("../repo-canvas/scripts/architect.mjs");
if(getSnapshot().entities.length)throw new Error("Cold build started with an existing map");
const started=Date.now();let last="";
try {
  const result=await runArchitect({root,language:"ru",resumeCandidate:false,viewpoint:"Объясни устройство проекта через его назначение, основные функции и путь данных. Я мыслю продуктом и процессами. Используй короткий понятный русский язык, не пытайся перечислить каждый технический шаг.",onProgress:p=>{const key=`${p.phase}:${p.eventType}:${p.call}`;if(key!==last){last=key;console.log(JSON.stringify({elapsedMs:Date.now()-started,phase:p.phase,event:p.eventType,call:p.call,model:p.model}));}}});
  const snapshot=getSnapshot();
  if(snapshot.map.verification?.state!=="source-checked"||snapshot.entities.length<3)throw new Error("Generated map did not pass independent verification");
  const report={ok:true,coldStart:true,manualCandidateEdits:0,elapsedMs:Date.now()-started,roles,...result};
  fs.writeFileSync(path.join(data,"acceptance-result.json"),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
} catch(error) {
  const report={ok:false,elapsedMs:Date.now()-started,error:error.message,audit:error.audit};
  fs.writeFileSync(path.join(data,"acceptance-result.json"),JSON.stringify(report,null,2));console.error(JSON.stringify(report));process.exitCode=1;
}
