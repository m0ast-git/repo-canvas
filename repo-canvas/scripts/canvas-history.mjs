import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {gzipSync,gunzipSync} from "node:zlib";
import { setImmediate as yieldIO } from "node:timers/promises";
import { dataDirectory, eventsFile, getSnapshot, appendEvent, createEvent, projectRoot } from "./canvas-store.mjs";
import { commitHistory, findCommit, refreshGitHistory } from "./git-history.mjs";
import { readReconstruction } from "./history-reconstruction.mjs";
import { readAppendedRecords } from "./codex-sessions.mjs";
import { reduceEvents } from "./snapshot-reducer.mjs";
import { readSourceJson, writeSourceJson } from "./project-sources.mjs";

const directory=path.join(dataDirectory,"history");
const indexFile=path.join(directory,"index.json");
const snapshots=path.join(directory,"snapshots");
const geometryDirectory=path.join(directory,"geometry");
const geometryBlobs=path.join(directory,"geometry-blobs");
const geometryCache=new Map();
const commentsFile=path.join(directory,"comments.json");
let cached=null;let indexing=null;const views=new Map();
function safeId(id) {if(!/^cp-[A-Za-z0-9._-]{1,180}$/.test(String(id)))throw new Error("Некорректный чекпоинт");return id;}
function snapshotFile(id) {return path.join(snapshots,`${safeId(id)}.json`);}
function readSnapshot(id) {
  const file=snapshotFile(id);
  if(fs.existsSync(file+".gz"))return JSON.parse(gunzipSync(fs.readFileSync(file+".gz")));
  return readSourceJson(file,null);
}
function writeSnapshot(id,value) {
  const {_rawWork,...compact}=value;
  if(_rawWork)compact.work=_rawWork;
  fs.mkdirSync(snapshots,{recursive:true});
  const file=snapshotFile(id)+".gz";const temporary=`${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary,gzipSync(JSON.stringify(compact)),{mode:0o600});fs.renameSync(temporary,file);
}

export function compactHistoryCache({apply=false}={}) {
  const files=fs.existsSync(snapshots)?fs.readdirSync(snapshots).filter(file=>/^cp-[A-Za-z0-9._-]+\.json$/.test(file)):[];
  let beforeBytes=0,afterBytes=0;
  for(const file of files) {
    const full=path.join(snapshots,file);const bytes=fs.readFileSync(full);const value=JSON.parse(bytes);
    const {_rawWork,...compact}=value;if(_rawWork)compact.work=_rawWork;
    const compressed=gzipSync(JSON.stringify(compact));beforeBytes+=bytes.length;afterBytes+=compressed.length;
    if(apply) {
      const output=full+".gz";const temporary=output+`.${process.pid}.tmp`;
      fs.writeFileSync(temporary,compressed,{mode:0o600});
      const restored=JSON.parse(gunzipSync(fs.readFileSync(temporary)));
      const before=reduceEvents([],[],value,{retainWorkTargets:true}),after=reduceEvents([],[],restored,{retainWorkTargets:true});
      if(JSON.stringify(before)!==JSON.stringify(after)){fs.unlinkSync(temporary);throw new Error("Снимок не прошёл проверку обратимости сжатия");}
      fs.renameSync(temporary,output);fs.unlinkSync(full);
    }
  }
  return {applied:apply,files:files.length,beforeBytes,afterBytes,journalUnchanged:true,geometryUnchanged:true};
}
function geometryFile(id) {return path.join(geometryDirectory,`${safeId(id)}.json`);}
function geometryRecord(id) {
  const record=readSourceJson(geometryFile(id),null);if(!record)return null;
  if(record.geometry)return record;
  if(!/^[a-f0-9]{64}$/.test(record.blob||""))return null;
  let geometry=geometryCache.get(record.blob);
  if(!geometry) {geometry=readSourceJson(path.join(geometryBlobs,`${record.blob}.json`),null);if(!geometry)return null;geometryCache.set(record.blob,geometry);while(geometryCache.size>4)geometryCache.delete(geometryCache.keys().next().value);}
  return {...record,geometry};
}
function titleFor(event,metadata) {
  if(metadata.title)return metadata.title;
  if(event.payload.ownerCorrection)return event.payload.ownerCorrection.instruction.slice(0,120);
  if(metadata.kind==="session")return event.payload.title || "Граница сессии";
  if(event.type==="map.upsert")return "Описание проекта обновлено";
  if(event.type.startsWith("entity."))return event.payload.ownerLabel || event.payload.label || "Изменение элемента";
  if(event.type.startsWith("area."))return event.payload.ownerTitle || event.payload.title || "Изменение области";
  if(event.type.startsWith("relation."))return event.payload.ownerLabel || event.payload.label || "Изменение связи";
  return event.payload.message || "Изменение карты";
}
function readRange(start,end) {
  if(end<=start)return [];
  const bytes=Buffer.alloc(end-start);const descriptor=fs.openSync(eventsFile,"r");
  try{fs.readSync(descriptor,bytes,0,bytes.length,start);}finally{fs.closeSync(descriptor);}
  return bytes.toString("utf8").split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line));
}
async function updateIndex() {
  fs.mkdirSync(directory,{recursive:true});
  if(!fs.existsSync(eventsFile))getSnapshot();
  const stat=fs.statSync(eventsFile);
  if(!cached) {
    let stored;try{stored=readSourceJson(indexFile,null);}catch{stored=null;}
    const reusable=stored?.version===1 && stored.offset<=stat.size && stored.inode===stat.ino;
    const index=reusable?stored:{version:1,offset:0,revision:0,checkpoints:[],inode:stat.ino,baseId:null,baseOffset:0};
    let state=index.baseId?readSnapshot(index.baseId):null;
    if(index.baseId&&!state) {index.offset=0;index.revision=0;index.checkpoints=[];index.baseId=null;index.baseOffset=0;}
    cached={index,state,pending:index.offset>index.baseOffset?readRange(index.baseOffset,index.offset):[],size:index.offset,mtime:index.mtime};
  }
  if(stat.size<cached.index.offset || stat.ino!==cached.index.inode || stat.size===cached.size && stat.mtimeMs!==cached.mtime) {cached=null;views.clear();if(fs.existsSync(indexFile))fs.unlinkSync(indexFile);return updateIndex();}
  if(stat.size===cached.size && stat.mtimeMs===cached.mtime)return cached.index;
  const {index}=cached;
  while(index.offset<stat.size) {
    const delta=readAppendedRecords(eventsFile,index.offset,{maxBytes:4*1024*1024,maxRecordBytes:2*1024*1024,maxRecords:2000});
    if(delta.offset===index.offset)break;
    const batches=delta.records.map(event=>event.payload?._checkpoint).filter(Boolean);
    for(let i=0;i<delta.records.length;i++) {
      const event=delta.records[i];index.revision++;cached.pending.push(event);
      const metadata=event.payload?._checkpoint;
      // Legacy records have recoverable data, but no trustworthy original transaction/layout boundary.
      index.hasRecorded ||= Boolean(metadata) || index.checkpoints.at(-1)?.reconstructed===false;
      const covered=!index.hasRecorded && batches.some(batch=>batch.firstRevision<=index.revision && batch.revision>=index.revision);
      const legacy=!metadata && event.type!=="activity.log" && !index.hasRecorded && !covered;
      if(metadata || legacy) {
        if(metadata?.firstRevision && index.checkpoints.at(-1)?.reconstructed) index.checkpoints=index.checkpoints.filter(point=>!point.reconstructed || point.revision<metadata.firstRevision);
        const marker=metadata || {id:"cp-"+event.id,revision:index.revision,kind:"map",recordedAt:event.ts};
        const checkpoint={...marker,id:"cp-"+event.id,revision:index.revision,number:index.checkpoints.length+1,at:marker.eventAt||event.ts,recordedAt:event.ts,title:titleFor(event,marker),actor:event.actor,offset:delta.locations[i].end+1,baseId:index.baseId,baseOffset:index.baseOffset,reconstructed:legacy,branch:marker.branch||index.checkpoints.at(-1)?.branch||"",sessionId:marker.sessionId||event.payload.session?.id||null,commit:marker.commit||null};
        if(index.checkpoints.length%100===0) {
          cached.state=reduceEvents(cached.pending,[],cached.state,{retainWorkTargets:true});cached.pending=[];
          writeSnapshot(checkpoint.id,cached.state);
          index.baseId=checkpoint.id;index.baseOffset=checkpoint.offset;checkpoint.baseId=checkpoint.id;checkpoint.baseOffset=checkpoint.offset;
        }
        index.checkpoints.push(checkpoint);
      }
    }
    index.offset=delta.offset;await yieldIO();
  }
  const finished=fs.statSync(eventsFile);
  index.mtime=finished.mtimeMs;cached.size=index.offset;cached.mtime=finished.mtimeMs;
  writeSourceJson(indexFile,index);return index;
}
export async function historyIndex() {
  if(indexing)return indexing;
  indexing=updateIndex();try{return await indexing;}finally{indexing=null;}
}
export function historyChapters(points) {
  const chapters=new Map();
  for(const point of points) {
    const day=(point.at||"").slice(0,10);
    const work=point.kind==="session"||point.workId;
    const explicit=["manual","commit"].includes(point.kind)||!work&&point.actor!=="owner"&&point.firstRevision<point.revision;
    const key=work?`${day}:session:${point.workId||point.sessionId||point.actor}`:explicit?`point:${point.id}`:`${day}:${point.kind}:${point.actor}`;
    const previous=chapters.get(key);
    const title=previous&&!work?({map:point.actor==="owner"?"Правки владельца":"Изменения карты",activity:"События наблюдения",decision:"Решения проекта"}[point.kind]||point.title):point.title;
    chapters.set(key,{...point,title,chapterId:key,chapterStart:previous?.chapterStart||point.id,chapterAt:previous?.chapterAt||point.at,checkpointCount:(previous?.checkpointCount||0)+1});
  }
  return [...chapters.values()].sort((a,b)=>a.revision-b.revision);
}
export async function historyPage({before,limit=1000,kind="all",branch="",query="",view="all",chapter=""}={}) {
  const index=await historyIndex();
  let points=index.checkpoints;
  if(kind==="commit") {const commits=await commitHistory(projectRoot,branch);const recorded=new Map(index.checkpoints.filter(point=>point.kind==="commit").map(point=>[point.commit,point.id]));points=commits.map((commit,indexNumber)=>({...commit,number:indexNumber+1,checkpointId:recorded.get(commit.commit)||null}));}
  else if(kind!=="all")points=points.filter(point=>point.kind===kind);
  if(branch && kind!=="commit")points=points.filter(point=>point.branch===branch);
  if(query) {const exact=query.trim().match(/^#?(\d+)$/);points=exact?points.filter(point=>point.number===Number(exact[1])):points.filter(point=>[point.id,point.title,point.commit,point.sessionId,String(point.number),point.at].some(value=>String(value||"").toLowerCase().includes(query.toLowerCase())));}
  const exactTotal=points.length;
  if(chapter) {const selected=historyChapters(points).find(item=>item.chapterId===chapter);points=selected?points.filter(point=>point.revision>=(points.find(item=>item.id===selected.chapterStart)?.revision||0)&&point.revision<=selected.revision&&historyChapters([point])[0].chapterId===chapter):[];}
  else if(view==="chapters"&&kind!=="commit")points=historyChapters(points);
  const all=points.length;
  if(before) {const end=points.findIndex(point=>point.id===before);if(end>=0)points=points.slice(0,end);}
  const size=Math.max(1,Math.min(20000,Number(limit)||1000));
  return {checkpoints:points.slice(-size),total:all,exactTotal,view:chapter?"chapter":view,hidden:Math.max(0,index.checkpoints.length-all),head:index.checkpoints.at(-1)?.id||null,hasEarlier:points.length>size,branches:[...new Set([...index.checkpoints.map(point=>point.branch).filter(Boolean),...Object.keys((await refreshGitHistory(projectRoot)).branches)])]};
}
export async function stateAtCheckpoint(id) {
  if(String(id).startsWith("git-")) {
    const restored=readReconstruction(id);if(restored)return restored;
    const commit=await findCommit(projectRoot,id);if(!commit)throw new Error("Коммит не найден");
    const index=await historyIndex();const point=index.checkpoints.find(item=>item.kind==="commit"&&item.commit===commit.commit);
    if(point)return stateAtCheckpoint(point.id);
    return {...reduceEvents([]),_history:{...commit,readOnly:true,unavailable:true,geometry:"unavailable"}};
  }
  safeId(id);const index=await historyIndex();const point=index.checkpoints.find(item=>item.id===id);if(!point)throw new Error("Чекпоинт не найден");
  let state=views.get(id);
  if(!state) {
    const base=point.baseId?readSnapshot(point.baseId):null;
    state=reduceEvents(readRange(point.baseOffset||0,point.offset),[],base,{retainWorkTargets:true});
    if(state.revision!==point.revision)throw new Error("История изменилась; требуется переиндексация");
    views.set(id,state);while(views.size>8)views.delete(views.keys().next().value);
  }
  const geometry=geometryRecord(id);const {_rawWork,...publicState}=state;
  return {...publicState,_history:{...point,geometry:geometry?"recorded":"reconstructed",readOnly:true},...(geometry?{_geometry:geometry.geometry}:{})};
}
export async function currentHistoryState(snapshot=getSnapshot()) {
  const index=await historyIndex();const head=index.checkpoints.at(-1);
  if(!head)return {...snapshot,_historyHead:null};
  const geometry=geometryRecord(head.id);
  const seedId=[...index.checkpoints].reverse().find(point=>point.geometryCaptured)?.id;
  const seed=!geometry&&seedId?geometryRecord(seedId):null;
  return {...snapshot,_historyHead:{...head,phase:geometry?"ready":"preparing"},...(geometry && geometry.revision===snapshot.revision?{_geometry:geometry.geometry}:seed?{_layoutSeed:seed.geometry}:{})};
}
export async function saveCheckpointGeometry(id,revision,geometry) {
  safeId(id);const index=await historyIndex();const point=index.checkpoints.find(item=>item.id===id);
  if(!point || point.revision!==revision || getSnapshot().revision!==revision) return {saved:false,reason:"revision-changed"};
  const file=geometryFile(id);if(fs.existsSync(file))return {saved:false,reason:"already-recorded"};
  if(!geometry || !Array.isArray(geometry.areas) || !Array.isArray(geometry.entities) || !Array.isArray(geometry.routes))throw new Error("Неполные координаты карты");
  if(geometry.format>=2&&geometry.routes.some(route=>!route.finalGeometry||!Array.isArray(route.points)||route.points.length<2||route.points.some(point=>!Number.isFinite(point.x)||!Number.isFinite(point.y))))throw new Error("Окончательные маршруты ещё не готовы");
  const snapshot=getSnapshot();
  for(const kind of ["areas","entities"]) {const ids=new Set(snapshot[kind].map(item=>item.id));const seen=new Set();for(const item of geometry[kind]){if(!ids.has(item.id)||seen.has(item.id)||![item.x,item.y,item.width,item.height].every(Number.isFinite)||item.width<=0||item.height<=0)throw new Error("Некорректные координаты чекпоинта");seen.add(item.id);}}
  if(geometry.areas.length!==snapshot.areas.length || geometry.entities.length!==snapshot.entities.length)throw new Error("В координатах отсутствуют элементы карты");
  const blob=crypto.createHash("sha256").update(JSON.stringify(geometry)).digest("hex");const contentFile=path.join(geometryBlobs,`${blob}.json`);
  if(!fs.existsSync(contentFile))writeSourceJson(contentFile,geometry);
  writeSourceJson(file,{version:2,id,revision,capturedAt:new Date().toISOString(),blob});point.geometryCaptured=true;writeSourceJson(indexFile,index);return {saved:true};
}
export async function createCheckpoint(title) {
  title=String(title||"").trim();if(!title || title.length>240)throw new Error("Название отметки: от 1 до 240 символов");
  appendEvent(createEvent("activity.log",{actor:"owner",payload:{message:title,checkpoint:{kind:"manual",title}}}));
  const index=await historyIndex();return index.checkpoints.at(-1);
}
export async function addHistoryComment(checkpointId,text) {
  safeId(checkpointId);const index=await historyIndex();if(!index.checkpoints.some(point=>point.id===checkpointId))throw new Error("Чекпоинт не найден");
  text=String(text||"").trim();if(!text || text.length>4000)throw new Error("Комментарий: от 1 до 4000 символов");
  const comments=readSourceJson(commentsFile,[]);const comment={id:crypto.randomUUID(),checkpointId,text,actor:"owner",at:new Date().toISOString()};comments.push(comment);writeSourceJson(commentsFile,comments);return comment;
}
export function historyComments(id) {return readSourceJson(commentsFile,[]).filter(comment=>comment.checkpointId===id);}
export function compareSnapshots(before,after) {
  const result={added:[],changed:[],removed:[]};
  const plain=({actor,updatedAt,_checkpoint,...item})=>item;
  for(const kind of ["areas","entities","relations"]) {
    const old=new Map(before[kind].map(item=>[item.id,item]));const current=new Map(after[kind].map(item=>[item.id,item]));
    for(const [id,item] of current) {if(!old.has(id))result.added.push({kind,id,label:item.ownerLabel||item.label||item.ownerTitle||item.title||id});else if(JSON.stringify(plain(old.get(id)))!==JSON.stringify(plain(item)))result.changed.push({kind,id,label:item.ownerLabel||item.label||item.ownerTitle||item.title||id});}
    for(const [id,item] of old)if(!current.has(id))result.removed.push({kind,id,label:item.ownerLabel||item.label||item.ownerTitle||item.title||id,item});
  }
  return result;
}
