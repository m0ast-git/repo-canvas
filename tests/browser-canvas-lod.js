export function inspectCanvasDetail() {
  const frame=document.querySelector('.canvas-wrap')?.getBoundingClientRect();
  const viewport=document.querySelector('.react-flow__viewport');
  const matrix=getComputedStyle(viewport).transform.match(/matrix\(([^)]+)\)/)[1].split(',').map(Number);
  const nodes=[...document.querySelectorAll('.react-flow__node')].map(node=>{
    const bounds=node.getBoundingClientRect(),card=node.querySelector('.canvas-card'),ink=card?.getBoundingClientRect();
    return {id:node.dataset.id,position:node.style.transform,width:node.style.width,height:node.style.height,detail:card?.dataset.detail,descendants:card?.querySelectorAll('*').length||0,aligned:!ink||Math.abs(ink.width-bounds.width)<1&&Math.abs(ink.height-bounds.height)<1};
  });
  return {zoom:matrix[0],nodes,renderedNodes:nodes.length,cardDom:nodes.reduce((n,node)=>n+node.descendants,0),listReplacement:!!document.querySelector('.project-overview'),blocked:document.querySelectorAll('[data-blocked-route]').length,paths:document.querySelectorAll('.route-path').length,overflow:document.documentElement.scrollWidth>innerWidth,frame:{width:frame.width,height:frame.height}};
}
