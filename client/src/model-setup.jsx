import {ModelLimits,defaultLimits} from "./model-limits.jsx";
import {useEffect,useRef,useState} from "react";

export const ROLE_LABELS=[
  ["architect","Архитектор","Строит карту и объясняет устройство проекта."],
  ["verifier","Проверяющий достоверность","Отдельно сверяет выводы с кодом и диалогами."],
  ["observer","Обзервер","Следит за текущей работой агентов."],
  ["reviewer","Быстрые проверки","Проверяет формулировки и простые несоответствия."],
];
export function rolePool(roles) {
  return ROLE_LABELS.map(([role])=>({provider:roles[role].provider,model:roles[role].model,effort:roles[role].effort,roles:[role]}));
}
export function ModelRoleFields({models,value,onChange,disabled=false}) {
  return <div className="model-role-list">{ROLE_LABELS.map(([role,label,note])=>{
    const item=value[role]||models.roles[role],recommended=models.roles[role]?.recommended;
    const catalog=(models.models||[]).filter(model=>model.provider===item.provider);
    return <fieldset key={role} disabled={disabled} className="model-role"><legend>{label}</legend><p>{note}</p>
      <div className="model-role-controls"><label>Провайдер<select value={item.provider} onChange={event=>onChange({...value,[role]:{...item,provider:event.target.value,model:event.target.value===recommended?.provider?recommended.model:""}})}>{models.providers.map(p=><option key={p.id} value={p.id} disabled={!p.installed}>{p.label||p.id}{!p.installed?" · не установлен":""}</option>)}</select></label>
      <label>Модель<input list={`models-${role}`} value={item.model} placeholder="Модель из настроек провайдера" onChange={event=>onChange({...value,[role]:{...item,model:event.target.value}})}/><datalist id={`models-${role}`}>{catalog.map(p=><option key={p.model} value={p.model}/>)}</datalist></label>
      <label>Размышление<select value={item.effort} onChange={event=>onChange({...value,[role]:{...item,effort:event.target.value}})}><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="xhigh">XHigh</option><option value="max">Max</option></select></label></div>
      {recommended?.model&&<small>Рекомендуем: {recommended.model} · {recommended.effort}</small>}
    </fieldset>;
  })}</div>;
}
export function ModelSetup({api,onClose,onStart,building=false,reason="manual",viewpoint="",onViewpoint}) {
  const [models,setModels]=useState(null),[roles,setRoles]=useState({}),[busy,setBusy]=useState(false),[error,setError]=useState("");
  const [limits,setLimits]=useState(defaultLimits);const panel=useRef(null);const [estimate,setEstimate]=useState(null);
  useEffect(()=>{let stopped=false;api("/api/architect/estimate").then(async response=>{if(response.ok&&!stopped)setEstimate(await response.json());}).catch(()=>{});return()=>{stopped=true;};},[]);
  useEffect(()=>{let stopped=false;api("/api/models").then(async response=>{const data=await response.json();if(!response.ok)throw new Error(data.error);if(!stopped){setModels(data);setRoles(data.roles);setLimits({...defaultLimits,...data.config});}}).catch(error=>!stopped&&setError(error.message));return()=>{stopped=true;};},[]);
  useEffect(()=>{const before=document.activeElement;panel.current?.focus();return()=>before?.isConnected&&before.focus();},[]);
  async function submit(event){event.preventDefault();setBusy(true);setError("");try{const response=await api("/api/models/config",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({...limits,modelProvider:roles.architect.provider,modelPool:rolePool(roles)})});const result=await response.json();if(!response.ok)throw new Error(result.error);await onStart(reason);}catch(error){setError(error.message);}finally{setBusy(false);}}
  return <div className="modal-backdrop"><form className="modal model-setup" role="dialog" aria-modal="true" aria-labelledby="model-setup-title" tabIndex={-1} ref={panel} onSubmit={submit} onKeyDown={event=>{
    if(event.key==="Escape"&&!busy){event.stopPropagation();onClose();}
    if(event.key==="Tab"){const focusable=[...panel.current.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled)')];const first=focusable[0],last=focusable.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}}
  }}><header><h2 id="model-setup-title">{building?"Построим карту проекта":"Перестроим карту проекта"}</h2><p>Вот кто будет работать. Модели и глубину размышления можно изменить сейчас и позже в настройках.</p></header>
    {estimate&&<p className="build-estimate">Ориентир: ≈{estimate.estimatedTokens.toLocaleString("ru-RU")} токенов · предел {estimate.tokenLimit.toLocaleString("ru-RU")}. Модулей в кеше: {estimate.reusedModules}, изменилось: {estimate.changedModules}. Время зависит от выбранной модели.</p>}
    {building&&<button type="button" disabled={busy} onClick={async()=>{setBusy(true);try{const response=await api("/api/architect/skeleton",{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"});const result=await response.json();if(!response.ok)throw new Error(result.error);location.reload();}catch(error){setError(error.message);setBusy(false);}}}>Показать структуру без модели</button>}
    {models?<ModelRoleFields models={models} value={roles} onChange={setRoles} disabled={busy}/>:!error&&<p role="status">Загружаем доступные модели…</p>}
    <ModelLimits value={limits} onChange={setLimits} background={false}/><p className="muted-text">{!building&&"Модели заново изучат проект. Состав карты и расположение элементов могут измениться. Текущая карта останется доступна в истории. Для обычного наблюдения перестроение не требуется. "}Выбранные модели сохранятся. Повторная попытка не переключает их и не повышает глубину размышления.</p>
    <details><summary>Пожелания к карте — необязательно</summary><label>Что учесть<textarea rows="2" value={viewpoint} onChange={event=>onViewpoint?.(event.target.value)} placeholder="Например, подробнее показать путь заявки от приёма до готового результата."/></label></details>
    {error&&<p role="alert" className="inline-error">{error}</p>}
    <footer><button type="button" disabled={busy} onClick={onClose}>Отмена</button><button className="primary" disabled={!models||busy}>{busy?"Запускаем…":building?"Построить карту":"Перестроить"}</button></footer>
  </form></div>;
}
