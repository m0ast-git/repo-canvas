import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { layoutFingerprint } from "../client/src/layout-fingerprint.js";
const root=path.resolve(process.argv[2]);const count=Number(process.argv[3]||250);const extraCheckpoints=Number(process.argv[4]||0);
if(fs.existsSync(root))throw new Error("Fixture already exists");fs.mkdirSync(root,{recursive:true});fs.writeFileSync(path.join(root,"package.json"),'{"name":"performance-map"}');execFileSync("git",["init","--quiet"],{cwd:root,windowsHide:true});
process.env.REPO_CANVAS_ROOT=root;process.env.REPO_CANVAS_DATA_DIR=path.join(root,".repo-canvas");
const store=await import("../repo-canvas/scripts/canvas-store.mjs");const history=await import("../repo-canvas/scripts/canvas-history.mjs");
const {writeSourceJson}=await import("../repo-canvas/scripts/project-sources.mjs");
const rows=[];const emit=(type,payload)=>rows.push(store.createEvent(type,{actor:"fixture",payload}));const areas=[];const entities=[];const work=[];
emit("map.upsert",{projectTitle:"Производство на заказ",projectSummary:"Приём заказа, проверка, производство и передача результата клиенту.",language:"ru",keyFlows:[]});
for(let a=0;a<Math.ceil(count/50);a++){
 const x=(a%4)*4700,y=Math.floor(a/4)*3700;
 areas.push({id:`a${a}`,x,y,width:4500,height:3500,contentWidth:4500,contentHeight:3500,color:"#626975"});emit("area.upsert",{...areas.at(-1),title:`Участок ${a+1}`,note:"Связанный этап производства"});
 for(let i=0;i<50&&a*50+i<count;i++){
  const id=`e${a*50+i}`;const group=i<4;const depth=group?i:4;const rect=group?{x:x+80+i*80,y:y+200+i*130,width:4200-i*160,height:3200-i*240,group:true,headerWidth:420,headerHeight:90,depth}:{x:x+410+(i-4)%6*590,y:y+800+Math.floor((i-4)/6)*270,width:430,height:150,depth};
  const entity={id,areaId:`a${a}`,parentId:i===0?"":`e${a*50+(group?i-1:3)}`,label:group?`Этап подготовки ${a+1}.${i+1}`:i%2?`Подготовка заказа и проверка комплектности ${a+1}.${i}`:`Production quality checks ${a+1}.${i}`,kind:group?"capability":"process",status:"operational",purpose:"Проверяет данные заказа и передаёт следующий результат",...rect};emit("entity.upsert",entity);entities.push({id,...rect,topId:`e${a*50}`});
 }
}
const rects=new Map(entities.map(item=>[item.id,item]));const routes=[];const areaRoutes=[];
const edgeCount=count===250?600:2500;
for(let i=0;i<edgeCount;i++){
 const source=`e${i%count}`,target=`e${(i*7+13+Math.floor(i/count))%count}`;const relation={id:`r${i}`,from:source,to:target,label:"передаёт результат",status:"existing",kind:"data",contract:"Проверенные данные заказа"};emit("relation.upsert",relation);
 const a=rects.get(source),b=rects.get(target);const start={x:a.x+a.width,y:a.y+a.height/2},end={x:b.x,y:b.y+b.height/2};
 if(source!==target)routes.push({id:`relation:entity:${source}->entity:${target}:existing`,source:`entity:${source}`,target:`entity:${target}`,sourceAreaId:`a${Math.floor((i%count)/50)}`,targetAreaId:`a${Math.floor(Number(target.slice(1))/50)}`,relationId:relation.id,relations:[relation],type:"relation",status:"existing",color:"#626975",label:relation.label,points:[start,{x:(start.x+end.x)/2,y:start.y},{x:(start.x+end.x)/2,y:end.y},end]});
}
const pairs=new Map();for(const route of routes){if(route.sourceAreaId===route.targetAreaId)continue;const id=`area-relation:area:${route.sourceAreaId}->area:${route.targetAreaId}:existing`;if(!pairs.has(id)){const a=areas.find(item=>item.id===route.sourceAreaId),b=areas.find(item=>item.id===route.targetAreaId);pairs.set(id,{id,source:`area:${a.id}`,target:`area:${b.id}`,type:"area-relation",status:"existing",sourceAreaId:a.id,targetAreaId:b.id,color:"#626975",label:"Передача заказа",relations:[],points:[{x:a.x+a.width,y:a.y+100},{x:b.x,y:a.y+100},{x:b.x,y:b.y+100}]});}pairs.get(id).relations.push(...route.relations);}areaRoutes.push(...pairs.values());
for(let i=0;i<(count===250?6:20);i++){const target=`e${(i*50+8)%count}`,rect=rects.get(target),id=`w${i}`;const position={id,x:rect.x+Math.floor(i/Math.ceil(count/50))*320,y:rect.y-95,width:260,height:66};work.push(position);emit("work.upsert",{...position,title:"Проверяет работу участка",status:"active",targets:[target]});routes.push({id:`work-edge:${id}:${target}`,source:`entity:${target}`,target:`work:${id}`,type:"work",status:"active",label:"",color:"#245fd1",sourceAreaId:`a${Math.floor(Number(target.slice(1))/50)}`,targetAreaId:`work:${id}`,points:[{x:rect.x,y:rect.y},{x:rect.x,y:position.y+position.height}]});}
store.appendEvents(rows);
for(let i=0;i<extraCheckpoints;i++)store.appendEvent(store.createEvent("entity.upsert",{actor:"fixture",payload:{...rows.find(row=>row.type==="entity.upsert"&&row.payload.id===`e${i%count}`).payload,note:`Уточнение ${i}`}}));
const state=store.getSnapshot();const geometry={areas,entities,work,routes,areaRoutes,world:{x:0,y:0,width:Math.min(4,areas.length)*4700,height:Math.ceil(areas.length/4)*3700},fingerprint:layoutFingerprint(state),format:1};
const index=await history.historyIndex();await history.saveCheckpointGeometry(index.checkpoints.at(-1).id,state.revision,geometry);
const reference=JSON.parse(fs.readFileSync(path.join(store.dataDirectory,"history","geometry",`${index.checkpoints.at(-1).id}.json`),"utf8"));
for(const point of index.checkpoints.slice(0,-1))writeSourceJson(path.join(store.dataDirectory,"history","geometry",point.id+".json"),{...reference,id:point.id,revision:point.revision});
console.log(JSON.stringify({root,entities:count,relations:edgeCount,checkpoints:index.checkpoints.length}));
