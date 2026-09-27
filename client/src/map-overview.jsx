import {useMemo} from "react";
import {ViewportPortal} from "@xyflow/react";
import {roundedRoute} from "./design-system/graph-theme.js";
import {displaceOverlappingAreas} from "./container-layout.js";
import {WorkActivity} from "./canvas-card.jsx";
import {ConnectionMarkers,connectionMarkerId} from "./design-system/connection-markers.jsx";

const linksLabel=count=>`${count} ${count%10===1&&count%100!==11?"связь":[2,3,4].includes(count%10)&&![12,13,14].includes(count%100)?"связи":"связей"}`;

export function overviewRectangles(rects,zoom) {
  let result=new Map([...rects].map(([id,rect])=>[id,{...rect,width:Math.max(rect.width,300/zoom),height:Math.max(rect.height,282/zoom)}]));
  for(const id of result.keys())result=displaceOverlappingAreas(result,id,48/zoom).rects;
  return result;
}

export function overviewConnections(snapshot,rects) {
  const areas=new Map(snapshot.entities.map(item=>[item.id,item.areaId]));const grouped=new Map();
  for(const relation of snapshot.relations) {
    const from=areas.get(relation.from),to=areas.get(relation.to);if(!from||!to||from===to||!rects.has(from)||!rects.has(to))continue;
    const key=[from,to].sort().join("|");const item=grouped.get(key)||{id:key,from,to,relations:[],bidirectional:false};
    item.bidirectional ||= from!==item.from;item.relations.push(relation);grouped.set(key,item);
  }
  return [...grouped.values()].map(item=>{
    const a=rects.get(item.from),b=rects.get(item.to);const ac={x:a.x+a.width/2,y:a.y+a.height/2},bc={x:b.x+b.width/2,y:b.y+b.height/2};
    const horizontal=a.x+a.width<b.x||b.x+b.width<a.x;
    const sign=horizontal?Math.sign(bc.x-ac.x):Math.sign(bc.y-ac.y);
    const start=horizontal?{x:sign>0?a.x+a.width:a.x,y:ac.y}:{x:ac.x,y:sign>0?a.y+a.height:a.y};
    const end=horizontal?{x:sign>0?b.x:b.x+b.width,y:bc.y}:{x:bc.x,y:sign>0?b.y:b.y+b.height};
    const middle=horizontal?(start.x+end.x)/2:(start.y+end.y)/2;
    return {...item,points:horizontal?[start,{x:middle,y:start.y},{x:middle,y:end.y},end]:[start,{x:start.x,y:middle},{x:end.x,y:middle},end],label:{x:(start.x+end.x)/2,y:(start.y+end.y)/2}};
  });
}

export function MapOverview({snapshot,rects,zoom,colors,activity,onArea,onEntity}) {
  const connections=useMemo(()=>overviewConnections(snapshot,rects),[snapshot,rects]);
  return <ViewportPortal><div className="map-overview" aria-label="Обзор областей проекта">
    <svg className="overview-connections" overflow="visible" aria-hidden="true">{connections.slice(0,60).map((connection,index)=>{
      const color=colors.get(connection.from),reverseColor=colors.get(connection.to),id=`overview-${index}`,marker=connectionMarkerId(id),gradient=`overview-exchange-${index}`,first=connection.points[0],last=connection.points.at(-1);
      return <g key={connection.id}><ConnectionMarkers id={id} color={color} reverseColor={reverseColor} bidirectional={connection.bidirectional} zoom={zoom} size={7}/>{connection.bidirectional&&<defs><linearGradient id={gradient} gradientUnits="userSpaceOnUse" x1={first.x} y1={first.y} x2={last.x} y2={last.y}><stop offset="0%" stopColor={reverseColor}/><stop offset="46%" stopColor={reverseColor}/><stop offset="54%" stopColor={color}/><stop offset="100%" stopColor={color}/></linearGradient></defs>}<path d={roundedRoute(connection.points,28)} fill="none" stroke={connection.bidirectional?`url(#${gradient})`:color} strokeWidth={(1.4+Math.min(1.5,connection.relations.length/10))/zoom} strokeDasharray={connection.relations.every(item=>item.status==="planned")?`${6/zoom} ${4/zoom}`:undefined} markerEnd={`url(#${marker}-end)`} markerStart={connection.bidirectional?`url(#${marker}-start)`:undefined}/><g transform={`translate(${connection.label.x},${connection.label.y}) scale(${1/zoom})`}><rect x="-37" y="-11" width="74" height="22" rx="11" fill="var(--rc-surface)"/><text textAnchor="middle" y="4" fill="var(--rc-text-secondary)" fontSize="11">{linksLabel(connection.relations.length)}</text></g></g>;
    })}</svg>
    {snapshot.areas.map(area=>{
      const rect=rects.get(area.id);if(!rect)return null;
      const members=snapshot.entities.filter(item=>item.areaId===area.id);const top=members.filter(item=>!item.parentId).slice(0,3);
      const problem=members.filter(item=>item.status==="problem"||item.verification?.state==="needs-review").length;
      const planned=members.filter(item=>item.status==="planned").length;
      const active=activity.areas.get(area.id)||0;
      return <section className={`overview-area nodrag nopan ${members.length&&planned===members.length?"is-planned":""}`} key={area.id} style={{left:rect.x,top:rect.y,width:rect.width,height:rect.height,"--area-color":colors.get(area.id)}}>
        <div className="overview-area-content" style={{width:rect.width*zoom,height:rect.height*zoom,transform:`scale(${1/zoom})`}}>
          {active>0&&<WorkActivity count={active} pulsing={!snapshot._history}/>}
          <button className="overview-area-title" onClick={()=>onArea(area.id)}><small>{members.length} модулей{active>0&&` · ${active} в работе`}</small><strong>{area.ownerTitle||area.title}</strong><span>{area.ownerNote||area.note||"Часть проекта"}</span></button>
          <div className="overview-modules">{top.map(item=><button key={item.id} onClick={()=>onEntity(item)}>{item.ownerLabel||item.label}</button>)}{members.length>top.length&&<button onClick={()=>onArea(area.id)}>Ещё {members.length-top.length} →</button>}</div>
          <footer>{problem>0&&<span className="overview-problem">Нужно проверить: {problem}</span>}{planned>0&&<span>В планах: {planned}</span>}{!problem&&!planned&&<span>Открыть область →</span>}</footer>
        </div>
      </section>;
    })}
  </div></ViewportPortal>;
}
