import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { projectRoot, resolveDataDirectory } from "./project-root.mjs";

export const BACKGROUND_DEFAULTS = Object.freeze({callsPerHour:60, tokensPerDay:300000, finalAttempts:3});

function usageDirectory(root=projectRoot) { return path.join(resolveDataDirectory(root), "model-usage"); }
function appendUsage(root, record) {
  const directory = usageDirectory(root);
  fs.mkdirSync(directory, {recursive:true});
  fs.appendFileSync(path.join(directory, `${record.at.slice(0,10)}.jsonl`), `${JSON.stringify(record)}\n`, {mode:0o600});
}
function usageRecords(root, since) {
  const directory = usageDirectory(root);
  if (!fs.existsSync(directory)) return [];
  const firstDay = new Date(since).toISOString().slice(0,10);
  return fs.readdirSync(directory).filter(file => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(file) && file.slice(0,10) >= firstDay)
    .flatMap(file => fs.readFileSync(path.join(directory,file), "utf8").split("\n").filter(Boolean).flatMap(line => {
      try { const value=JSON.parse(line); return Date.parse(value.at)>=since?[value]:[]; } catch { return []; }
    }));
}

export function modelUsageSummary(root=projectRoot, {now=Date.now(), days=7}={}) {
  const records=usageRecords(root,now-days*86400000);
  const calls=new Map(records.filter(item=>item.kind==="start").map(item=>[item.id,{...item,status:"interrupted",usage:null}]));
  for(const item of records) if(item.kind==="finish" && calls.has(item.id)) Object.assign(calls.get(item.id),item,{startedAt:calls.get(item.id).at});
  const today=new Date(now).toISOString().slice(0,10);
  const roles={}; let knownTokens=0,unknownCalls=0;
  for(const call of calls.values()) {
    const role=roles[call.role] ||= {calls:0,today:0,lastHour:0,errors:0,tokens:0,unknown:0,durationMs:0};
    role.calls++; role.today+=Number((call.startedAt||call.at).startsWith(today));
    role.lastHour+=Number(Date.parse(call.startedAt||call.at)>now-3600000);
    role.errors+=Number(call.status!=="done"); role.durationMs+=call.durationMs||0;
    if(call.usage) {role.tokens+=call.usage.totalTokens;knownTokens+=call.usage.totalTokens;} else {role.unknown++;unknownCalls++;}
  }
  const pauses=records.filter(item=>item.kind==="pause" && Date.parse(item.until)>now);
  return {days,calls:calls.size,knownTokens,unknownCalls,roles,pauses:[...new Map(pauses.map(item=>[item.role,item])).values()],recent:[...calls.values()].slice(-30).reverse()};
}

async function reserveUsage(root, start, config, now, signal) {
  const directory=usageDirectory(root);fs.mkdirSync(directory,{recursive:true});
  const lock=path.join(directory,"usage.lock"); let descriptor; const deadline=Date.now()+5000;
  while(descriptor===undefined) {
    signal?.throwIfAborted();
    try {descriptor=fs.openSync(lock,"wx",0o600);fs.writeFileSync(descriptor,JSON.stringify({pid:process.pid,at:Date.now()}));}
    catch(error) {
      if(error.code!=="EEXIST")throw error;
      try {
        const owner=JSON.parse(fs.readFileSync(lock,"utf8"));
        if(Date.now()-owner.at>30000) {let alive=true;try{process.kill(owner.pid,0);}catch(check){alive=check.code!=="ESRCH";}if(!alive)fs.unlinkSync(lock);}
      } catch {}
      if(Date.now()>deadline)throw new Error("Учёт вызовов занят; повторите позже");
      await delay(20,undefined,{signal});
    }
  }
  try {
    if(start.background) {
      const dayStart=Date.parse(new Date(now).toISOString().slice(0,10));
      const records=usageRecords(root,Math.min(dayStart,now-3600000));
      const starts=records.filter(item=>item.kind==="start"&&item.background);
      const ends=new Map(records.filter(item=>item.kind==="finish").map(item=>[item.id,item]));
      const hourly=starts.filter(item=>item.role===start.role&&Date.parse(item.at)>now-3600000);
      const spent=starts.filter(item=>Date.parse(item.at)>=dayStart).reduce((sum,item)=>sum+(ends.get(item.id)?.usage?.totalTokens??item.estimatedTokens),0);
      const hourlyLimit=Number(config.backgroundMaxCallsPerHour)||BACKGROUND_DEFAULTS.callsPerHour;
      const dailyLimit=Number(config.backgroundMaxTokensPerDay)||BACKGROUND_DEFAULTS.tokensPerDay;
      if(hourly.length>=hourlyLimit || spent+start.estimatedTokens>dailyLimit) {
        const hourlyHit=hourly.length>=hourlyLimit;
        const reason=hourlyHit?`Фоновая роль ${start.role}: достигнут предел ${hourlyLimit} вызовов в час`:`Достигнут дневной предел фонового расхода ${dailyLimit.toLocaleString("ru-RU")} токенов`;
        const until=new Date(hourlyHit?Date.parse(hourly[0].at)+3600000:dayStart+86400000).toISOString();
        if(!records.some(item=>item.kind==="pause"&&item.role===start.role&&item.until===until))appendUsage(root,{kind:"pause",at:start.at,role:start.role,reason,until});
        const error=new Error(reason);error.code="BACKGROUND_LIMIT";error.until=until;throw error;
      }
    }
    appendUsage(root,start);
  } finally {fs.closeSync(descriptor);fs.unlinkSync(lock);}
}

export async function measureModelCall(options, run, {config={},now=()=>Date.now()}={}) {
  const root=options.usageRoot||options.cwd||projectRoot; const began=now();
  const start={kind:"start",id:crypto.randomUUID(),at:new Date(began).toISOString(),role:options.usageRole||options.role||"unknown",background:Boolean(options.background),estimatedTokens:Math.ceil((options.prompt?.length||0)/3)+2048};
  await reserveUsage(root,start,config,began,options.signal);
  let result; let error;
  try {result=await run();return result;} catch(failure){error=failure;throw failure;}
  finally {
    appendUsage(root,{kind:"finish",id:start.id,at:new Date(now()).toISOString(),status:error?(options.signal?.aborted?"cancelled":"failed"):"done",provider:result?.profile?.provider||error?.profile?.provider||null,model:result?.profile?.model||error?.profile?.model||null,usage:normalizeUsage(result?.usage||error?.usage),durationMs:Math.max(0,now()-began),errorCode:error?.code||null});
  }
}

export function normalizeUsage(usage) {
  if(!usage)return null;
  const number=(...keys)=>keys.map(key=>Number(usage[key])).find(Number.isFinite)||0;
  const inputTokens=number("inputTokens","input_tokens"),outputTokens=number("outputTokens","output_tokens");
  return {inputTokens,outputTokens,cachedInputTokens:number("cachedInputTokens","cached_input_tokens"),totalTokens:number("totalTokens","total_tokens")||inputTokens+outputTokens};
}

export function trackModelUsage(runner) {
  let calls=0,unknown=false;const models=new Set();const usage={inputTokens:0,outputTokens:0,cachedInputTokens:0,totalTokens:0};
  const tracked=async options=>{
    calls++;
    let result;try{result=await runner(options);}catch(error){unknown=true;if(error.profile?.model)models.add(error.profile.model);throw error;}
    const model=result.profile?.model||result.model||options.profile?.model;
    if(model)models.add(model);
    const consumed=normalizeUsage(result.usage);if(!consumed)unknown=true;else for(const key of Object.keys(usage))usage[key]+=consumed[key];
    return result;
  };
  return {runner:tracked,summary:()=>({calls,models:[...models],usage:unknown?null:{...usage}})};
}
