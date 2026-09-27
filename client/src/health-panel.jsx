import {useQuery} from "@tanstack/react-query";
import {readApiJson} from "./project-queries.js";

const roles={architect:"Построение",historian:"Решения владельца",observer:"Наблюдение",verifier:"Проверка фактов",reviewer:"Понятность",editor:"Поправки","code-review":"Изменения файлов"};
export function HealthPanel({api}) {
  const query=useQuery({queryKey:["project","health"],queryFn:({signal})=>readApiJson(api,"/api/health/report",signal),refetchInterval:15000,staleTime:0});
  const data=query.data;
  if(!data)return <p role="status">{query.error?"Не удалось прочитать состояние сервера":"Загружаем состояние…"}</p>;
  const pauses=[...data.usage.pauses,...(data.observer.paused||[])];
  return <section className="health-panel"><h2>Состояние проекта</h2><p>{data.observer.pausedByHost?"Карта доступна. Фоновые модельные процессы приостановлены на этом запуске сервера; их можно возобновить в настройках.":pauses.length?"Фоновая проверка приостановлена защитой расхода.":data.observer.running?"Наблюдение работает. Пределы фонового расхода включены.":"Карта доступна. Фоновое наблюдение выключено."}</p>
    {pauses.map((pause,index)=><p role="alert" className="inline-error" key={index}>{pause.reason}{pause.until&&` · до ${new Date(pause.until).toLocaleString("ru-RU")}`}</p>)}
    <dl><div><dt>Данные проекта</dt><dd>{(data.storage.bytes/1048576).toFixed(1)} МБ</dd></div><div><dt>Фоновый предел</dt><dd>{data.limits.callsPerHour} вызовов на роль в час · {data.limits.tokensPerDay.toLocaleString("ru-RU")} токенов в день</dd></div><div><dt>Повторная проверка задачи</dt><dd>До {data.limits.finalAttempts} попыток</dd></div></dl>
    <h3>Вызовы моделей за 7 дней</h3><p>{data.usage.calls} вызовов · {data.usage.knownTokens.toLocaleString("ru-RU")} известных токенов{data.usage.unknownCalls>0&&` · ${data.usage.unknownCalls} вызовов без данных о расходе`}</p>
    <table><thead><tr><th>Роль</th><th>Час</th><th>Сегодня</th><th>7 дней</th><th>Ошибки</th></tr></thead><tbody>{Object.entries(data.usage.roles).map(([role,value])=><tr key={role}><th>{roles[role]||role}</th><td>{value.lastHour}</td><td>{value.today}</td><td>{value.calls}</td><td>{value.errors}</td></tr>)}</tbody></table>
    {!data.usage.calls&&<p className="muted-text">Учёт начинается с этой версии. Расход прежних запусков сюда не включён.</p>}
    {data.evaluation&&<><h3>Понятность по пяти вопросам</h3><p>{data.evaluation.score} из {data.evaluation.maxScore} · версия {data.evaluation.version} · {new Date(data.evaluation.at).toLocaleDateString("ru-RU")}</p><p className="muted-text">Автоматическая оценка по карте и исходникам. Проверка с реальным владельцем проводится отдельно.</p></>}
    <h3>Журнал за последний час</h3><p>{Object.values(data.eventsLastHour).reduce((sum,count)=>sum+count,0)} событий{data.noisyWork.length?` · частые повторы у ${data.noisyWork.length} задач`:" · частых повторов не найдено"}</p>
    {data.git.available&&<><h3>Сохранение в Git</h3><p>{data.git.changedFiles?`${data.git.changedFiles} файлов с незакоммиченными изменениями. Последний коммит — ${data.git.daysSinceCommit} дней назад.`:"Все изменения зафиксированы в Git."}</p></>}
    <details><summary>Число отметок по дням</summary><p className="muted-text">По последним 4 МБ журнала.</p>{Object.entries(data.checkpointsByDay).map(([day,count])=><p key={day}>{day} · {count}</p>)}</details>
  </section>;
}
