import {useEffect,useRef} from "react";

export function ArchitectStatus({job,notice,statistics,disconnected,onAction,onCancel,onDismiss}) {
  const element=useRef(null);
  useEffect(()=>{
    const close=event=>{if(element.current?.open&&!element.current.contains(event.target))element.current.open=false;};
    const escape=event=>{if(event.key==="Escape"&&element.current?.open){event.preventDefault();event.stopImmediatePropagation();element.current.open=false;element.current.querySelector("summary")?.focus();}};
    document.addEventListener("pointerdown",close);window.addEventListener("keydown",escape,true);
    return()=>{document.removeEventListener("pointerdown",close);window.removeEventListener("keydown",escape,true);};
  },[]);
  return <details ref={element} className={`architect-status ${notice.tone}`}><summary aria-label={`Состояние обновления: ${notice.title}`}><i aria-hidden="true"/><span className="job-status-label">{notice.title}</span><span className="job-status-short">Статус</span></summary><section className="architect-status-panel" aria-label="Подробности обновления"><strong>{notice.title}</strong><p>{notice.body}</p>
    <p className="muted-text">Время: {statistics.time}{!statistics.missingMetadata&&` · токены: ${statistics.tokens}`}</p>{!statistics.missingMetadata&&<p className="muted-text">Модель: {statistics.models}</p>}
    {job.running&&!disconnected&&<p className="muted-text">Сервер на связи{job.call?` · запрос ${job.call}`:""}. Можно продолжать читать карту.</p>}
    {job.error&&<details><summary>Техническая запись</summary><pre>{job.error}</pre></details>}
    <footer>{job.running&&!disconnected&&<button disabled={job.cancelRequested} onClick={onCancel}>{job.cancelRequested?"Останавливаем…":"Остановить"}</button>}{notice.action&&<button onClick={onAction}>{notice.label}</button>}{!job.running&&<button onClick={onDismiss}>Скрыть сообщение</button>}</footer>
  </section></details>;
}
