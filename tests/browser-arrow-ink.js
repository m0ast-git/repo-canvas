// Run against the actual SVG after rendering; no application state is changed.
export function inspectArrowInk() {
  const overview=document.querySelector('.project-overview');
  const paths=[...document.querySelectorAll(overview?'.overview-connection':'.route-path')];
  const transform=document.querySelector('.react-flow__viewport');
  const zoom=overview?1:Number(getComputedStyle(transform).transform.match(/matrix\(([^,]+)/)?.[1]||1);
  const issues=[],tips=[];
  for(const path of paths){
    if(/NaN|Infinity|undefined/.test(path.getAttribute('d')||'')){issues.push({error:'Invalid route coordinates',path:path.getAttribute('d')});continue;}
    const coords=(path.getAttribute('d')||'').match(/[-+]?\d*\.?\d+(?:e[-+]?\d+)?/gi)?.map(Number)||[];
    const owner=path.closest('[data-route-source]');
    const origin=document.querySelector(overview?'.overview-board':'.canvas-wrap').getBoundingClientRect();
    const matrix=overview?[1,0,0,1,0,0]:getComputedStyle(transform).transform.match(/matrix\(([^)]+)\)/)[1].split(',').map(Number);
    for(const [end,xy] of [['source',coords.slice(0,2)],['target',coords.slice(-2)]]) {
      const id=owner?.getAttribute('data-route-'+end);
      const node=[...document.querySelectorAll(overview?'[data-overview-id]':'.react-flow__node')].find(element=>element.getAttribute(overview?'data-overview-id':'data-id')===id);
      const card=overview?node:node?.querySelector('.rc-module,.group-contour');if(!card||xy.length!==2)continue;
      const bounds=card.getBoundingClientRect(),point={x:origin.left+xy[0]*matrix[0]+matrix[4],y:origin.top+xy[1]*matrix[3]+matrix[5]};
      const inside=point.x>=bounds.left-2&&point.x<=bounds.right+2&&point.y>=bounds.top-2&&point.y<=bounds.bottom+2;
      const distance=Math.min(Math.abs(point.x-bounds.left),Math.abs(point.x-bounds.right),Math.abs(point.y-bounds.top),Math.abs(point.y-bounds.bottom));
      if(!inside||distance>2)issues.push({id,end,error:'Line endpoint is detached from the rendered card',point,bounds:{left:bounds.left,top:bounds.top,right:bounds.right,bottom:bounds.bottom}});
    }
    const ink=getComputedStyle(path).stroke;
    const gradientId=ink.match(/#([^)'"\s]+)/)?.[1];
    const stops=gradientId?[...document.getElementById(gradientId)?.querySelectorAll('stop')||[]]:[];
    for(const end of ['start','end']) {
      const reference=path.getAttribute('marker-'+end);if(!reference)continue;
      const id=reference.match(/#([^)'"\s]+)/)?.[1],marker=document.getElementById(id),head=marker?.querySelector('path');
      if(!head){issues.push({id,error:'Missing arrowhead'});continue;}
      const filled=getComputedStyle(head).fill!=="none";
      const color=filled?getComputedStyle(head).fill:getComputedStyle(head).stroke;
      const adjacent=stops.length?getComputedStyle(end==='start'?stops[0]:stops.at(-1)).stopColor:ink;
      const length=Number(marker.getAttribute('markerWidth'))*zoom;
      const viewBox=marker.getAttribute('viewBox').split(/\s+/).map(Number);
      const shaft=Number.parseFloat(getComputedStyle(path).strokeWidth)*zoom;
      const headWidth=Number.parseFloat(getComputedStyle(head).strokeWidth)*Number(marker.getAttribute('markerWidth'))/viewBox[2]*zoom;
      if(color!==adjacent)issues.push({id,error:'Arrow and adjacent line have different colors',color,adjacent});
      if(!filled&&Math.abs(headWidth-shaft)>.05)issues.push({id,error:'Arrow and line have different stroke widths',headWidth,shaft});
      if(length<.49||length>8.05)issues.push({id,error:'Arrow size is outside its readable LOD range',length});
      if(marker.getAttribute('refX')!=='8'||marker.getAttribute('refY')!=='0'||marker.getAttribute('orient')!=='auto-start-reverse')issues.push({id,error:'Tip does not share the line endpoint and tangent'});
      tips.push({end,color,length,shaft,headWidth});
    }
  }
  return {scene:overview?'overview':'detail',zoom,paths:paths.length,tips:tips.length,issues,measurements:tips};
}
