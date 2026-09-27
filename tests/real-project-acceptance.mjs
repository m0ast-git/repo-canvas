import path from "node:path";
import fs from "node:fs";
const root=path.resolve(process.argv[2]||".");const data=path.resolve(process.argv[3]||"output/playwright/real-project-data");
process.env.REPO_CANVAS_ROOT=root;process.env.REPO_CANVAS_DATA_DIR=data;
const {writeRuntimeConfig}=await import("../repo-canvas/scripts/runtime-config.mjs");
if(process.env.CANVAS_ACCEPTANCE_BALANCED==="1") {
  const {configuredModelCatalog}=await import("../repo-canvas/scripts/model-providers.mjs");
  const model=configuredModelCatalog("codex").filter(item=>item.tier==="balanced").sort((a,b)=>a.priority-b.priority)[0]?.model;
  if(!model)throw new Error("No balanced model in the local catalog");
  for(const role of ["ARCHITECT","VERIFIER","HISTORIAN","EDITOR"])process.env[`REPO_CANVAS_${role}_MODEL`]=model;
}
writeRuntimeConfig({enabled:false,dialogSources:true,modelProvider:"codex",allowedModelProviders:["codex"],maxModelTokens:Number(process.env.CANVAS_ACCEPTANCE_TOKENS||180000),maxModelCalls:12});
const {runArchitect}=await import("../repo-canvas/scripts/architect.mjs");
try{const result=await runArchitect({root,refresh:true,language:"ru",viewpoint:"Покажи проект как понятную систему: от кода и проектных диалогов через построение и проверку знаний до живой карты, исправлений владельца и истории. Кратко объясняй назначение, путь данных, состояние реализации и основания. Владелец мыслит продуктом и процессами. Сохрани реальные технические имена в раскрываемых деталях.",onProgress:progress=>{if(progress.phase&&progress.phase!=="reasoning")console.log(JSON.stringify({phase:progress.phase,detail:progress.detail}));}});fs.writeFileSync(path.join(data,"acceptance-result.json"),JSON.stringify(result,null,2));console.log(JSON.stringify(result));}catch(error){console.error(JSON.stringify({error:error.message,audit:error.audit}));process.exitCode=1;}
