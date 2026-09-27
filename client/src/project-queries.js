import { QueryClient } from "@tanstack/react-query";

export const LIVE_KEY=["project","live"];
export const ARCHITECT_KEY=["project","architect"];
export const UPDATE_KEY=["project","update"];
export const HISTORY_INDEX_KEY=["history","index"];

export function createProjectQueryClient() {
  return new QueryClient({defaultOptions:{queries:{
    networkMode:"always",staleTime:Infinity,gcTime:60_000,
    refetchOnWindowFocus:false,refetchOnReconnect:false,
    retry:(count,error)=>count<1&&!([401,403,404].includes(error.status)),retryDelay:500,
  },mutations:{retry:false,networkMode:"always"}}});
}

export async function readApiJson(api,url,signal) {
  const response=await api(url,{signal});
  if(!response.ok){const body=await response.json().catch(()=>({}));throw Object.assign(new Error(body.error||`HTTP ${response.status}`),{status:response.status});}
  return response.json();
}

// A response already in flight cannot undo a successfully saved owner action.
export function acceptLiveSnapshot(previous,incoming) {
  if(!incoming)return previous;
  if(previous&&incoming.revision<previous.revision)return previous;
  if(previous?._layoutSeed&&incoming.revision===previous.revision&&!incoming._geometry)return {...incoming,_layoutSeed:previous._layoutSeed};
  return incoming;
}
export function setLiveSnapshot(client,update) {
  client.setQueryData(LIVE_KEY,previous=>{
    const next=typeof update==="function"?update(previous?.snapshot):update;
    return {...previous,snapshot:acceptLiveSnapshot(previous?.snapshot,next)};
  });
}
export function liveQueryOptions(client,api) {
  return {queryKey:LIVE_KEY,retry:false,queryFn:async({signal})=>{
    const cached=client.getQueryData(LIVE_KEY);
    const status=cached?.snapshot?await readApiJson(api,"/api/revision",signal):null;
    const force=client.getQueryState(LIVE_KEY)?.isInvalidated;
    const incoming=!cached?.snapshot||force||status.revision!==cached.snapshot.revision?await readApiJson(api,"/api/state",signal):cached.snapshot;
    const latest=client.getQueryData(LIVE_KEY);
    return {snapshot:acceptLiveSnapshot(latest?.snapshot,incoming),observer:status?.observer||latest?.observer||null};
  }};
}
export function historyIndexOptions(api,filter) {
  return {queryKey:[...HISTORY_INDEX_KEY,filter],queryFn:({signal})=>readApiJson(api,`/api/history?${new URLSearchParams({...filter,limit:20000})}`,signal)};
}
export function historySnapshotOptions(api,id) {
  return {queryKey:["history","state",id],queryFn:({signal})=>readApiJson(api,`/api/history/state?id=${encodeURIComponent(id)}`,signal),retry:false};
}
export function historyComparisonOptions(api,baseline,pastId,liveRevision) {
  const target=pastId||"live";
  return {queryKey:["history","compare",baseline,target,pastId?null:liveRevision],gcTime:0,
    queryFn:({signal})=>readApiJson(api,`/api/history/compare?${new URLSearchParams({from:baseline,to:target})}`,signal)};
}
export function trimHistoryCache(client,max=8) {
  const entries=client.getQueryCache().findAll({queryKey:["history","state"]}).sort((a,b)=>b.state.dataUpdatedAt-a.state.dataUpdatedAt);
  let excess=entries.length-max;
  for(const query of entries.reverse())if(excess>0&&!query.isActive()){client.removeQueries({queryKey:query.queryKey,exact:true});excess--;}
}
