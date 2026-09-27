function distanceToSegment(point, a, b) {
  const dx=b.x-a.x,dy=b.y-a.y,length=dx*dx+dy*dy;
  const t=length?Math.max(0,Math.min(1,((point.x-a.x)*dx+(point.y-a.y)*dy)/length)):0;
  return Math.hypot(point.x-a.x-t*dx,point.y-a.y-t*dy);
}

export function hoveredRouteAt(routes, point, zoom, previousId=null) {
  let nearest=null,nearestDistance=Infinity,previousDistance=Infinity;
  for(const route of routes){
    const points=route.points;
    let distance=Infinity;
    for(let i=1;i<(points?.length||0);i++)distance=Math.min(distance,distanceToSegment(point,points[i-1],points[i])*zoom);
    if(route.id===previousId)previousDistance=distance;
    if(distance<nearestDistance){nearest=route.id;nearestDistance=distance;}
  }
  // Keep the current line in the small boundary between neighbouring hit areas.
  if(previousId&&previousDistance<=9&&previousDistance<=nearestDistance+2)return previousId;
  return nearestDistance<=6?nearest:null;
}
