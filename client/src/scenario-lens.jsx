import {useEffect,useState} from "react";
import {CanvasCard} from "./canvas-card.jsx";
import {CodeIcon,UserIcon} from "./design-system/icons.jsx";
import {componentStatus} from "./design-system/project-theme.js";

export function ScenarioLens({scenario,snapshot,index,onStep,onClose,onInspect,colors}) {
  const [mode,setMode]=useState("map");
  const entities=new Map(snapshot.entities.map(item=>[item.id,item]));
  const relations=new Map(snapshot.relations.map(item=>[item.id,item]));
  const steps=(scenario.transitions||[]).map(step=>({...step,relation:relations.get(step.relationId)})).filter(step=>step.relation);
  const title=id=>{const item=entities.get(id);return item?.ownerLabel||item?.label||id;};
  const current=steps[index]||steps[0];
  const move=next=>onStep(Math.max(0,Math.min(steps.length-1,next)));
  useEffect(()=>{
    const keyboard=event=>{if(event.target.closest?.("input,textarea,select,[contenteditable=true],.project-timeline,.context-panel"))return;if(event.key==="Escape"){event.preventDefault();event.stopImmediatePropagation();onClose();return;}if(["ArrowLeft","ArrowRight"].includes(event.key)){event.preventDefault();event.stopImmediatePropagation();move(index+(event.key==="ArrowRight"?1:-1));}};
    window.addEventListener("keydown",keyboard,true);return()=>window.removeEventListener("keydown",keyboard,true);
  },[index,steps.length,onStep]);
  if(!current)return null;
  const participant=(id,number)=>{const item=entities.get(id);if(!item)return null;return <button className="scenario-focus-node" onClick={()=>onInspect?.(item)} style={{"--area-color":colors?.get(item.areaId)||"var(--rc-text-secondary)","--canvas-zoom":1}}><span className="scenario-node-step">{number}</span><CanvasCard title={title(id)} description={item.ownerPurpose||item.purpose} icon={item.kind==="person"?UserIcon:CodeIcon} status={componentStatus(item.status)} detail="preview"/><small>Открыть на общей карте ↗</small></button>;};
  return <><section className="scenario-lens" aria-label="Пошаговый просмотр сценария"><div><small>{scenario.title} · шаг {index+1} из {steps.length}</small><strong>{title(current.relation.from)} <span>→</span> {title(current.relation.to)}</strong><p>{current.condition||current.relation.ownerLabel||current.relation.label}</p></div><nav><button aria-label="Предыдущий шаг сценария" disabled={index===0} onClick={()=>move(index-1)}>←</button><button aria-label="Следующий шаг сценария" disabled={index===steps.length-1} onClick={()=>move(index+1)}>Далее →</button><button aria-pressed={mode==="sequence"} onClick={()=>setMode(mode==="map"?"sequence":"map")}>{mode==="map"?"Весь сценарий":"Текущий шаг"}</button><button aria-label="Закрыть сценарий" onClick={onClose}>×</button></nav></section>
    {mode==="map"&&<section className="scenario-focus" aria-label="Связь текущего шага"><div className="scenario-focus-graph">{participant(current.relation.from,index+1)}<div className="scenario-focus-arrow" aria-label={current.relation.label}><svg viewBox="0 0 90 28" aria-hidden="true"><path d="M 0 14 H 88 M 78 5 L 88 14 L 78 23" fill="none" stroke="currentColor" strokeWidth="2"/></svg></div>{participant(current.relation.to,index+2)}</div><p className="scenario-focus-action"><strong>{current.relation.ownerLabel||current.relation.label}</strong><span>{current.condition}</span></p><p className="scenario-focus-outcome">Результат сценария: {scenario.outcome}</p></section>}
    {mode==="sequence"&&<section className="scenario-sequence" aria-label="Последовательность сценария"><h2>{scenario.title}</h2><p>{scenario.trigger} → {scenario.outcome}</p><ol>{steps.map((step,at)=><li key={`${step.relationId}:${at}`}><button className={at===index?"is-current":""} onClick={()=>{move(at);setMode("map");}}><b>{at+1}</b><span><strong>{title(step.relation.from)}</strong><small>{step.condition||step.relation.label}</small></span><i>→</i><strong>{title(step.relation.to)}</strong></button></li>)}</ol></section>}
  </>;
}
