import path from "node:path";
import { execFile } from "node:child_process";
import { dataDirectory, getSnapshot, appendEvent, createEvent } from "./canvas-store.mjs";
import { readSourceJson, writeSourceJson, codeExcerpt } from "./project-sources.mjs";

const processes=new Set();
const execute=(command,args,options)=>new Promise((resolve,reject)=>{const child=execFile(command,args,options,(error,stdout,stderr)=>error?reject(error):resolve({stdout,stderr}));processes.add(child);child.once("close",()=>processes.delete(child));});
export function stopGitProcesses(){for(const child of processes)child.kill();}
const file=path.join(dataDirectory,"history","git.json");let loaded=null;let refreshing=null;
async function git(root,args) {try{return (await execute("git",args,{cwd:root,encoding:"utf8",windowsHide:true,timeout:10000,maxBuffer:16*1024*1024,env:{...process.env,GIT_OPTIONAL_LOCKS:"0",GIT_PAGER:""}})).stdout;}catch{return "";}}
export async function gitHead(root) {
  const result=await git(root,["log","-1","--format=%H%x00%P%x00%cI%x00%s"]);
  if(!result.trim())return null;
  const [commit,parents,at,title]=result.trim().split("\0");const branch=(await git(root,["branch","--show-current"])).trim();
  return {commit,parents:parents.split(" ").filter(Boolean),at,title,branch};
}
export async function refreshGitHistory(root) {
  if(refreshing)return refreshing;
  refreshing=(async()=>{
    const refs=(await git(root,["for-each-ref","--format=%(refname:short)%00%(objectname)","refs/heads"])).trim();
    loaded ||= readSourceJson(file,{commits:[],branches:{},refs:""});
    if(loaded.refs===refs && loaded.version===1)return loaded;
    const branches=Object.fromEntries(refs.split("\n").filter(Boolean).map(line=>line.split("\0")));
    const commits=[];
    for(let skip=0;;skip+=5000) {
      const text=await git(root,["log","--all","--topo-order",`--skip=${skip}`,"--max-count=5000","--format=%H%x00%P%x00%cI%x00%s"]);
      const rows=text.trim().split("\n").filter(Boolean);
      for(const row of rows){const [commit,parents,at,title]=row.split("\0");commits.push({id:"git-"+commit,commit,parents:parents.split(" ").filter(Boolean),at,title,kind:"commit"});}
      if(rows.length<5000)break;
    }
    loaded={version:1,refs,branches,commits:commits.reverse(),updatedAt:new Date().toISOString()};writeSourceJson(file,loaded);return loaded;
  })();
  try{return await refreshing;}finally{refreshing=null;}
}
export async function commitHistory(root,branch="") {
  const history=await refreshGitHistory(root);if(!branch)return history.commits;
  const head=history.branches[branch];if(!head)return [];
  const byId=new Map(history.commits.map(item=>[item.commit,item]));const reachable=new Set();const pending=[head];
  while(pending.length){const id=pending.pop();if(reachable.has(id))continue;reachable.add(id);pending.push(...(byId.get(id)?.parents||[]));}
  return history.commits.filter(item=>reachable.has(item.commit));
}
export async function findCommit(root,id) {if(!/^git-[a-f0-9]{40,64}$/.test(id))return null;return (await refreshGitHistory(root)).commits.find(item=>item.id===id)||null;}
export async function gitSourceInventory(root,commit) {
  if(!/^[a-f0-9]{40,64}$/.test(commit))throw new Error("Некорректный коммит");
  const text=await git(root,["ls-tree","-r","--long","-z",commit]);
  return text.split("\0").filter(Boolean).flatMap(row=>{const match=row.match(/^(100\d+) blob ([a-f0-9]+)\s+(\d+)\t(.+)$/);if(!match)return [];const file=match[4];if(/(^|\/)(\.git|node_modules|\.repo-canvas|dist|output|coverage|\.env(?:\..*)?|auth\.json|secrets?\.json|.*\.(?:key|pem|p12|pfx))(\/|$)/i.test(file))return [];return [{path:file,size:Number(match[3]),objectId:match[2]}];});
}
export async function readGitSource(root,commit,reference) {
  if(!/^[a-f0-9]{40,64}$/.test(commit))throw new Error("Некорректный коммит");
  const match=String(reference||"").replaceAll("\\","/").match(/^(.*?)(?:(?:#|::)([^#]+)|:(\d+)(?:[-:](\d+))?)?$/);
  const file=match?.[1];
  if(!file||path.isAbsolute(file)||file.split("/").includes("..")||/(^|\/)(\.git|node_modules|\.repo-canvas|\.env(?:\..*)?|auth\.json|secrets?\.json|.*\.(?:key|pem|p12|pfx))(\/|$)/i.test(file))throw new Error("Источник вне разрешённого проекта");
  try {
    const {stdout}=await execute("git",["show",`${commit}:${file}`],{cwd:root,encoding:"utf8",windowsHide:true,timeout:10000,maxBuffer:4*1024*1024});
    if(stdout.includes("\0"))throw new Error("Двоичный источник");
    return {...codeExcerpt(reference,Buffer.from(stdout),{maxChars:24000}),commit,historical:true};
  }catch(error){return {reference,commit,error:`Исторический источник недоступен: ${String(error.message).slice(0,200)}`};}
}
export function startGitTracker(root,{onChange,pollMs=5000}={}) {
  let stopped=false;let previous=readSourceJson(path.join(dataDirectory,"history","observed-head.json"),null);let initialized=false;let timer;
  const poll=async()=>{
    try {
      const head=await gitHead(root);
      if(!stopped && head && (previous?head.commit!==previous.commit || head.branch!==previous.branch:initialized)) {
        appendEvent(createEvent("activity.log",{actor:"observer",payload:{message:head.title,checkpoint:{kind:"commit",title:head.title,commit:head.commit,branch:head.branch,eventAt:new Date().toISOString(),commitAt:head.at,verification:"needs-review"}}}));
        loaded=null;await onChange?.(head);
      }
      if(!stopped&&head&&(!previous||head.commit!==previous.commit||head.branch!==previous.branch))writeSourceJson(path.join(dataDirectory,"history","observed-head.json"),head);previous=head;initialized=true;
    }finally{if(!stopped)timer=setTimeout(()=>poll().catch(()=>{}),pollMs);timer?.unref();}
  };
  poll().catch(()=>{});return {stop(){stopped=true;clearTimeout(timer);}};
}
