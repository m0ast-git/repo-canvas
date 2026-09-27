import {useEffect,useRef,useState} from "react";
import {useQuery} from "@tanstack/react-query";
import {readApiJson} from "./project-queries.js";

export function useVisitChanges(snapshot,api) {
  const key=`repo-canvas.last-seen:${location.host}:${snapshot.map?.projectTitle||"project"}`;
  const [baseline,setBaseline]=useState(()=>{try{return localStorage.getItem(key)||"";}catch{return "";}});
  const head=snapshot._historyHead?.id;const latest=useRef(head);if(head)latest.current=head;
  const arrival=useRef(head);if(!arrival.current&&head)arrival.current=head;
  const comparison=useQuery({queryKey:["history","since-visit",baseline,arrival.current],enabled:Boolean(!snapshot._history&&baseline&&arrival.current&&baseline!==arrival.current),retry:false,queryFn:({signal})=>readApiJson(api,`/api/history/compare?${new URLSearchParams({from:baseline,to:arrival.current})}`,signal)});
  const markSeen=()=>{if(latest.current){arrival.current=latest.current;try{localStorage.setItem(key,latest.current);}catch{}setBaseline(latest.current);}};
  useEffect(()=>{const remember=()=>{if(latest.current)try{localStorage.setItem(key,latest.current);}catch{}};window.addEventListener("pagehide",remember);return()=>{window.removeEventListener("pagehide",remember);};},[key]);
  useEffect(()=>{if(!baseline&&head)markSeen();},[baseline,head]);
  useEffect(()=>{if(comparison.error?.status===404)markSeen();},[comparison.error,head]);
  const value=!snapshot._history&&baseline!==latest.current&&baseline!==arrival.current?comparison.data:null;
  const changed=value&&[...value.added,...value.changed,...value.removed].some(item=>item.kind==="entities");
  return {comparison:changed?value:null,markSeen};
}
