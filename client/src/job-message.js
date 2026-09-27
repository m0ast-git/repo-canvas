const phases = {
  starting:"Подключаем выбранную модель.", knowledge:"Читаем решения и пожелания из проектных диалогов.",
  sources:"Читаем текущие файлы проекта.", inspecting:"Изучаем устройство проекта.",
  building:"Собираем элементы и связи.", validating:"Проверяем элементы и связи.", evidence:"Сверяем карту с кодом проекта.",
  reviewing:"Проверяем, понятны ли названия и объяснения.", refining:"Уточняем найденные неточности.",
  repairing:"Исправляем найденные несоответствия.", applying:"Сохраняем обновлённую карту.",
};

export function activityText(entry) {
  const text=String(entry.message||"");
  const statuses={active:"в работе",done:"завершена",stopped:"остановлена",blocked:"ожидает",planned:"запланирована",operational:"есть в реализации",updated:"обновлено",disabled:"отключено",problem:"нужна проверка"};
  if(entry.type==="work.upsert")return text.replace(/^Work /,"").replace(/ → ([\w-]+)$/,(_,status)=>` — ${statuses[status]||status}`);
  if(entry.type==="map.upsert")return "Обновлена карта проекта";
  if(entry.type==="area.upsert")return text.replace(/^Area /,"Область «").replace(/ updated$/,"» обновлена");
  if(entry.type==="entity.upsert")return text.replace(/ → ([\w-]+)$/,(_,status)=>` — ${statuses[status]||status}`);
  if(entry.type==="relation.upsert")return "Обновлена связь между элементами";
  if(entry.type==="relation.remove")return "Удалена связь между элементами";
  if(/Observer could not classify|Observer model failed|Observer tick failed|Observer start failed/i.test(text))return "Наблюдатель не смог завершить проверку. Подробности доступны в состоянии проекта.";
  if(/Observer could not read|Observer skipped/i.test(text))return "Часть журнала сессии недоступна для чтения";
  if(/exited with code|error|failed|timeout/i.test(text))return jobMessage({status:"failed",error:text}).title;
  return text;
}

export function historyTitle(point) {
  const raw=String(point?.title||"");
  if(/Observer|exited with code|error|failed|timeout/i.test(raw))return activityText({message:raw});
  return raw||({session:"Работа агента",map:"Обновление карты",decision:"Решение владельца",manual:"Моя отметка",commit:"Изменения кода"}[point?.kind]||"Состояние проекта");
}

export function jobElapsedMs(job, now=Date.now()) {
  const start=Date.parse(job?.startedAt||"");
  return Number.isFinite(start)?Math.max(0,(job.finishedAt?Date.parse(job.finishedAt):now)-start):0;
}

export function jobStatistics(job) {
  const result=job?.result||{};const usage=result.usage;
  const elapsed=Math.round(jobElapsedMs(job)/1000);
  const time=elapsed<60?`${elapsed} с`:`${Math.floor(elapsed/60)} мин ${elapsed%60} с`;
  const total=usage?.totalTokens??usage?.total_tokens;
  const models=[...new Set((result.models||[]).map(item=>typeof item==="string"?item:item.model).filter(Boolean).concat(result.model?[result.model]:[]))];
  return {time,missingMetadata:!Number.isFinite(total)&&!models.length&&result.calls!==0,tokens:Number.isFinite(total)?`${usage.estimated?"≈ ":""}${total.toLocaleString("ru-RU")}`:result.calls===0?"0":result.calls>0?"клиент не сообщил":"не записаны для этого запуска",models:models.join(", ")||(result.calls===0?"не запускалась":"не записана для этого запуска")};
}

export function jobMessage(job, hasMap=true) {
  if(!job)return null;
  const result=job.result||{};const raw=String(job.error||result.issue?.code||"");
  if(job.connectionLost)return {tone:"warning",title:"Нет связи с Canvas",body:"Сервер не отвечает. Состояние обновления неизвестно. Сохранённая карта доступна; проверяем подключение автоматически."};
  if(job.running&&job.cancelRequested)return {tone:"running",title:"Останавливаем обновление",body:"Отправлена команда остановки. Ждём завершения текущего запроса; сохранённая карта останется доступной."};
  if(job.running||job.status==="running")return {tone:"running",title:hasMap?"Обновляем Canvas":"Строим Canvas",body:phases[job.phase]||"Изучаем проект и проверяем изменения. Картой можно пользоваться во время обновления."};
  if(job.status==="failed"){
    if(/timed out|timeout|время ожидания/i.test(raw))return {tone:"warning",title:"Модель не ответила вовремя",body:"Время ожидания закончилось. Карта не заменена; уже собранные данные сохранены. Повторите обновление или выберите другую модель в настройках.",action:"update",label:"Обновить"};
    if(/остановкой сервера|прерван|отмен|aborted|cancelled/i.test(raw))return {tone:"warning",title:"Обновление остановлено",body:"Обновление не завершилось. Сохранённая карта доступна. Нажмите «Обновить», чтобы продолжить работу с проектом.",action:"update",label:"Обновить"};
    if(/лимит|предел расхода|budget/i.test(raw))return {tone:"warning",title:"Обновление приостановлено",body:result.canResume?"Подготовленная карта сохранена. На следующую проверку не хватает оставшегося лимита токенов. «Продолжить» начнёт новый проход проверки с отдельным лимитом расхода.":"На следующий шаг не хватает оставшегося лимита токенов. Уже собранные данные сохранены. Измените лимит в настройках и повторите обновление.",action:result.canResume?"update":"settings",label:result.canResume?"Продолжить":"Настройки"};
    if(/requires a newer version|Unknown feature flag/i.test(raw))return {tone:"error",title:"Нужна новая версия Codex",body:"Установленная версия Codex не поддерживает этот запуск. Обновите её или выберите совместимую модель в настройках.",action:"settings",label:"Настройки"};
    if(/not supported when using|unsupported model/i.test(raw))return {tone:"error",title:"Модель недоступна для этого подключения",body:"Исполнитель отклонил выбранную модель. Выберите доступную модель в настройках и проверьте подключение.",action:"settings",label:"Настройки"};
    if(/auth|авторизац|\b(?:401|403|429|500|502|503)\b|login|credential|not found|не установлен|ENOENT|provider|модель.*недоступ|upstream/i.test(raw))return {tone:"error",title:"Модель недоступна",body:"Не удалось получить ответ выбранной модели. Проверьте подключение или выберите другую модель в настройках.",action:"settings",label:"Настройки"};
    if(job.kind==="question")return {tone:"error",title:"Ответ не получен",body:"Сервис не смог получить проверяемый ответ по этой карте. Повторите вопрос или обновите Canvas, если проект уже изменился."};
    if(job.kind==="correction")return {tone:"warning",title:"Поправка не сохранена",body:"Сервис не смог подтвердить предложенную правку. Сформулируйте, какое название или поведение нужно изменить, и повторите попытку."};
    return {tone:"error",title:"Содержание карты не обновлено",body:"Обновление остановилось до сохранения результата. Повторите обновление; если ошибка повторится, проверьте подключение модели в настройках.",action:"update",label:"Обновить"};
  }
  if(result.outcome==="unchanged")return {tone:"success",title:"Обновление не потребовалось",body:"Проверенные изменения кода не требуют изменений на карте."};
  if(result.outcome==="partial")return {tone:"warning",title:"Проверенная карта сохранена",body:"Факты уже сверены с источниками. Проверка понятности ещё не закончена; её можно продолжить с сохранённого результата.",action:"update",label:"Продолжить"};
  if(result.verified===false||result.outcome==="needs-review"){
    if(result.issue?.code==="stale-sources")return {tone:"warning",title:"Canvas устарел",body:"Часть файлов, на которые ссылается карта, перемещена или удалена. Обновите Canvas, чтобы заново связать элементы с текущими файлами проекта.",action:"update",label:"Обновить"};
    if(["invalid-evidence","unreadable-evidence"].includes(result.issue?.code))return {tone:"warning",title:"Содержание карты не обновлено",body:"Модель указала ссылки, по которым нельзя прочитать нужный код. Сервис не применил её правки. Обновление заново найдёт файлы проекта и проверит элементы и связи.",action:"update",label:"Обновить"};
    return {tone:"warning",title:"Содержание карты не обновлено",body:"Модель предложила правки, которые сервис не смог подтвердить по коду. Текущая карта сохранена. Обновление заново сопоставит элементы и связи с текущими файлами.",action:"update",label:"Обновить"};
  }
  const count=Number(result.changedEntities||0)+Number(result.changedRelations||0);
  if(job.kind==="reconstruction")return {tone:"success",title:"Прошлая карта восстановлена",body:"Выбранный момент истории восстановлен по сохранённому коду проекта. Текущая карта не изменена."};
  return {tone:"success",title:"Canvas обновлён",body:job.kind==="code-review"?`Изменения кода проверены и отражены на карте${count?`: обновлено элементов и связей — ${count}`:""}.`:job.updateReason==="stale-sources"?"Устаревшие ссылки на файлы заменены. Элементы и связи заново проверены по текущему коду.":"Карта заново сверена с текущим проектом. Названия, связи и ссылки на код обновлены."};
}
