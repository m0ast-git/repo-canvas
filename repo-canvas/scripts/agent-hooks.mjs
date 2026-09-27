import crypto from "node:crypto";
import {appendEvent,createEvent,getSnapshot,projectRoot} from "./canvas-store.mjs";
import {pathBelongsToRoot} from "./codex-sessions.mjs";
import {targetsForFiles} from "./module-cards.mjs";

export function ingestAgentHook(event,{root=projectRoot}={}) {
  if(process.env.REPO_CANVAS_INTERNAL_SESSION==="1")return {ignored:true,reason:"internal"};
  if(!event||!event.cwd||!pathBelongsToRoot(event.cwd,root))throw new Error("Событие относится к другому проекту");
  const name=event.hook_event_name||event.event;const sessionId=String(event.session_id||event.thread_id||"");
  if(!sessionId||sessionId.length>180)throw new Error("Нужен идентификатор сессии");
  if(!["UserPromptSubmit","PostToolUse","Stop","Interrupt","SessionEnd"].includes(name))return {ignored:true};
  const snapshot=getSnapshot();
  const existing=snapshot.work.filter(item=>item.session?.id===sessionId&&["active","blocked"].includes(item.status)).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt))[0];
  const ended=["Stop","Interrupt","SessionEnd"].includes(name);
  if(ended&&!existing)return {ignored:true,reason:"already-finished"};
  if(name==="PostToolUse"&&!existing)return {ignored:true,reason:"no-active-turn"};
  const turnKey=event.turn_id||crypto.randomUUID();
  const id=existing?.id||`hook-${crypto.createHash("sha256").update(`${sessionId}:${turnKey}`).digest("hex").slice(0,32)}`;
  if(snapshot.work.some(item=>item.id===id&&!["active","blocked"].includes(item.status)))return {ignored:true,reason:"already-finished"};
  const input=event.tool_input||{};const files=[input.file_path,input.path,...(Array.isArray(input.files)?input.files:[])].filter(item=>typeof item==="string");
  const targets=[...new Set([...(existing?.targets||[]),...targetsForFiles(snapshot,files,root)])];
  const payload={id,title:existing?.title||String(event.prompt||"Работа агента").split("\n")[0].slice(0,160)||"Работа агента",note:ended?"Сессия завершила ход; изменения карты подтверждаются отдельно":"Агент работает с файлами проекта",targets,status:ended?(name==="Stop"?"done":"stopped"):"active",provisional:!targets.length,session:{kind:event.provider==="claude"?"claude-cli":"codex-cli",id:sessionId,cwd:root},hookDriven:true,hookTurnId:event.turn_id||null};
  appendEvent(createEvent("work.upsert",{actor:existing?.actor||"hooks",payload}));return {id,status:payload.status,targets};
}

export async function readHookInput(input=process.stdin) {
  let text="";for await(const chunk of input){text+=chunk;if(text.length>256000)throw new Error("Событие слишком большое");}
  return JSON.parse(text);
}
