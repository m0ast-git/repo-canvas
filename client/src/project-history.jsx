import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { HISTORY_INDEX_KEY, historyIndexOptions, historySnapshotOptions, historyComparisonOptions, trimHistoryCache, readApiJson } from "./project-queries.js";

import {historyTitle} from "./job-message.js";

const EMPTY_INDEX={checkpoints:[],total:0,branches:[]};
export function useProjectHistory(live,api,toast,job) {
  const client=useQueryClient();
  const [filter,setFilter]=useState({kind:'all',branch:'',query:'',view:'chapters',chapter:''});
  const [requested,setRequested]=useState(null),[baseline,setBaseline]=useState(''),[seekFailure,setSeekFailure]=useState(null);
  const shown=useRef(null),enteredAt=useRef(null),indexHead=useRef(undefined);
  const index=useQuery({...historyIndexOptions(api,filter),enabled:Boolean(live),placeholderData:keepPreviousData,refetchInterval:query=>query.state.error?5000:false});
  const selected=useQuery({...historySnapshotOptions(api,requested),enabled:Boolean(requested),placeholderData:()=>shown.current||undefined});
  const past=requested?(selected.data||shown.current):null;
  const comparison=useQuery({...historyComparisonOptions(api,baseline,past?._history?.id,live?.revision),enabled:Boolean(baseline&&live)});
  const refresh=useCallback(()=>client.invalidateQueries({queryKey:HISTORY_INDEX_KEY}),[client]);
  const seek=useCallback(id=>{
    setSeekFailure(null);
    if(id&&!requested)enteredAt.current=live?._historyHead?.number||0;
    if(!id){enteredAt.current=null;shown.current=null;}
    setRequested(id||null);
  },[requested,live?._historyHead?.number]);
  useEffect(()=>{
    const head=live?._historyHead?.id;
    if(indexHead.current!==undefined&&head!==indexHead.current)void refresh();
    indexHead.current=head;
  },[live?._historyHead?.id,refresh]);
  useEffect(()=>{
    if(requested&&selected.data&&!selected.isPlaceholderData){shown.current=selected.data;trimHistoryCache(client);}
  },[requested,selected.data,selected.isPlaceholderData,client]);
  useEffect(()=>{
    if(!requested||!selected.error)return;
    setSeekFailure({id:requested,message:selected.error.message});
    setRequested(shown.current?._history?.id||null);
  },[requested,selected.error]);
  useEffect(()=>{if(index.error)toast(index.error.message,true);},[index.error,toast]);
  useEffect(()=>{if(comparison.error)toast(comparison.error.message,true);},[comparison.error,toast]);
  useEffect(()=>{
    if(job?.kind!=='reconstruction'||job.status!=='done')return;
    for(const id of job.result?.completed||[])void client.invalidateQueries({queryKey:['history','state',id]});
    void refresh();
  },[job?.finishedAt,client,refresh]);
  return {index:index.data||EMPTY_INDEX,indexUpdating:Boolean(live?._historyHead?.id&&index.data?.head!==live._historyHead.id)||index.isPlaceholderData,filter,setFilter,past,requested,loading:Boolean(requested&&(selected.isPending||selected.isPlaceholderData)),seek,seekFailure,refresh,baseline,setBaseline,comparison:baseline?comparison.data:null,
    newCount:requested?Math.max(0,(live?._historyHead?.number||0)-(enteredAt.current||0)):0,snapshot:past||live};
}

const date=value=>value?new Date(value).toLocaleString("ru-RU",{day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"}):"";
const landmark=point=>point?`#${point.number} · ${date(point.at)}`:"Нет событий";
export function ProjectTimeline({timeline,api,toast,architect,setArchitect}) {
  const {index,indexUpdating,filter,setFilter,past,requested,seek,loading,baseline,setBaseline,comparison}=timeline;
  const [range,setRange]=useState(10);const [step,setStep]=useState(1);const [calendar,setCalendar]=useState("");const [expanded,setExpanded]=useState(false);
  const [mark,setMark]=useState("");const [comment,setComment]=useState("");
  const queryClient=useQueryClient();
  const commentsKey=['history','comments',past?._history?.id];
  const commentsQuery=useQuery({queryKey:commentsKey,enabled:Boolean(past),staleTime:0,queryFn:({signal})=>readApiJson(api,`/api/history/comments?id=${encodeURIComponent(past._history.id)}`,signal)});
  const comments=commentsQuery.data||past?._comments||[];
  const strip=useRef(null);const [width,setWidth]=useState(600);const [windowStart,setWindowStart]=useState(0);const [calendarAnchor,setCalendarAnchor]=useState(null);
  useEffect(()=>{if(!strip.current)return;const observer=new ResizeObserver(([entry])=>setWidth(entry.contentRect.width));observer.observe(strip.current);return()=>observer.disconnect();},[]);
  const points=useMemo(()=>{if(!calendar)return index.checkpoints;const end=Date.parse(index.checkpoints.at(-1)?.at||"");const duration={hour:3600000,day:86400000,week:604800000,month:2678400000}[calendar];const anchor=calendarAnchor||end;return index.checkpoints.filter(point=>Date.parse(point.at)>=anchor-duration/2 && Date.parse(point.at)<=Math.min(end,anchor+duration/2));},[index,calendarAnchor,calendar]);
  const current=requested?points.findIndex(point=>point.id===requested||point.checkpointId===requested):points.length-1;
  const slots=Math.max(1,Math.min(range,Math.floor(width/28)+1));const center=current<0?points.length-1:current;
  const start=Math.max(0,Math.min(points.length-slots,windowStart));const end=Math.min(points.length-1,start+slots-1);
  useEffect(()=>{if(center<start||center>end)setWindowStart(Math.max(0,center-Math.floor(slots/2)));},[center,start,end,slots]);
  const periodStart=Math.max(0,Math.floor(Math.max(0,center)/range)*range);const periodEnd=Math.min(points.length-1,periodStart+range-1);
  const count=Math.max(0,(index.checkpoints.at(-1)?.revision||0)-(past?._history?.revision||0));
  const go=offset=>{if(!points.length)return;seek(points[Math.max(0,Math.min(points.length-1,center+offset))].id);};
  const submit=async(event,type)=>{event.preventDefault();try{const response=await api(`/api/history/${type}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(type==="comment"?{id:past._history.id,text:comment}:{title:mark})});const value=await response.json();if(!response.ok)throw new Error(value.error);if(type==="comment"){queryClient.setQueryData(commentsKey,current=>[...(current||comments),value]);setComment("");}else{setMark("");timeline.refresh();}toast(type==="comment"?"Комментарий сохранён отдельно от снимка":"Отметка сохранена");}catch(error){toast(error.message,true);}};
  return <section className={`project-timeline ${expanded?"is-expanded":""}`} data-period-start={periodStart} data-period-end={periodEnd} aria-label="История карты">
    {timeline.seekFailure&&<p className="history-error" role="alert">Не удалось открыть выбранный момент. {timeline.seekFailure.message} <button onClick={()=>seek(timeline.seekFailure.id)}>Повторить</button></p>}
    <div className="timeline-heading"><button className={!past?"live-pill is-live":"live-pill"} onClick={()=>seek(null)}>● Live{past&&timeline.newCount>0?` +${timeline.newCount}`:""}</button><span className="timeline-position"><strong>{past?`#${past._history.number||""} ${historyTitle(past._history)}`:"Текущее состояние"}</strong><small>{loading?"Загружаем выбранный чекпоинт…":past?`${date(past._history.at)} · ${past._history.geometry==="recorded"?"сохранённый вид":past._history.unavailable?"карта в тот момент не записывалась":"раскладка восстановлена сейчас"}`:`${index.total} ${index.view==="chapters"?"глав":"отметок"}`}</small></span><button aria-expanded={expanded} onClick={()=>setExpanded(!expanded)}>История {expanded?"⌄":"⌃"}</button></div>
    <div className="timeline-controls"><button aria-label="Предыдущий чекпоинт" disabled={indexUpdating||!points.length||center<=0} onClick={()=>go(-step)}>←</button><div className="checkpoint-strip" ref={strip}><input aria-label="Чекпоинт карты" type="range" min={start} max={Math.max(start+1,end)} step="1" value={Math.max(start,Math.min(end,center))} disabled={indexUpdating||end<=start} onKeyDown={event=>{if(["ArrowLeft","ArrowRight"].includes(event.key)){event.preventDefault();go(event.key==="ArrowLeft"?-step:step);}}} onChange={event=>{const point=points[Number(event.target.value)];if(point)seek(point.id);}}/><div className="timeline-landmarks"><span>{landmark(points[start])}</span><span>{landmark(points[end])}</span></div><div className="checkpoint-ticks" aria-hidden="true">{points.slice(start,end+1).map(point=><i key={point.id} title={point.title}/>)}</div></div><button aria-label="Следующий чекпоинт" disabled={indexUpdating||!points.length||center>=points.length-1} onClick={()=>go(step)}>→</button><label>Шаг<input aria-label="Шаг по чекпоинтам" type="number" min="1" max="10000" value={step} onChange={event=>setStep(Math.max(1,Number(event.target.value)))}/></label><label>Диапазон<select aria-label="Диапазон истории" value={range} onChange={event=>setRange(Number(event.target.value))}>{[1,10,100,1000].map(value=><option key={value} value={value}>{value}</option>)}</select></label></div>
    {past?._history?.verification==="needs-review"&&<p className="history-help">Это карта, сохранённая при обнаружении коммита. Её соответствие новому коду тогда ещё не было проверено; результат последующей проверки находится в отдельном чекпоинте.</p>}
    {past?._history?.reconstruction&&<p className="history-help">Реконструкция сделана {date(past._history.recordedAt)}. Изучено файлов: {past._history.coverage?.filesRead} из {past._history.coverage?.totalFiles}.</p>}{past?._history?.unavailable&&<p className="history-help">Можно отдельно построить описание по коду этого коммита. Будут использованы выбранные модели и предел расхода. <button disabled={architect?.running} onClick={async()=>{try{const response=await api("/api/history/reconstruct",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({ids:[requested]})});const value=await response.json();if(!response.ok)throw new Error(value.error);setArchitect(value);}catch(error){toast(error.message,true);}}}>Восстановить этот момент</button></p>}
    {expanded&&<div className="timeline-details"><div className="history-filters"><label>Подробность<select aria-label="Подробность истории" value={filter.chapter?"chapter":filter.view||"all"} onChange={event=>setFilter({...filter,view:event.target.value,chapter:""})}><option value="chapters">Главы</option><option value="all">Все отметки</option>{filter.chapter&&<option value="chapter">Внутри главы</option>}</select></label><label>События<select value={filter.kind} onChange={event=>setFilter({...filter,kind:event.target.value})}>{[["all","Все"],["commit","Коммиты"],["session","Сессии"],["decision","Решения"],["map","Карта"],["manual","Мои отметки"]].map(([value,title])=><option key={value} value={value}>{title}</option>)}</select></label><label>Ветка<select value={filter.branch} onChange={event=>setFilter({...filter,branch:event.target.value})}><option value="">Все ветки</option>{index.branches.map(branch=><option key={branch}>{branch}</option>)}</select></label><label>Время<select value={calendar} onChange={event=>{setCalendarAnchor(Date.parse(past?._history?.at||index.checkpoints.at(-1)?.at));setCalendar(event.target.value);}}>{[["","Любое"],["hour","Час"],["day","День"],["week","Неделя"],["month","Месяц"]].map(([value,title])=><option key={value} value={value}>{title}</option>)}</select></label><label>Найти дату, номер, название<input value={filter.query} onChange={event=>setFilter({...filter,query:event.target.value})} placeholder="2026-09-05 или #…"/></label><label>Свой диапазон<input type="number" min="1" max="20000" value={range} onChange={event=>setRange(Math.max(1,Number(event.target.value)))}/></label></div>
      <p className="history-help">Точная шкала сохраняет расстояние между соседними отметками. Обзор периода помогает выбрать участок, после чего можно двигаться по одному чекпоинту.</p>
      <div className="period-nav"><button disabled={periodStart===0} onClick={()=>go(-range)}>← Период</button><span>#{points[periodStart]?.number||0}–{points[periodEnd]?.number||0} · {range} в периоде</span><button disabled={periodEnd>=points.length-1} onClick={()=>go(range)}>Период →</button></div><input aria-label="Обзор периода истории" type="range" min={periodStart} max={Math.max(periodStart+1,periodEnd)} value={Math.max(periodStart,Math.min(periodEnd,center))} onChange={event=>{const point=points[Number(event.target.value)];if(point)seek(point.id);}} disabled={periodEnd<=periodStart}/>
      <div className="checkpoint-list">{points.slice(Math.max(0,center-3),Math.max(7,center+4)).map(point=><button key={point.id} className={point.id===requested?"is-active":""} onClick={()=>seek(point.id)}><small>#{point.number} · {date(point.at)}</small><span>{historyTitle(point)}{point.checkpointCount>1&&` · ${point.checkpointCount} отметок`}</span></button>)}</div>
      {points.find(point=>point.id===requested)?.checkpointCount>1&&<button onClick={()=>setFilter({...filter,chapter:points.find(point=>point.id===requested).chapterId})}>Открыть отметки этой главы</button>}<div className="history-actions"><button disabled={!past||past._history.unavailable} onClick={()=>setBaseline(past._history.id)}>Сравнивать от выбранного</button>{baseline&&<button onClick={()=>setBaseline("")}>Убрать сравнение</button>}{!past&&<form onSubmit={event=>submit(event,"checkpoint")}><input aria-label="Название отметки" value={mark} onChange={event=>setMark(event.target.value)} placeholder="Моя отметка" required maxLength={240}/><button>Запомнить</button></form>}</div>
      {comparison&&<p className="comparison-range">От {comparison.fromPoint?.title||baseline} · {date(comparison.fromPoint?.at)} → {comparison.toPoint?.title||"Live"} {date(comparison.toPoint?.at)}</p>}{comparison&&<p className="change-summary">Добавлено {comparison.added?.length||0} · изменено {comparison.changed?.length||0} · удалено {comparison.removed?.length||0}{comparison.removed?.length>0&&<span> · Удалено: {comparison.removed.map(item=>item.label).join(", ")}</span>}</p>}
      {past&&!past._history.unavailable&&<><form className="history-comment" onSubmit={event=>submit(event,"comment")}><input aria-label="Комментарий к прошлому" value={comment} onChange={event=>setComment(event.target.value)} placeholder="Комментарий к этому состоянию" required maxLength={4000}/><button>Добавить</button></form>{comments.map(item=><p key={item.id}>{item.text}</p>)}</>}
    </div>}
  </section>;
}
