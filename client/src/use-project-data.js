import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ARCHITECT_KEY, LIVE_KEY, UPDATE_KEY, liveQueryOptions, readApiJson, setLiveSnapshot } from "./project-queries.js";
import { updateFinished, updatePollDelay } from "./update-polling.js";
import { jobMessage } from "./job-message.js";
import {applySnapshotDelta} from "./live-stream.js";

export function useProjectData(api,toast,unauthorized,setUnauthorized) {
  const client=useQueryClient();
  const [streamConnected,setStreamConnected]=useState(false);
  const [streamFailure,setStreamFailure]=useState(0);
  const previousArchitect=useRef(null),previousUpdate=useRef(null);
  const live=useQuery({...liveQueryOptions(client,api),enabled:!unauthorized,
    refetchInterval:streamConnected?false:5000,refetchIntervalInBackground:false});
  const job=useQuery({queryKey:ARCHITECT_KEY,enabled:!unauthorized,
    queryFn:({signal})=>readApiJson(api,"/api/architect/status",signal),
    refetchInterval:streamConnected?false:3000,refetchIntervalInBackground:false});
  const update=useQuery({queryKey:UPDATE_KEY,enabled:!unauthorized,
    queryFn:({signal})=>readApiJson(api,`/api/update/status${client.getQueryData(UPDATE_KEY)?"":"?refresh=1"}`,signal),
    refetchInterval:query=>updatePollDelay(query.state.data?.status),refetchIntervalInBackground:true});
  const setSnapshot=useCallback(value=>setLiveSnapshot(client,value),[client]);
  const setArchitect=useCallback(value=>{void client.cancelQueries({queryKey:ARCHITECT_KEY});client.setQueryData(ARCHITECT_KEY,value);},[client]);
  const setUpdate=useCallback(value=>{void client.cancelQueries({queryKey:UPDATE_KEY});client.setQueryData(UPDATE_KEY,value);},[client]);
  useEffect(()=>{
    if(unauthorized||typeof EventSource==="undefined")return;
    const stream=new EventSource("/api/stream");let lastSignal=Date.now();
    stream.onmessage=event=>{
      lastSignal=Date.now();setStreamConnected(true);setStreamFailure(0);
      let packet;try{packet=JSON.parse(event.data);}catch{return;}
      if(packet.type==="job") {client.setQueryData(ARCHITECT_KEY,packet.job);return;}
      if(packet.type==="heartbeat") {client.setQueryData(LIVE_KEY,previous=>previous?{...previous,observer:packet.observer}:previous);return;}
      const previous=client.getQueryData(LIVE_KEY);
      if(previous?.snapshot?.revision>(packet.revision??packet.snapshot?.revision)&&packet.type==="delta")return;
      const next=applySnapshotDelta(previous?.snapshot,packet);
      if(next) {setLiveSnapshot(client,next);client.setQueryData(LIVE_KEY,current=>({...current,observer:packet.observer}));}
      else void client.invalidateQueries({queryKey:LIVE_KEY});
    };
    stream.onerror=()=>{setStreamConnected(false);setStreamFailure(Date.now());};
    const heartbeat=setInterval(()=>{if(Date.now()-lastSignal>4500){setStreamConnected(false);setStreamFailure(previous=>previous||Date.now());}},1000);
    return()=>{clearInterval(heartbeat);stream.close();};
  },[client,unauthorized]);
  useEffect(()=>{if([live.error,job.error,update.error].some(error=>error?.status===401))setUnauthorized(true);},[live.error,job.error,update.error,setUnauthorized]);
  useEffect(()=>{
    const next=job.data;if(!next)return;
    const previous=previousArchitect.current;previousArchitect.current=next;
    if(previous?.running&&!next.running){
      if(next.status==="done"){
        const notice=jobMessage(next);
        toast(next.kind==="question"?"Ответ готов":next.kind==="probe"?"Подключение проверено":next.kind==="correction"?"Поправка сохранена":notice.title,["error","warning"].includes(notice.tone));
        void client.invalidateQueries({queryKey:LIVE_KEY});
      }else if(next.status==="failed")toast(jobMessage(next).body,true);
    }
  },[job.data,toast,client]);
  useEffect(()=>{
    const next=update.data;if(!next)return;
    const previous=previousUpdate.current;previousUpdate.current=next.status;
    if(updateFinished(previous,next.status)){location.reload();return;}
    if(next.status==="updated"){
      const key=`repo-canvas.updated.${next.currentVersion}`;
      if(sessionStorage.getItem(key)!=="1"){sessionStorage.setItem(key,"1");toast(`Repo Canvas обновлён до v${next.currentVersion}.`);}
    }
  },[update.data,toast]);
  const architect=useMemo(()=>job.data?{...job.data,connectionLost:Boolean(job.error)}:null,[job.data,job.error]);
  const connection=useMemo(()=>{const offline=!streamConnected&&(live.error||streamFailure>live.dataUpdatedAt);return {status:offline?"offline":live.data?"online":"connecting",lastSuccess:live.dataUpdatedAt,error:offline?"Локальный сервер недоступен. Повторяем подключение…":"",observer:live.data?.observer};},[streamConnected,streamFailure,live.error,live.data,live.dataUpdatedAt]);
  return {snapshot:live.data?.snapshot||null,setSnapshot,architect,setArchitect,update:update.data||null,setUpdate,connection};
}
