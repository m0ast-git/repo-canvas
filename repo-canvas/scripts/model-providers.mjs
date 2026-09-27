import { structuredValidator, validateStructuredValue } from "./structured-schema.mjs";
export { validateStructuredValue } from "./structured-schema.mjs";
import {normalizeUsage, measureModelCall} from "./model-usage.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { MODEL_PROFILES, createCodexStructuredSession, runCodexStructured, resolveCodexExecutable, trackModelProcess } from "./model-runtime.mjs";
import { readRuntimeConfig } from "./runtime-config.mjs";
import { redactSource } from "./project-sources.mjs";

const roleEffort={architect:"medium",historian:"medium",verifier:"medium",reviewer:"low",observer:"low",editor:"medium"};
export const MODEL_ROLES = ["architect","verifier","observer","reviewer"];
const roleOwner = role => ["historian","editor"].includes(role) ? "architect" : role;
async function cleanupModelDirectory(directory) {
  const resolved=path.resolve(directory);
  if(!resolved.startsWith(path.resolve(os.tmpdir())+path.sep) || !path.basename(resolved).startsWith("repo-canvas-model-")) throw new Error("Unexpected model cleanup directory");
  await fs.promises.rm(resolved,{recursive:true,force:true,maxRetries:8,retryDelay:150});
}
export function resolveExternalCli(provider, override="") {
  if(override) {if(!path.isAbsolute(override) || !fs.existsSync(override)) throw new Error("Путь исполнителя должен указывать на существующий файл");return /\.[cm]?js$/.test(override)?{command:process.execPath,prefix:[override]}:{command:override,prefix:[]};}
  if(provider==="codex") return {command:resolveCodexExecutable(),prefix:[]};
  const npmEntry=provider==="kimi"?"@moonshot-ai/kimi-code/dist/main.mjs":"@anthropic-ai/claude-code/cli.js";
  for(const directory of (process.env.PATH || "").split(path.delimiter)) {
    const script=path.join(directory,"node_modules",npmEntry);
    if(fs.existsSync(script)) return {command:process.execPath,prefix:[script]};
    const executable=path.join(directory,provider+(process.platform==="win32"?".exe":""));
    if(fs.existsSync(executable)) return {command:executable,prefix:[]};
  }
  throw new Error(`CLI ${provider} не найден. Установите его или укажите путь в настройках моделей.`);
}
export function discoverModelProviders() {
  return ["codex","claude","kimi"].map(id=>{
    try {
      const cli=resolveExternalCli(id);
      const configured=id==="codex"?fs.existsSync(path.join(process.env.CODEX_HOME || path.join(os.homedir(),".codex"),"auth.json")):id==="kimi"?fs.existsSync(path.join(process.env.KIMI_CODE_HOME || path.join(os.homedir(),".kimi-code"),"config.toml")):true;
      return {id,installed:true,configured,executable:cli.prefix[0]||cli.command,label:{codex:"OpenAI · Codex",claude:"Anthropic · Claude Code",kimi:"Kimi Code"}[id]};
    } catch(error) {return {id,installed:false,configured:false,label:id,reason:error.message};}
  });
}
export function configuredModelCatalog(provider) {
  if(provider!=="codex") return [];
  try {
    const cache=JSON.parse(fs.readFileSync(path.join(process.env.CODEX_HOME || path.join(os.homedir(),".codex"),"models_cache.json"),"utf8"));
    return (cache.models||[]).filter(model=>model.visibility==="list").map(model=>({provider,model:model.slug,description:model.description,context: model.context_window,efforts:(model.supported_reasoning_levels||[]).map(level=>level.effort),priority:model.priority??99,tier:/affordable|cost-efficient|small|ultra-fast/i.test(model.description)?"fast":/workhorse|balanced|everyday/i.test(model.description)?"balanced":"strong",validated:false}));
  } catch {return [];}
}
export function taskComplexity(role,{promptChars=0,retry=false}={}) {
  return (["architect","historian","verifier","editor"].includes(role) && (retry || promptChars>120000)) ? "hard" : "normal";
}
export function selectModelProfile(role,{config=readRuntimeConfig(),profile,complexity="normal",contextTokens=0}={}) {
  if(profile?.provider&&profile.model) return {...profile,effort:profile.effort||roleEffort[role]||"medium"};
  const available=discoverModelProviders().filter(item=>item.installed&&item.configured);
  const defaultProvider=profile?.provider || config.modelProvider || available[0]?.id;
  if(!defaultProvider) throw new Error("Нет настроенного исполнителя моделей. Подключите Codex, Claude Code или Kimi Code.");
  const allowed=profile?.provider?[profile.provider]:config.allowedModelProviders?.length?config.allowedModelProviders:[defaultProvider];
  const pinned=(config.modelPool||[]).filter(item=>allowed.includes(item.provider)&&(!item.roles?.length || item.roles.includes(role) || item.roles.includes(roleOwner(role))));
  const pool=(pinned.length?pinned:configuredModelCatalog(defaultProvider)).filter(item=>allowed.includes(item.provider)&&(!item.context || item.context>=contextTokens));
  if(pinned.length && !pool.length) throw new Error("Объём фрагмента превышает известный контекст разрешённых моделей. Сузьте источники или выберите модель с большим контекстом.");
  const target=["observer","reviewer"].includes(role)?"fast":"strong";
  const rank=item=>item.tier===target?3:item.tier==="balanced"?2:1;
  pool.sort((a,b)=>rank(b)-rank(a) || Number(b.validated||0)-Number(a.validated||0) || (a.priority??99)-(b.priority??99));
  const chosen=pool[0] || {provider:defaultProvider,model:defaultProvider==="codex"?MODEL_PROFILES[role]?.model||MODEL_PROFILES.architect.model:""};
  if(!allowed.includes(chosen.provider)) throw new Error("Исполнитель не входит в разрешённый набор");
  const fixedRole=chosen.roles?.includes(role)||chosen.roles?.includes(roleOwner(role));
  let effort=profile?.effort || (fixedRole?chosen.effort:null) || process.env[`REPO_CANVAS_${role.toUpperCase()}_EFFORT`] || chosen.effort || roleEffort[role] || "medium";
  if(chosen.efforts?.length&&!chosen.efforts.includes(effort)) effort=chosen.efforts[0];
  return {...chosen,model:profile?.model || (fixedRole?chosen.model:null) || process.env[`REPO_CANVAS_${role.toUpperCase()}_MODEL`] || chosen.model,effort,reason:pool.length?`Роль ${role}: ${target}, разрешённый набор`:`Настроенный ${chosen.provider}; глубина по роли ${role}`};
}
export function roleModelPresets(config=readRuntimeConfig()) {
  return Object.fromEntries(MODEL_ROLES.map(role => {
    const pick = value => {const p=selectModelProfile(role,{config:value});return {provider:p.provider,model:p.model,effort:p.effort};};
    return [role,{...pick(config),recommended:pick({...config,modelPool:[]})}];
  }));
}
export function modelConfigPatch(body) {
  if(!["codex","claude","kimi"].includes(body.modelProvider)) throw new Error("Выберите подключённого провайдера моделей");
  const patch={modelProvider:body.modelProvider,allowedModelProviders:[body.modelProvider]};
  if(Array.isArray(body.modelPool)) {
    patch.modelPool=body.modelPool.map(item=>{
      if(!["codex","claude","kimi"].includes(item.provider)||typeof item.model!=="string"||item.model.length>150||!Array.isArray(item.roles)||!item.roles.length||item.roles.some(role=>!Object.hasOwn(roleEffort,role))||!["low","medium","high","xhigh","max"].includes(item.effort||"medium")) throw new Error("Проверьте модель и глубину размышления для каждой роли");
      return {provider:item.provider,model:item.model.trim(),effort:item.effort||roleEffort[item.roles[0]],roles:item.roles};
    }).slice(0,12);
    patch.allowedModelProviders=[...new Set([body.modelProvider,...patch.modelPool.map(item=>item.provider)])];
  }
  return patch;
}
function isolatedKimiConfig(directory) {
  const sourceHome=process.env.KIMI_CODE_HOME || path.join(os.homedir(),".kimi-code");
  const original=fs.readFileSync(path.join(sourceHome,"config.toml"),"utf8");
  let keep=true;
  const lines=original.split(/\r?\n/).filter(line=>{
    if(line.trim().startsWith("[")) keep=/^\[(?:providers|models|secondary_model|thinking|loop_control)(?:[.\]])/.test(line.trim());
    if(!keep) return false;
    if(!line.trim().startsWith("[")&&!line.trim().startsWith("#")&&line.includes("=")&&!/^(?:default_model|default_provider|model)\s*=/.test(line) && !/^\s/.test(line) && !original.slice(0,original.indexOf(line)).includes("[")) return false;
    return true;
  });
  fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(path.join(directory,"config.toml"),lines.join("\n"),{mode:0o600});
  const credential=path.join(sourceHome,"credentials","kimi-code.json");
  if(fs.existsSync(credential)) {fs.mkdirSync(path.join(directory,"credentials"),{recursive:true});fs.copyFileSync(credential,path.join(directory,"credentials","kimi-code.json"));}
  if(fs.existsSync(path.join(sourceHome,"device_id"))) fs.copyFileSync(path.join(sourceHome,"device_id"),path.join(directory,"device_id"));
}
export async function createProviderSession({cwd,profile,role="architect"}={}) {
  profile=selectModelProfile(role,{profile});
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"repo-canvas-model-"));
  const session={cwd,profile,directory,context:"",turns:0,closed:false};
  try {
    if(profile.provider==="codex") session.inner=await createCodexStructuredSession({cwd:directory,profile});
    if(profile.provider==="kimi") {session.kimiHome=path.join(directory,"home");isolatedKimiConfig(session.kimiHome);}
    session.close=async()=>{session.closed=true;await session.inner?.close();await cleanupModelDirectory(directory);};
    return session;
  } catch(error) {await cleanupModelDirectory(directory);throw error;}
}
export function externalArguments(provider,{profile,schema,agentFile}={}) {
  if(provider==="claude") return ["--safe-mode","--restricted","-p","--output-format","stream-json","--verbose","--json-schema",JSON.stringify(schema),"--tools","","--disallowedTools","mcp__*","--permission-prompts","none","--no-session-persistence",...(profile.model?["--model",profile.model]:[]),"--effort",profile.effort];
  if(provider==="kimi") return ["--agent-file",agentFile,"--output-format","stream-json",...(profile.model?["--model",profile.model]:[]),"-p","Return the requested JSON using only the supplied project sources."];
  throw new Error(`Неизвестный исполнитель ${provider}`);
}
function textContent(content) {return typeof content==="string"?content:Array.isArray(content)?content.filter(part=>part.type==="text").map(part=>part.text||"").join(""):"";}
export function parseExternalOutput(provider,stdout) {
  let value;let finalText="";let usage=null;let threadId=null;let failure="";
  for(const line of stdout.split(/\r?\n/).filter(Boolean)) {
    let event;try{event=JSON.parse(line);}catch{continue;}
    if(event.structured_output) value=event.structured_output;
    if(event.type==="result") {if(event.is_error) failure=event.result||event.subtype;finalText=event.result||finalText;usage=event.usage||usage;threadId=event.session_id||threadId;}
    if(event.role==="assistant") finalText=textContent(event.content)||finalText;
    if(event.type==="assistant") finalText=textContent(event.message?.content)||finalText;
    if(event.type==="content.part"&&event.part?.type==="text") finalText+=event.part.text||"";
    if(event.type==="context.append_loop_event"&&event.event?.type==="content.part"&&event.event.part?.type==="text") finalText+=event.event.part.text||"";
    if(event.type==="usage") usage=event.usage||event;
    if(event.type==="error") failure=event.message||event.error?.message||"Ошибка исполнителя";
  }
  if(failure) throw new Error(redactSource(failure));
  if(!value) {try{value=JSON.parse(finalText.trim().replace(/^```(?:json)?\s*/i,"").replace(/\s*```$/,""));}catch{throw new Error(`${provider} не вернул корректный JSON`);}}
  return {value,usage,threadId};
}
export async function runStructured(options) {
  structuredValidator(options.outputSchema);
  return measureModelCall(options, () => runStructuredProvider(options), {config:readRuntimeConfig()});
}

async function runStructuredProvider(options) {
  const complexity=options.complexity||taskComplexity(options.role,{promptChars:options.prompt?.length||0});
  const profile=selectModelProfile(options.role,{profile:options.session?.profile||options.profile,complexity});
  const session=options.session || await createProviderSession({cwd:options.cwd,profile,role:options.role});
  const own=!options.session;
  try {
    if(session.closed) throw new Error("Сессия исполнителя уже закрыта");
    let response;
    if(profile.provider==="codex") {response=await runCodexStructured({...options,cwd:session.directory,session:session.inner,profile});session.turns=session.inner.turns;}
    else {
      const prompt=(session.context?`Previous accepted working context:\n${session.context}\n\n`:"")+options.prompt+`\nReturn only JSON matching this schema: ${JSON.stringify(options.outputSchema)}`;
      const agentFile=path.join(session.directory,"reader.md");
      fs.writeFileSync(agentFile,`---\nname: canvas-reader\ndescription: Read supplied project context and return structured explanations\ntools: []\nsubagents: []\n---\n${prompt}`,{mode:0o600});
      const cli=resolveExternalCli(profile.provider,profile.executable);
      const args=[...cli.prefix,...externalArguments(profile.provider,{profile,schema:options.outputSchema,agentFile})];
      const timeout=AbortSignal.timeout(options.timeoutMs || (options.role==="observer"?90_000:8*60_000));
      const child=spawn(cli.command,args,{cwd:session.directory,env:{...process.env,...(session.kimiHome?{KIMI_CODE_HOME:session.kimiHome}:{}),REPO_CANVAS_INTERNAL_SESSION:"1"},stdio:["pipe","pipe","pipe"],windowsHide:true,signal:options.signal?AbortSignal.any([options.signal,timeout]):timeout});
      const untrack=trackModelProcess(child);let stdout="",stderr="";
      child.stdout.on("data",chunk=>{stdout+=chunk;if(stdout.length>8*1024*1024) child.kill();options.onProgress?.({phase:"reasoning",at:new Date().toISOString()});});
      child.stderr.on("data",chunk=>{stderr=(stderr+chunk).slice(-8000);});
      child.stdin.on("error",()=>{});child.stdin.end(profile.provider==="claude"?prompt:"");
      try {
        let failure;
        const code=await new Promise(resolve=>{child.once("error",error=>{failure=error;});child.once("close",resolve);});
        if(failure) throw new Error(`${profile.provider}: ${failure.message}. ${redactSource(stderr).slice(-1000)} ${redactSource(stdout).slice(-1200)}`);
        if(code!==0) throw new Error(`${profile.provider}: ${redactSource(stderr).slice(-1500) || `код завершения ${code}`}`);
        response={...parseExternalOutput(profile.provider,stdout),profile};
      } finally {untrack();if(child.exitCode===null)child.kill();}
      session.context=JSON.stringify(response.value);session.turns++;
    }
    validateStructuredValue(response.value,options.outputSchema);
    return {...response,profile,provider:profile.provider,resumed:response.resumed ?? session.turns>1};
  } catch(error) {error.profile=profile;throw error;} finally {if(own) await session.close();}
}

export async function probeModel({cwd=process.cwd(),provider}={}) {
  const profile=selectModelProfile("reviewer",{profile:provider?{provider,model:"",effort:"low"}:undefined});const started=Date.now();
  try {
    const result=await runStructured({role:"reviewer",cwd,profile,prompt:"Return {ok:true}, encoded as JSON. Use no tools.",outputSchema:{type:"object",additionalProperties:false,properties:{ok:{type:"boolean"}},required:["ok"]},timeoutMs:45000});
    return {provider:profile.provider,model:result.profile.model,models:[result.profile.model],calls:1,usage:normalizeUsage(result.usage),status:result.value.ok?"connected":"not-connected",latencyMs:Date.now()-started};
  } catch(error) {return {provider:profile.provider,model:profile.model,status:"not-connected",error:error.message,latencyMs:Date.now()-started};}
}
