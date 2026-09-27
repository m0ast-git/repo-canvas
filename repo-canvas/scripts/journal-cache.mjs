import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { projectRoot, resolveDataDirectory } from "./project-root.mjs";
import { validateEvent, validateEventSequence } from "./canvas-schema.mjs";
import { reduceEvents } from "./snapshot-reducer.mjs";
import { replaceFileSync } from "./atomic-file.mjs";

const directory=resolveDataDirectory(projectRoot);const file=path.join(directory,"events.jsonl");
const cacheFile=path.join(directory,"current-cache.json");let cache=null;
function signature(stat) {return `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;}
function edgeHash(offset) {
  const descriptor=fs.openSync(file,"r");const hash=crypto.createHash("sha256");
  try {
    for(const [start,length] of [[0,Math.min(256,offset)],[Math.max(0,offset-256),Math.min(256,offset)]]) {const buffer=Buffer.alloc(length);fs.readSync(descriptor,buffer,0,length,start);hash.update(buffer);}
  }finally{fs.closeSync(descriptor);}return hash.digest("hex");
}
function publicValue(raw) {const {_rawWork,...value}=raw;return value;}
function persist() {
  if(cache.raw.storeErrors.length)return;
  const temporary=`${cacheFile}.${process.pid}.tmp`;
  const {_rawWork,...raw}=cache.raw;if(_rawWork)raw.work=_rawWork;
  const stored={version:2,offset:cache.offset,lines:cache.lines,inode:cache.inode,mtime:fs.statSync(file).mtimeMs,edgeHash:edgeHash(cache.offset),raw,ids:[...cache.ids]};
  try {fs.writeFileSync(temporary,JSON.stringify(stored),{mode:0o600});replaceFileSync(temporary,cacheFile,{rename:fs.renameSync,attempts:0});}
  catch {/* Cache failure must not invalidate an already committed journal action. */}
  finally{try{if(fs.existsSync(temporary))fs.unlinkSync(temporary);}catch{}}
}
// Called under the canonical store lock. Only the new tail is parsed on the normal append path.
export function journalState() {
  const stat=fs.statSync(file);const currentSignature=signature(stat);
  if(cache?.signature===currentSignature)return cache;
  if(!cache) {
    try {
      const stored=JSON.parse(fs.readFileSync(cacheFile,"utf8"));
      if(stored.version===2 && stored.inode===stat.ino && stored.offset<=stat.size && (stored.offset<stat.size || stored.mtime===stat.mtimeMs) && stored.edgeHash===edgeHash(stored.offset)) cache={...stored,ids:new Set(stored.ids),value:publicValue(stored.raw)};
    } catch {/* a cache is disposable; the journal remains authoritative */}
  }
  if(cache && (cache.inode!==stat.ino || cache.offset>stat.size || cache.signature && cache.offset===stat.size && cache.signature!==currentSignature || cache.offset>0 && cache.edgeHash && cache.edgeHash!==edgeHash(cache.offset)))cache=null;
  if(!cache)cache={offset:0,lines:0,inode:stat.ino,ids:new Set(),raw:reduceEvents([],[],null,{retainWorkTargets:true})};
  const descriptor=fs.openSync(file,"r");const errors=[...cache.raw.storeErrors];let position=cache.offset;let remainder=Buffer.alloc(0);let batch=[];
  const flush=()=>{
    if(!batch.length)return;
    const sequence=validateEventSequence(batch,cache.raw,cache.ids,{final:false});errors.push(...sequence.map(error=>({...error,kind:"sequence"})));
    const bad=new Set(sequence.map(error=>error.line));const accepted=batch.filter(item=>!bad.has(item.line)).map(item=>item.event);
    for(const event of accepted)cache.ids.add(event.id);
    cache.raw=reduceEvents(accepted,errors,cache.raw,{retainWorkTargets:true});batch=[];
  };
  try {
    while(position<stat.size) {
      const buffer=Buffer.allocUnsafe(Math.min(256*1024,stat.size-position));const read=fs.readSync(descriptor,buffer,0,buffer.length,position);if(!read)break;position+=read;
      const content=Buffer.concat([remainder,buffer.subarray(0,read)]);let start=0;let end;
      while((end=content.indexOf(10,start))>=0) {
        const line=content.subarray(start,end).toString("utf8").replace(/\r$/,"");start=end+1;cache.lines++;
        if(!line.trim())continue;
        try {
          const event=JSON.parse(line);const invalid=validateEvent(event);
          if(invalid.length)errors.push(...invalid.map(message=>({line:cache.lines,id:event.id,kind:"schema",message})));
          else batch.push({event,line:cache.lines});
        }catch(error){errors.push({line:cache.lines,kind:"parse",message:error.message});}
        if(batch.length>=1000)flush();
      }
      remainder=Buffer.from(content.subarray(start));
    }
    if(remainder.length) {
      cache.lines++;
      try {const event=JSON.parse(remainder.toString("utf8"));const invalid=validateEvent(event);if(invalid.length)errors.push(...invalid.map(message=>({line:cache.lines,kind:"schema",message})));else batch.push({event,line:cache.lines});}
      catch(error){errors.push({line:cache.lines,kind:"parse",message:error.message});}
    }
    flush();
    errors.push(...validateEventSequence([],cache.raw,null).map(error=>({...error,kind:"sequence"})));
    cache.raw=reduceEvents([],errors,cache.raw,{retainWorkTargets:true});cache.offset=position;cache.signature=currentSignature;cache.edgeHash=edgeHash(position);cache.value=publicValue(cache.raw);
    persist();return cache;
  }finally{fs.closeSync(descriptor);}
}
export function cacheAppended(events) {
  if(!cache)return;
  cache.raw=reduceEvents(events,[],cache.raw,{retainWorkTargets:true});for(const event of events)cache.ids.add(event.id);
  const stat=fs.statSync(file);cache.offset=stat.size;cache.lines+=events.length;cache.signature=signature(stat);cache.edgeHash=edgeHash(cache.offset);cache.value=publicValue(cache.raw);
  persist();
}
export function cachedSnapshot() {
  if(!cache)return null;
  const stat=fs.statSync(file);return cache.signature===signature(stat)?cache.value:null;
}
