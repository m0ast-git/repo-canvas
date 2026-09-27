import fs from 'node:fs';
import path from 'node:path';

const root=path.resolve(process.argv[2] || 'output/playwright/appearance-fixture');
if(fs.existsSync(root))throw Error('Fixture already exists: '+root);
fs.mkdirSync(root,{recursive:true});
fs.writeFileSync(path.join(root,'package.json'),'{"name":"graph-appearance-acceptance","private":true}\n');
process.env.REPO_CANVAS_ROOT=root;
process.env.REPO_CANVAS_DATA_DIR=path.join(root,'.repo-canvas');
const {appendEvents,createEvent}=await import('../repo-canvas/scripts/canvas-store.mjs');
const events=[];
const add=(type,payload,ts)=>events.push({...createEvent(type,{actor:'visual-check',payload}),...(ts?{ts}:{})});
add('map.upsert',{projectTitle:'Принадлежность, планы и работа',projectSummary:'Изолированная проверка визуальной семантики',layoutDirection:'RIGHT',language:'ru'});
for(const area of [
  {id:'intake',title:'Приём заявок',note:'Работаем с входящими данными',x:0,y:0,width:1000,height:900},
  {id:'delivery',title:'Выдача результата',note:'Готовые результаты и ответы',x:1200,y:0,width:700,height:900},
  {id:'future',title:'План развития',note:'Эта область ещё не реализована',x:1200,y:1200,width:700,height:500},
])add('area.upsert',area);
const entity=(id,areaId,label,status,x,y,parentId='')=>add('entity.upsert',{id,areaId,label,status,x,y,parentId,kind:'module',purpose:'Проверяет данные и передаёт результат'});
entity('group','intake','Проверка заявки','operational',40,120);
entity('running','intake','Приём данных','operational',80,240,'group');
entity('other','intake','Проверка полей','operational',470,240,'group');
entity('planned-group','intake','Будущая проверка','planned',40,560);
entity('planned-child','intake','Проверка вложений','planned',80,680,'planned-group');
entity('ready','delivery','Подготовка ответа','operational',1280,200);
entity('blocked-target','delivery','Отправка результата','operational',1280,540);
entity('future-node','future','Архив результатов','planned',1280,1370);
entity('neutral','','Внешний источник','operational',-400,240);
let relationId=0;
const relation=(from,to,status='existing')=>add('relation.upsert',{id:'relation-'+relationId++,from,to,status,label:'передаёт данные',kind:'data'});
relation('neutral','running'); relation('running','ready'); relation('ready','running');
relation('other','ready'); relation('group','blocked-target');
relation('group','running'); // containment stays implicit
relation('planned-child','ready'); relation('planned-group','ready'); relation('ready','future-node');
relation('other','blocked-target','planned');
add('work.upsert',{id:'active',title:'Проверяю входящие данные',status:'active',targets:['running','other'],x:100,y:1020});
add('work.upsert',{id:'blocked',title:'Ожидаю ответ сервиса',status:'blocked',targets:['blocked-target'],x:1270,y:990});
add('work.upsert',{id:'planned',title:'Добавить архив',status:'planned',targets:['future-node'],x:1270,y:1810});
add('work.upsert',{id:'completed',title:'Готово',status:'done',targets:['ready']});
add('work.upsert',{id:'expired',title:'Старая активность',status:'active',targets:['ready']},new Date(Date.now()-20*60_000).toISOString());
appendEvents(events);
console.log(JSON.stringify({root,events:events.length}));
// Runtime defaults are disabled in a new project. No model calls are needed.
