export const defaultLimits={maxModelCalls:14,maxModelTokens:300000,backgroundMaxCallsPerHour:60,backgroundMaxTokensPerDay:300000};
export function ModelLimits({value,onChange,background=true}) {
  const fields=[["maxModelCalls","Вызовов на построение",1,50],["maxModelTokens","Токенов на построение",1000,3000000],...(background?[["backgroundMaxCallsPerHour","Фоновых вызовов на роль в час",1,200],["backgroundMaxTokensPerDay","Фоновых токенов в день",1000,3000000]]:[])];
  return <fieldset className="model-limits"><legend>Предел расхода</legend><p className="muted-text">Новый вызов не начнётся, если его оценка превышает остаток. Фактический ответ модели может оказаться больше оценки.</p>{fields.map(([key,label,min,max])=><label key={key}>{label}<input type="number" required min={min} max={max} value={value[key]??defaultLimits[key]} onChange={event=>onChange({...value,[key]:event.target.value===""?"":Number(event.target.value)})}/></label>)}</fieldset>;
}
