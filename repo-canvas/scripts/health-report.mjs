import fs from "node:fs";
import path from "node:path";
import {execFileSync} from "node:child_process";
import {modelUsageSummary, BACKGROUND_DEFAULTS} from "./model-usage.mjs";
import {readAppendedRecords} from "./codex-sessions.mjs";
import {dataDirectory,eventsFile,getSnapshot,projectRoot} from "./canvas-store.mjs";
import {readRuntimeConfig} from "./runtime-config.mjs";
import {latestEvaluation} from "./map-evaluation.mjs";

let cached=null;
export function healthReport(observer) {
  const now=Date.now();
  if(!cached||now-cached.at>15000) {
    let bytes=0,files=0;const walk=directory=>{for(const entry of fs.readdirSync(directory,{withFileTypes:true})){const file=path.join(directory,entry.name);if(entry.isDirectory())walk(file);else if(entry.isFile()){files++;bytes+=fs.statSync(file).size;}}};
    if(fs.existsSync(dataDirectory))walk(dataDirectory);
    const events={};const tasks={};const days={};let offset=0;
    // Only the bounded recent tail is relevant for hourly alarms.
    if(fs.existsSync(eventsFile)) {
      const size=fs.statSync(eventsFile).size;offset=Math.max(0,size-4*1024*1024);
      if(offset) {const fd=fs.openSync(eventsFile,"r");const block=Buffer.alloc(Math.min(size-offset,1024*1024));try{fs.readSync(fd,block,0,block.length,offset);}finally{fs.closeSync(fd);}const end=block.indexOf(10);offset=end<0?size:offset+end+1;}
      const delta=readAppendedRecords(eventsFile,offset,{maxBytes:4*1024*1024,maxRecords:10000,maxRecordBytes:2*1024*1024});
      for(const event of delta.records) {
        if(event.payload?._checkpoint) {const day=event.ts.slice(0,10);days[day]=(days[day]||0)+1;}
        if(Date.parse(event.ts)<now-3600000)continue;
        events[event.type]=(events[event.type]||0)+1;
        if(event.type==="work.upsert")tasks[event.payload.id]=(tasks[event.payload.id]||0)+1;
      }
    }
    let git={available:false};
    try {
      const dirty=execFileSync("git",["status","--porcelain","-z"],{cwd:projectRoot,encoding:"utf8",windowsHide:true,timeout:3000,maxBuffer:1024*1024}).split("\0").filter(Boolean);
      const lastCommit=execFileSync("git",["log","-1","--format=%cI"],{cwd:projectRoot,encoding:"utf8",windowsHide:true,timeout:3000}).trim();
      git={available:true,changedFiles:dirty.filter(line=>line.length>3).length,lastCommit,daysSinceCommit:Math.floor((now-Date.parse(lastCommit))/86400000)};
    } catch {}
    cached={at:now,storage:{bytes,files},eventsLastHour:events,checkpointsByDay:days,checkpointCountsAreRecentTail:true,noisyWork:Object.entries(tasks).filter(([,count])=>count>100).map(([id,count])=>({id,count})),git};
  }
  const config=readRuntimeConfig();
  return {...cached,revision:getSnapshot().revision,usage:modelUsageSummary(),evaluation:latestEvaluation(),observer:observer||{enabled:config.enabled,running:false},limits:{callsPerHour:config.backgroundMaxCallsPerHour||BACKGROUND_DEFAULTS.callsPerHour,tokensPerDay:config.backgroundMaxTokensPerDay||BACKGROUND_DEFAULTS.tokensPerDay,finalAttempts:config.observerFinalAttempts||BACKGROUND_DEFAULTS.finalAttempts}};
}
