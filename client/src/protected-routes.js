// Presentation geometry around measured text. Stored user positions remain intact.
const EPS = .05;
const inside = (point, box) => point.x > box.x + EPS && point.x < box.x + box.width - EPS && point.y > box.y + EPS && point.y < box.y + box.height - EPS;
export function segmentEntersBox(a, b, box) {
  if (Math.abs(a.y-b.y) < EPS) return a.y > box.y+EPS && a.y < box.y+box.height-EPS && Math.max(a.x,b.x)>box.x+EPS && Math.min(a.x,b.x)<box.x+box.width-EPS;
  if (Math.abs(a.x-b.x) < EPS) return a.x > box.x+EPS && a.x < box.x+box.width-EPS && Math.max(a.y,b.y)>box.y+EPS && Math.min(a.y,b.y)<box.y+box.height-EPS;
  // Liang–Barsky for a moving endpoint's temporary diagonal.
  let low=0,high=1;
  const dx=b.x-a.x,dy=b.y-a.y;
  for(const [p,q] of [[-dx,a.x-box.x],[dx,box.x+box.width-a.x],[-dy,a.y-box.y],[dy,box.y+box.height-a.y]]){
    if(Math.abs(p)<EPS){if(q<=EPS)return false;continue;}
    const t=q/p;if(p<0)low=Math.max(low,t);else high=Math.min(high,t);
  }
  return high-low>EPS && high>0 && low<1;
}
export const pathEntersBoxes = (points, boxes) => points.some((point,index)=>index>0&&boxes.some(box=>segmentEntersBox(points[index-1],point,box)));
const expand = (box, gap) => ({...box,x:box.x-gap,y:box.y-gap,width:box.width+gap*2,height:box.height+gap*2});
const distance = (a,b) => Math.abs(a.x-b.x)+Math.abs(a.y-b.y);
export function compactRoutePoints(points) {
  const output=[];
  for(const point of points){
    if(output.length&&distance(output.at(-1),point)<EPS){output[output.length-1]=point;continue;}
    while(output.length>1){
      const a=output.at(-2),b=output.at(-1);
      if(!(Math.abs(a.x-b.x)<EPS&&Math.abs(b.x-point.x)<EPS||Math.abs(a.y-b.y)<EPS&&Math.abs(b.y-point.y)<EPS))break;
      output.pop();
    }
    output.push(point);
  }
  return output;
}
function endpoint(point, next, rect, zones) {
  if(!zones.some(box=>inside(point,box)))return point;
  if(!rect)return null;
  const candidates=[];
  for(const fraction of [0,.15,.3,.5,.7,.85,1])candidates.push(
    {x:rect.x,y:rect.y+rect.height*fraction},{x:rect.x+rect.width,y:rect.y+rect.height*fraction},
    {x:rect.x+rect.width*fraction,y:rect.y},{x:rect.x+rect.width*fraction,y:rect.y+rect.height});
  return candidates.filter(candidate=>!zones.some(box=>inside(candidate,box))).sort((a,b)=>distance(a,point)+distance(a,next)*.1-distance(b,point)-distance(b,next)*.1)[0]||null;
}
function outsidePort(point,rect,gap) {
  if(!rect)return point;
  return [{x:rect.x-gap,y:point.y},{x:rect.x+rect.width+gap,y:point.y},{x:point.x,y:rect.y-gap},{x:point.x,y:rect.y+rect.height+gap}].sort((a,b)=>distance(a,point)-distance(b,point))[0];
}
function findPath(start,end,boxes) {
  const xs=[...new Set([start.x,end.x,...boxes.flatMap(box=>[box.x,box.x+box.width])])].sort((a,b)=>a-b);
  const ys=[...new Set([start.y,end.y,...boxes.flatMap(box=>[box.y,box.y+box.height])])].sort((a,b)=>a-b);
  const width=xs.length, startId=ys.indexOf(start.y)*width+xs.indexOf(start.x), endId=ys.indexOf(end.y)*width+xs.indexOf(end.x);
  // The incoming axis is part of the search state: a bend has a visible cost.
  // Equal-length staircase routes must not beat a clean two-bend route.
  const startKey=startId*3, scores=new Map([[startKey,0]]), previous=new Map(), queue=[];
  const push=item=>{queue.push(item);let i=queue.length-1;while(i){const parent=(i-1)>>1;if(queue[parent].score<=item.score)break;queue[i]=queue[parent];i=parent;}queue[i]=item;};
  const pop=()=>{const first=queue[0],last=queue.pop();if(queue.length){let i=0;while(i*2+1<queue.length){let child=i*2+1;if(child+1<queue.length&&queue[child+1].score<queue[child].score)child++;if(queue[child].score>=last.score)break;queue[i]=queue[child];i=child;}queue[i]=last;}return first;};
  const point=id=>({x:xs[id%width],y:ys[Math.floor(id/width)]});
  push({id:startId,key:startKey,axis:0,cost:0,score:distance(start,end)});
  const checked=new Map();
  while(queue.length){
    const item=pop();if(item.cost!==scores.get(item.key))continue;
    if(item.id===endId){const result=[];for(let key=item.key;key!==undefined;key=previous.get(key))result.push(point(Math.floor(key/3)));return compactRoutePoints(result.reverse());}
    const x=item.id%width,y=Math.floor(item.id/width),from=point(item.id);
    for(const [nx,ny] of [[x-1,y],[x+1,y],[x,y-1],[x,y+1]]){
      if(nx<0||ny<0||nx>=width||ny>=ys.length)continue;
      const id=ny*width+nx,to=point(id),segmentKey=Math.min(id,item.id)+":"+Math.max(id,item.id);
      let blocked=checked.get(segmentKey);if(blocked===undefined){blocked=boxes.some(box=>inside(to,box)||segmentEntersBox(from,to,box));checked.set(segmentKey,blocked);}
      if(blocked)continue;
      const axis=nx===x?2:1,key=id*3+axis;
      const cost=item.cost+distance(from,to)+(item.axis&&item.axis!==axis?40:0);
      if(cost>=(scores.get(key)??Infinity))continue;
      scores.set(key,cost);previous.set(key,item.key);push({id,key,axis,cost,score:cost+distance(to,end)});
    }
  }
  return null;
}

export function protectRouteHeaders(route, headers, nodeBoxes = [], zoom = 1) {
  if(!route.points?.length)return route;
  // The extra corner radius prevents the rounded SVG bend cutting the safe zone.
  // At low LOD, a screen-sized halo can engulf an entire node and its ports.
  // Retain geometric clearance for the simplified header instead.
  const zones=headers.filter(box=>!box.nodeId?.startsWith('entity:')||(box.nodeId!==route.source&&box.nodeId!==route.target)).map(box=>expand(box,12));
  // Endpoints touch their own node boundary; the rest of the line must stay
  // outside it. Lane nudging can otherwise reverse a north port into the label.
  if(!pathEntersBoxes(route.points,[...zones,...nodeBoxes]))return route;
  const byId=new Map(nodeBoxes.map(box=>[box.id,box]));
  const source=endpoint(route.points[0],route.points[1],byId.get(route.source)||route.sourceBase,zones);
  const target=endpoint(route.points.at(-1),route.points.at(-2),byId.get(route.target)||route.targetBase,zones);
  if(!source||!target)return {...route,points:[],label:"Нет места для связи рядом с подписью",blockedByHeader:true};
  const gap=18,boxes=[...zones,...nodeBoxes.map(box=>expand(box,gap))];
  const sourcePort=outsidePort(source,byId.get(route.source),gap),targetPort=outsidePort(target,byId.get(route.target),gap);
  const points=findPath(sourcePort,targetPort,boxes);
  return points?{...route,points:compactRoutePoints([source,...points,target]),headerProtected:true}:{...route,points:[],label:"Нет места для связи рядом с подписью",blockedByHeader:true};
}
