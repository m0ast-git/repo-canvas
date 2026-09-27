import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { setImmediate as yieldIO } from "node:timers/promises";
import { replaceFileSync } from "./atomic-file.mjs";
import { resolveDataDirectory } from "./project-root.mjs";
import { readAppendedRecords, pathBelongsToRoot, listCodexSessionFiles } from "./codex-sessions.mjs";
import { sessionAdapters } from "./session-adapters.mjs";
import { sourceLanguage, sourceSymbols, resolveSourceSymbol } from "./source-syntax.mjs";

const digest = value => crypto.createHash("sha256").update(value).digest("hex");
const excluded = /(^|\/)(node_modules|\.git|\.repo-canvas)(\/|$)|^(output|dist|coverage|vendor)(\/|$)|(^|\/)(\.env(?:\..*)?|.*\.(?:pem|key|p12|pfx)|auth\.json|secrets?\.json|credentials[^/]*)$/i;
export function writeSourceJson(file, value) {
  fs.mkdirSync(path.dirname(file), {recursive:true});
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try { fs.writeFileSync(temporary, JSON.stringify(value), {mode:0o600}); replaceFileSync(temporary, file, {rename:fs.renameSync}); }
  finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
export function readSourceJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch(error) { if (error.code === "ENOENT") return fallback; throw new Error(`Не удалось прочитать ${path.basename(file)}: ${error.message}`); }
}
export function redactSource(text) {
  return String(text || "").replace(/\b(?:sk-[\w-]{15,}|gh[pousr]_[\w]{15,}|eyJ[\w-]+\.[\w-]+\.[\w-]+)\b/g, "[скрыто]")
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|authorization)\s*[=:]\s*["']?)[^\s"',}]+/gi, "$1[скрыто]");
}
export function repositoryFiles(root) {
  let files;
  try { files = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], {cwd:root,encoding:"utf8",windowsHide:true,timeout:5000,maxBuffer:8*1024*1024,stdio:["ignore","pipe","ignore"]}).split("\0"); }
  catch {
    files=[]; const pending=[root];
    while(pending.length) for(const entry of fs.readdirSync(pending.pop(), {withFileTypes:true})) {
      const absolute=path.join(entry.parentPath || entry.path, entry.name); const relative=path.relative(root,absolute).replaceAll("\\","/");
      if(excluded.test(relative) || entry.isSymbolicLink()) continue;
      if(entry.isDirectory()) pending.push(absolute); else if(entry.isFile()) files.push(relative);
    }
  }
  return [...new Set(files)].filter(file=>file && !excluded.test(file.replaceAll("\\","/")) && fs.existsSync(path.join(root,file)) && pathBelongsToRoot(path.join(root,file),root)).sort();
}
export function readCodeSource(root, reference, {maxChars=18000}={}) {
  const raw=String(reference || "").replaceAll("\\","/").replace(/^\.\//,"");
  const match=raw.match(/^(.*?)(?:(?:#|::)([^#]+)|:(\d+)(?:[-:](\d+))?)?$/);
  const relative=match?.[1] || raw; const absolute=path.resolve(root,relative);
  if(excluded.test(relative) || !pathBelongsToRoot(absolute,root)) return {reference, error:"Источник находится за пределами разрешённого проекта"};
  if(!fs.existsSync(absolute)) return {reference,error:"Источник отсутствует"};
  const stat=fs.statSync(absolute);
  if(stat.isDirectory()) return {reference, path:relative, directory:true, entries:fs.readdirSync(absolute).slice(0,200), hash:null};
  if(stat.size>4*1024*1024) return {reference,error:"Большой файл требует точечного чтения"};
  const buffer=fs.readFileSync(absolute);
  if(buffer.includes(0)) return {reference,error:"Двоичный источник"};
  return codeExcerpt(reference,buffer,{maxChars});
}
export function codeExcerpt(reference,buffer,{maxChars=18000}={}) {
  const raw=String(reference||"").replaceAll("\\","/").replace(/^\.\//,"");
  const match=raw.match(/^(.*?)(?:(?:#|::)([^#]+)|:(\d+)(?:[-:](\d+))?)?$/);const relative=match?.[1]||raw;
  const content=buffer.toString("utf8"); const lines=content.split(/\r?\n/); const symbol=match?.[2];
  let first=Number(match?.[3] || 1); let last=Number(match?.[4] || (match?.[3] ? first+35 : lines.length));
  if(first<1 || first>lines.length || match?.[4] && (last<first || last>lines.length)) return {reference,error:"Указанные строки отсутствуют"};
  if(symbol) {
    const resolved=resolveSourceSymbol(relative,content,symbol);
    if(resolved.error)return {reference,error:resolved.error};
    first=resolved.line;last=resolved.endLine;
  }
  const excerpt=lines.slice(first-1,last).map((line,index)=>`${first+index}: ${line}`).join("\n");
  const truncated=excerpt.length>maxChars;
  const visible=truncated?excerpt.slice(0,Math.floor(maxChars*.65))+"\n[Средняя часть пропущена; запросите точный диапазон строк]\n"+excerpt.slice(-Math.floor(maxChars*.35)):excerpt;
  return {reference,path:relative,hash:digest(buffer),first,last:Math.min(last,lines.length),totalLines:lines.length,text:redactSource(visible),truncated};
}

function fullText(content) {
  if(typeof content==="string") return content;
  return Array.isArray(content) ? content.filter(part=>["text","input_text","output_text"].includes(part?.type)).map(part=>part.text||"").join("\n") : "";
}
export function publicSourceMessages(provider, record) {
  const p=record?.payload || {};
  if(provider==="codex") {
    if(record.type==="event_msg" && ["user_message","agent_message"].includes(p.type) && p.phase!=="analysis") return [{author:p.type==="user_message"?"user":"agent",text:fullText(p.message),at:record.timestamp}];
    if(record.type==="response_item" && p.type==="message" && ["user","assistant"].includes(p.role) && (!p.channel || ["final","commentary"].includes(p.channel))) return [{author:p.role==="user"?"user":"agent",text:fullText(p.content),at:record.timestamp}];
    if(record.type==="response_item" && ["function_call_output","custom_tool_call_output"].includes(p.type)) return [{author:"tool",text:typeof p.output==="string"?p.output:JSON.stringify(p.output||""),at:record.timestamp}];
  }
  if(provider==="claude" && ["user","assistant"].includes(record.type)) return [{author:record.type==="user"?"user":"agent",text:fullText(record.message?.content),at:record.timestamp}];
  if(provider==="kimi") {
    if(record.type==="turn.prompt") return [{author:"user",text:fullText(record.input),at:record.time}];
    if(record.type==="context.append_loop_event" && record.event?.type==="content.part" && record.event.part?.type==="text") return [{author:"agent",text:record.event.part.text,at:record.time}];
  }
  return [];
}
async function prefixHash(file,length) {
  const hash=crypto.createHash("sha256");
  if(length>0) for await(const chunk of fs.createReadStream(file,{start:0,end:length-1})) hash.update(chunk);
  return hash.digest("hex");
}
export function sourceIndexFile(root) {return path.join(resolveDataDirectory(root),"sources","index.json");}
const indexJobs=new Map();
export async function indexProjectDialogs(root,options={}) {
  const key=path.resolve(root);const previous=indexJobs.get(key)||Promise.resolve();
  const operation=previous.catch(()=>{}).then(()=>indexProjectDialogsUnlocked(root,options));indexJobs.set(key,operation);
  try{return await operation;}finally{if(indexJobs.get(key)===operation)indexJobs.delete(key);}
}
async function indexProjectDialogsUnlocked(root, {providers=["codex","claude","kimi"],enabled=true,excludeFiles=[],projectAliases=[],adapters=sessionAdapters(providers),includeArchives=true,onlyFiles=null,onProgress,signal}={}) {
  const indexFile=sourceIndexFile(root);
  const index=readSourceJson(indexFile,{version:1,files:{},records:[]});
  if(!enabled) return {version:1,files:{},records:[],coverage:{enabled:false,sessions:0,messages:0,gaps:[]},newIds:[]};
  const known=new Set(index.records.map(row=>row.id));const invalidated=[];const gaps=[];const cache=new Map();
  const found=new Set(onlyFiles?Object.keys(index.files).filter(file=>fs.existsSync(file)&&providers.includes(index.files[file].provider)&&!excludeFiles.some(excludedFile=>path.resolve(excludedFile)===path.resolve(file))):[]);let changed=false;let bytesRead=0;
  const dedup=new Map(index.records.map(row=>[row.id,row]));
  for(const adapter of adapters) {
    let files=onlyFiles||adapter.listFiles();
    if(!onlyFiles && includeArchives && adapter.id==="codex" && !process.env.REPO_CANVAS_CODEX_SESSIONS) files=[...files,...listCodexSessionFiles(path.join(os.homedir(),".codex","archived_sessions"))];
    let scanned=0;
    for(const file of new Set(files)) {
      if(scanned++%40===0){onProgress?.({phase:"knowledge",eventType:"source.progress",detail:`Проверяем диалоги: ${scanned} из ${files.length}. Найдено сессий проекта: ${found.size}.`});await yieldIO();}
      if(signal?.aborted) throw new Error("Чтение источников отменено");
      if(excludeFiles.some(excludedFile=>path.resolve(excludedFile)===path.resolve(file))) continue;
      let meta;
      try { const stat=fs.statSync(file);meta=index.files[file]?.mtime===stat.mtimeMs?index.files[file].meta:adapter.readMeta(file); } catch { gaps.push({file:path.basename(file),reason:"Повреждены метаданные сессии"});continue; }
      if(!adapter.belongsToRepository(meta,root,cache) && !projectAliases.some(alias=>adapter.belongsToRepository(meta,alias,cache))) continue;
      found.add(file);
      const stat=fs.statSync(file);let entry=index.files[file];
      if(entry && entry.size===stat.size && entry.mtime===stat.mtimeMs) continue;
      if(entry && (stat.size<entry.offset || await prefixHash(file,entry.offset)!==entry.hash)) {
        invalidated.push(...index.records.filter(row=>row.file===file).map(row=>row.id));
        index.records=index.records.filter(row=>row.file!==file);entry=null;
        dedup.clear();for(const row of index.records) dedup.set(row.id,row);
      }
      entry ||= {meta,provider:adapter.id,offset:0,turnId:""};
      while(entry.offset<stat.size) {
        const delta=readAppendedRecords(file,entry.offset,{maxRecordBytes:1024*1024,discardingOversizedRecord:entry.discardingOversizedRecord});bytesRead+=delta.bytesRead;
        if(delta.offset===entry.offset) {gaps.push({file:path.basename(file),reason:"Незавершённая последняя запись"});break;}
        for(let recordIndex=0;recordIndex<delta.records.length;recordIndex++) {
          const record=delta.records[recordIndex];
          for(const signal of adapter.signals(record)) if(signal.kind==="start") entry.turnId=signal.turnId || entry.turnId;
          const messages=publicSourceMessages(adapter.id,record);
          for(let messageIndex=0;messageIndex<messages.length;messageIndex++) {
            const message=messages[messageIndex];if(!message.text.trim()) continue;
            const id="dialog:"+digest(`${adapter.id}|${message.author}|${entry.turnId || message.at || meta.id}|${message.text}`).slice(0,28);
            const duplicate=dedup.get(id);
            if(duplicate && fs.existsSync(duplicate.file)) continue;
            if(duplicate) index.records=index.records.filter(row=>row!==duplicate);
            const location=delta.locations[recordIndex];
            index.records.push({id,file,start:location.start,end:location.end,messageIndex,provider:adapter.id,sessionId:meta.id,turnId:entry.turnId,author:message.author,at:message.at||record.timestamp||null,preview:redactSource(message.text.slice(0,300))});
            dedup.set(id,index.records.at(-1));
          }
        }
        entry.offset=delta.offset;entry.discardingOversizedRecord=delta.discardingOversizedRecord;
        if(delta.skippedOversizedRecords) gaps.push({file:path.basename(file),reason:`Больших записей пропущено: ${delta.skippedOversizedRecords}`});
        await yieldIO();
      }
      entry.hash=await prefixHash(file,entry.offset);entry.size=stat.size;entry.mtime=stat.mtimeMs;index.files[file]=entry;changed=true;
      onProgress?.({phase:"sources",detail:`Изучено сессий: ${found.size}; сообщений: ${index.records.length}`});
      await yieldIO();
    }
  }
  const available=index.records.filter(row=>found.has(row.file));
  for(const row of index.records) if(!found.has(row.file)) invalidated.push(row.id);
  index.records=available;
  for(const file of Object.keys(index.files)) if(!found.has(file))delete index.files[file];
  const coverage={enabled:true,sessions:found.size,messages:available.length,gaps,bytesRead};
  if(changed || invalidated.length) writeSourceJson(indexFile,{...index,coverage,updatedAt:new Date().toISOString()});
  return {...index,coverage,invalidated,newIds:available.filter(row=>!known.has(row.id)).map(row=>row.id)};
}
export function readDialogSource(root,id,index=readSourceJson(sourceIndexFile(root),{records:[]})) {
  const row=index.records.find(item=>item.id===id);if(!row) throw new Error("Источник не найден в этом проекте");
  const policy=readSourceJson(path.join(resolveDataDirectory(root),"runtime.json"),{});
  if(policy.dialogSources===false || policy.providers?.length&&!policy.providers.includes(row.provider) || (policy.excludedSourceFiles||[]).some(file=>path.resolve(file)===path.resolve(row.file))) throw new Error("Доступ к этому источнику отключён в настройках проекта");
  const buffer=Buffer.alloc(row.end-row.start);const file=fs.openSync(row.file,"r");
  try {fs.readSync(file,buffer,0,buffer.length,row.start);} finally {fs.closeSync(file);}
  const message=publicSourceMessages(row.provider,JSON.parse(buffer.toString("utf8")))[row.messageIndex];
  if(!message) throw new Error("Исходное сообщение изменилось; обновите индекс");
  const expected="dialog:"+digest(`${row.provider}|${message.author}|${row.turnId || message.at || row.sessionId}|${message.text}`).slice(0,28);
  if(expected!==id) throw new Error("Исходное сообщение изменилось; обновите индекс");
  return {...row,file:path.basename(row.file),text:redactSource(message.text)};
}
export function codeState(root) {
  const git=args=>{try{return execFileSync("git",args,{cwd:root,encoding:"utf8",windowsHide:true,timeout:5000,maxBuffer:4*1024*1024,stdio:["ignore","pipe","ignore"]}).trim();}catch{return "";}};
  return {commit:git(["rev-parse","HEAD"]),branch:git(["branch","--show-current"]),dirty:git(["status","--porcelain"]),observedAt:new Date().toISOString()};
}

export function sourceInventory(root) {
  return repositoryFiles(root).map(file=>{
    const stat=fs.statSync(path.join(root,file));let symbols=[];
    if(stat.isFile() && stat.size<1024*1024 && sourceLanguage(file)) {
      const content=fs.readFileSync(path.join(root,file),"utf8");
      if(!content.includes("\0"))symbols=sourceSymbols(file,content).filter(symbol=>symbol.inventory).slice(0,160).map(({name,line})=>({name,line}));
    }
    return {path:file,size:stat.size,symbols};
  });
}
export function sourcePackage(root,references,{maxChars=180_000,recoverRanges=false,compact=false,expandWholeFiles=true,maxSourceChars=180_000}={}) {
  const sources=[];let used=0;const omitted=[];const completeFiles=new Map();
  const fileOf=reference=>String(reference).split(/#|::|:\d/)[0];const counts=new Map();for(const reference of new Set(references)){const file=fileOf(reference);counts.set(file,(counts.get(file)||0)+1);}
  for(const reference of [...new Set(references)]) {
    const file=fileOf(reference);
    if(compact && expandWholeFiles && !completeFiles.has(file) && counts.get(file)>1){const whole=readCodeSource(root,file,{maxChars:Math.min(maxSourceChars,maxChars-used)});if(whole.text&&!whole.truncated&&used+whole.text.length<=maxChars){sources.push(whole);used+=whole.text.length;completeFiles.set(file,whole);}else completeFiles.set(file,null);}
    if(completeFiles.get(file)) {if(reference!==file){const alias=readCodeSource(root,reference);sources.push({...alias,text:undefined,coveredBy:file});}continue;}
    let source=readCodeSource(root,reference,{maxChars:Math.max(256,Math.min(maxSourceChars,compact?180_000:36_000,maxChars-used))});
    if(recoverRanges&&source.error&&/:\d+(?:[-:]\d+)?$/.test(reference)) {const file=reference.replace(/:\d+(?:[-:]\d+)?$/,"");const fallback=readCodeSource(root,file,{maxChars:Math.min(36_000,maxChars-used)});if(fallback.text)source={...fallback,requestedReference:reference,rangeAdjusted:true};}
    const covered=compact&&sources.find(other=>other.text&&!other.truncated&&other.path===source.path&&other.first<=source.first&&other.last>=source.last);
    if(covered)source={...source,text:undefined,coveredBy:covered.reference};
    if(used>=maxChars&&!covered){omitted.push(reference);continue;}
    sources.push(source);used+=source.text?.length||0;
  }
  return {sources,omitted,chars:used};
}
