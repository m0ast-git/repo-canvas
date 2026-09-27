import {useQuery} from "@tanstack/react-query";
import {readApiJson} from "./project-queries.js";

export function WorkDetail({work,api,checkpointId=""}) {
  const query=useQuery({queryKey:["work",work.id,checkpointId,work.updatedAt],queryFn:({signal})=>readApiJson(api,`/api/work/${encodeURIComponent(work.id)}${checkpointId?`?checkpointId=${encodeURIComponent(checkpointId)}`:""}`,signal),retry:false});
  const value=query.data||work;const changes=value.proposedChanges;
  return <><p>{value.note}</p>{query.error&&<p className="muted-text">Подробности временно недоступны.</p>}{value.verification?.state==="needs-review"&&<p className="inline-error">Изменения этой задачи ещё требуют проверки по источникам.</p>}{(value.verification||changes)&&<details><summary>Основания и предложенные изменения</summary>{value.verification?.reason&&<p>{value.verification.reason}</p>}{changes&&<p>Предложено изменений элементов: {changes.entityChanges?.length||0}; связей: {changes.relationChanges?.length||0}.</p>}</details>}</>;
}
