import crypto from "node:crypto";
import path from "node:path";
import {buildModuleCards} from "./module-cards.mjs";
import {appendEvents,createEvent,getSnapshot} from "./canvas-store.mjs";

const stable=(prefix,text)=>`${prefix}:${crypto.createHash("sha256").update(text).digest("hex").slice(0,16)}`;
export function createSkeleton(root) {
  const before=getSnapshot();if(before.semantic)throw new Error("Быстрая структура создаётся только для пустой карты. Существующая карта сохранена.");
  const index=buildModuleCards(root);const cards=index.cards.slice(0,250);const files=new Map(cards.map(card=>[card.path,stable("ent",card.path)]));
  const folders=[...new Set(cards.map(card=>path.posix.dirname(card.path)))];
  const areas=folders.map((folder,order)=>({id:stable("area",folder),title:folder==="."?"Точки входа":folder,note:"Файлы проекта в этом каталоге",order}));
  const verification={state:"structure-only",reason:"Подтверждены файлы и прямые импорты. Назначение и пользовательские сценарии ещё требуют объяснения."};
  const entities=cards.map((card,order)=>({id:files.get(card.path),areaId:stable("area",path.posix.dirname(card.path)),label:path.posix.basename(card.path),technicalName:card.path,kind:"module",status:"operational",path:card.path,evidence:[card.path],purpose:card.summary||`Исходный файл. Публичные объявления: ${card.symbols.slice(0,3).map(item=>item.name).join(", ")||"не найдены"}`,verification,order}));
  const relations=[...new Map(index.edges.filter(edge=>files.has(edge.from)&&files.has(edge.to)).map(edge=>{const id=stable("rel",edge.from+"->"+edge.to);return [id,{id,from:files.get(edge.from),to:files.get(edge.to),label:"импортирует код",kind:"dependency",status:"existing",evidence:[edge.reference],verification}];})).values()];
  if(!entities.length)throw new Error("Не найдены исходники поддерживаемых языков. Выберите построение с моделью по документам проекта.");
  const map={projectTitle:path.basename(root),projectSummary:"Структура исходников проекта. Откройте модуль, чтобы перейти к файлу и его прямым зависимостям.",language:"ru",layoutIntent:"flow",layoutDirection:"RIGHT",keyFlows:[],unresolvedQuestions:["Назначение продукта и его сценарии ещё не объяснены"],verification,skeleton:true};
  const event=(type,payload)=>createEvent(type,{actor:"structure",payload});
  appendEvents([event("map.upsert",map),...areas.map(item=>event("area.upsert",item)),...entities.map(item=>event("entity.upsert",item)),...relations.map(item=>event("relation.upsert",item))],{expectedRevision:before.revision});
  return {outcome:"structure",calls:0,entities:entities.length,relations:relations.length,omitted:index.cards.length-cards.length,revision:getSnapshot().revision};
}
