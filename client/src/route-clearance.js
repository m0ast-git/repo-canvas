// Libavoid can compress a lane below the requested gap near a shared endpoint.
// Shift only interior orthogonal segments, retaining endpoints and obstacle clearance.
function segments(points) {
  return points.slice(1).map((b,i)=>{
    const a=points[i],axis=Math.abs(a.y-b.y)<.01?"x":"y",other=axis==="x"?"y":"x";
    return {i,axis,other,level:a[other],from:Math.min(a[axis],b[axis]),to:Math.max(a[axis],b[axis])};
  }).filter(segment=>segment.to-segment.from>.01);
}
function conflict(a,b,gap) {
  const distance=Math.abs(a.level-b.level);
  return a.axis===b.axis && Math.min(a.to,b.to)-Math.max(a.from,b.from)>(distance<.05?1:20) && distance<gap-.01;
}
function enters(a,b,box) {
  const horizontal=Math.abs(a.y-b.y)<.01;
  return horizontal
    ? a.y>box.y-4+.05&&a.y<box.y+box.height+4-.05&&Math.min(a.x,b.x)<box.x+box.width+4-.05&&Math.max(a.x,b.x)>box.x-4+.05
    : a.x>box.x-4+.05&&a.x<box.x+box.width+4-.05&&Math.min(a.y,b.y)<box.y+box.height+4-.05&&Math.max(a.y,b.y)>box.y-4+.05;
}
export function findRouteOverlaps(routes, minimumLength=1) {
  const indexed=routes.map(route=>({route,segments:segments(route.points)})),result=[];
  for(let i=0;i<indexed.length;i++)for(let j=i+1;j<indexed.length;j++) {
    for(const a of indexed[i].segments)for(const b of indexed[j].segments) {
      const length=Math.min(a.to,b.to)-Math.max(a.from,b.from);
      if(a.axis===b.axis&&Math.abs(a.level-b.level)<.05&&length>minimumLength)result.push({source:indexed[i].route.id,target:indexed[j].route.id,sourceSegment:a.i,targetSegment:b.i,length});
    }
  }
  return result;
}
export function separateParallelRoutes(routes,obstacles=[],gap=12) {
  const result=routes.map(route=>({...route,points:route.points.map(point=>({...point}))}));
  for(const route of result) {
    const others=result.filter(other=>other!==route).flatMap(other=>segments(other.points));
    const splitEnd=(reverse=false)=>{
      const points=reverse?[...route.points].reverse():route.points;
      if(points.length<2)return;
      const a=points[0],b=points[1],segment=segments(points)[0];
      if(!segment)return;
      if(segment.to-segment.from<=32||!others.some(other=>conflict(segment,other,gap)))return;
      const length=Math.hypot(b.x-a.x,b.y-a.y),stub={x:a.x+(b.x-a.x)*16/length,y:a.y+(b.y-a.y)*16/length};
      points.splice(1,0,stub,{...stub});route.points=reverse?points.reverse():points;
    };
    splitEnd();splitEnd(true);
  }
  const cache=new Map(result.map(route=>[route,segments(route.points)]));
  for(let pass=0;pass<8;pass++) {
    let changed=false;
    for(const route of result) {
      const others=result.filter(other=>other!==route).flatMap(other=>cache.get(other));
      const score=items=>{let total=0;for(const a of items)for(const b of others)if(conflict(a,b,gap))total+=(Math.min(a.to,b.to)-Math.max(a.from,b.from))*(gap-Math.abs(a.level-b.level));return total;};
      for(const segment of segments(route.points)) {
        const {i,other}=segment;if(i===0||i+1===route.points.length-1)continue;
        const conflicts=others.filter(b=>conflict(segment,b,gap));if(!conflicts.length)continue;
        const levels=[...new Set(conflicts.flatMap(b=>Array.from({length:12},(_,i)=>[b.level-gap*(i+1),b.level+gap*(i+1)]).flat()))].sort((a,b)=>Math.abs(a-segment.level)-Math.abs(b-segment.level)||a-b);
        const beforeScore=score(segments(route.points).filter(s=>s.i>=i-1&&s.i<=i+1));
        for(const level of levels) {
          const points=[...route.points];points[i]={...points[i],[other]:level};points[i+1]={...points[i+1],[other]:level};
          const affected=[i-1,i,i+1];
          if(affected.some(index=>Math.abs(points[index].x-points[index+1].x)>.01&&Math.abs(points[index].y-points[index+1].y)>.01))continue;
          if(score(segments(points).filter(s=>s.i>=i-1&&s.i<=i+1))>=beforeScore)continue;
          if(affected.some(index=>obstacles.some(box=>!(index===0&&box.id===route.source)&&!(index===points.length-2&&box.id===route.target)&&enters(points[index],points[index+1],box))))continue;
          // Endpoint stubs must keep their original direction, even after lane nudging.
          if([0,points.length-2].some(index=>{const a=points[index],b=points[index+1],oldA=route.points[index],oldB=route.points[index+1];return (b.x-a.x)*(oldB.x-oldA.x)+(b.y-a.y)*(oldB.y-oldA.y)<0;}))continue;
          route.points=points;cache.set(route,segments(points));changed=true;break;
        }
      }
    }
    if(!changed)break;
  }
  return result.map(route=>({...route,points:route.points.filter((point,i,points)=>!i||Math.hypot(point.x-points[i-1].x,point.y-points[i-1].y)>.01)}));
}
