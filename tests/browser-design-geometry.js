// Read-only rendered geometry probe, passed to the selected browser's evaluate API.
export function inspectDesignGeometry() {
  const canvas=document.querySelector('.canvas-wrap'),viewport=document.querySelector('.react-flow__viewport');
  if(!canvas||!viewport)return {error:'Canvas is unavailable'};
  const frame=canvas.getBoundingClientRect(),matrix=getComputedStyle(viewport).transform.match(/matrix\(([^)]+)\)/)?.[1].split(',').map(Number)||[1,0,0,1,0,0];
  const screen=point=>({x:frame.left+point.x*matrix[0]+matrix[4],y:frame.top+point.y*matrix[3]+matrix[5]});
  const texts=[...document.querySelectorAll('.area-node>header h2,.area-node>header p,.group-node>header strong,.group-node>header p,.person-overview strong')].filter(element=>getComputedStyle(element).visibility!=='hidden').map(element=>({name:element.textContent,rect:element.getBoundingClientRect()})).filter(item=>item.rect.width&&item.rect.height);
  const cards=[...document.querySelectorAll('.rc-module')].map(element=>({name:element.querySelector('strong')?.textContent,rect:element.getBoundingClientRect()}));
  const contains=(rect,point,padding=0)=>point.x>rect.left-padding&&point.x<rect.right+padding&&point.y>rect.top-padding&&point.y<rect.bottom+padding;
  const headerCrossings=[],cardCrossings=[],clearanceCrossings=[],invalidPaths=[];
  for(const path of document.querySelectorAll('.route-path')){
    if(/NaN|Infinity|undefined/.test(path.getAttribute('d')||'')){invalidPaths.push(path.getAttribute('d'));continue;}
    const tokens=(path.getAttribute('d')||'').match(/[MLQC]|[-+]?\d*\.?\d+(?:e[-+]?\d+)?/gi)||[],points=[];
    let current={x:0,y:0},index=0;
    while(index<tokens.length){
      const command=tokens[index++];
      if(command==='M'){current={x:Number(tokens[index++]),y:Number(tokens[index++])};points.push(screen(current));continue;}
      const control=['Q','C'].includes(command)?{x:Number(tokens[index++]),y:Number(tokens[index++])}:null;
      const control2=command==='C'?{x:Number(tokens[index++]),y:Number(tokens[index++])}:null;
      const target={x:Number(tokens[index++]),y:Number(tokens[index++])};
      const steps=Math.max(2,Math.ceil(Math.hypot(target.x-current.x,target.y-current.y)*matrix[0]/2));
      for(let step=1;step<=steps;step++){
        const t=step/steps;
        points.push(screen(control2?{x:(1-t)**3*current.x+3*(1-t)**2*t*control.x+3*(1-t)*t*t*control2.x+t**3*target.x,y:(1-t)**3*current.y+3*(1-t)**2*t*control.y+3*(1-t)*t*t*control2.y+t**3*target.y}:control?{x:(1-t)**2*current.x+2*(1-t)*t*control.x+t*t*target.x,y:(1-t)**2*current.y+2*(1-t)*t*control.y+t*t*target.y}:{x:current.x+(target.x-current.x)*t,y:current.y+(target.y-current.y)*t}));
      }
      current=target;
    }
    const visible=points.filter(point=>contains(frame,point)),edge=path.closest('[data-id]')?.getAttribute('data-id');
    for(const text of texts){if(visible.some(point=>contains(text.rect,point)))headerCrossings.push({edge,label:text.name});else if(visible.some(point=>contains(text.rect,point,11)))clearanceCrossings.push({edge,label:text.name});}
    for(const card of cards){if(!points.length||contains(card.rect,points[0],2)||contains(card.rect,points.at(-1),2))continue;if(visible.some(point=>contains(card.rect,point,-2)))cardCrossings.push({edge,label:card.name});}
  }
  return {headerCrossings,clearanceCrossings,cardCrossings,invalidPaths,blocked:document.querySelectorAll('[data-blocked-route]').length,paths:document.querySelectorAll('.route-path').length,doubleArrows:document.querySelectorAll('.route-path[marker-start][marker-end]').length,overflow:[...document.querySelectorAll('.rc-module')].filter(element=>element.scrollHeight>element.clientHeight+1).map(element=>element.querySelector('strong')?.textContent),canvas:getComputedStyle(canvas).backgroundColor,font:getComputedStyle(document.documentElement).fontFamily};
}
