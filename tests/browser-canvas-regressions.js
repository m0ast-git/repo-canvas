async(page)=>{
  await page.setViewportSize({width:1600,height:1000});await page.reload();
  await page.locator('.area-node').first().waitFor();
  await page.getByRole('button',{name:'Показать всё',exact:true}).click();await page.waitForTimeout(1500);
  const overview=await page.evaluate(()=>({miniatures:[...document.querySelectorAll('.area-overview path')].reduce((n,p)=>n+(p.getAttribute('d')?.match(/M/g)||[]).length,0),areaBorder:getComputedStyle(document.querySelector('.area-node'),'::before').borderColor}));
  const coveredMiniatures=await page.evaluate(()=>{
    const miniatures=[...document.querySelectorAll('.overview-entity, .area-node>header')].map(node=>node.getBoundingClientRect());
    return [...document.querySelectorAll('.route-label:not(.is-interaction-hidden)')].filter(node=>parseFloat(getComputedStyle(node).opacity)>.1).filter(node=>{const a=node.getBoundingClientRect();return miniatures.some(b=>Math.min(a.right,b.right)-Math.max(a.left,b.left)>1&&Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>1);}).length;
  });
  if(coveredMiniatures)throw new Error(`Relation labels cover ${coveredMiniatures} overview nodes`);
  await page.screenshot({path:'output/playwright/regressions-overview.png'});
  await page.locator('.zoom-tiers').getByRole('button',{name:'Элементы',exact:true}).click();await page.waitForTimeout(500);
  const route=await page.evaluate(()=>{
    const frame=document.querySelector('.canvas-wrap').getBoundingClientRect();
    for(const path of document.querySelectorAll('.route-path')){
      const length=path.getTotalLength();if(length<150)continue;
      for(const t of [.5,.3,.7]){
        const points=[-15,-10,-5,0,5,10,15].map(offset=>{const p=path.getPointAtLength(length*t+offset);const q=new DOMPoint(p.x,p.y).matrixTransform(path.getScreenCTM());return{x:q.x,y:q.y};});
        if(points.every(p=>p.x>frame.left+30&&p.x<frame.right-30&&p.y>frame.top+30&&p.y<frame.bottom-30)&&points.every(p=>document.elementFromPoint(p.x,p.y)?.closest('.react-flow__edge')?.dataset.id===path.closest('.react-flow__edge').dataset.id))
          return {id:path.closest('.react-flow__edge').dataset.id,points};
      }
    }
  });
  if(!route)throw new Error('No visible route for the hover check');
  const states=[];
  for(let i=0;i<42;i++){const p=route.points[i%route.points.length];await page.mouse.move(p.x,p.y);await page.waitForTimeout(20);states.push(await page.locator(`[data-id="${route.id}"] .route-path`).evaluate(e=>e.classList.contains('is-active')));}
  const flickers=states.slice(1).filter((state,i)=>state!==states[i]).length;
  await page.mouse.move(1580,980);await page.waitForTimeout(180);
  const hoverCleared=await page.locator(".route-path.is-active").count()===0;
  const overlaps=await page.evaluate(()=>{
    const segments=[];const zoom=new DOMMatrix(getComputedStyle(document.querySelector(".react-flow__viewport")).transform).a;
    for(const path of document.querySelectorAll('.route-path')){
      const id=path.closest('.react-flow__edge').dataset.id;let previous;
      for(const match of path.getAttribute('d').matchAll(/([MLQ])([^MLQ]*)/g)){
        const n=(match[2].match(/-?\d+(?:\.\d+)?(?:e[-+]?\d+)?/gi)||[]).map(Number);
        const point=match[1]==='Q'?{x:n[2],y:n[3]}:{x:n[0],y:n[1]};
        if(match[1]==='L'&&previous){const horizontal=Math.abs(previous.y-point.y)<.01;segments.push({id,stroke:parseFloat(getComputedStyle(path).strokeWidth)*(getComputedStyle(path).vectorEffect==="non-scaling-stroke"?1:zoom),axis:horizontal?'x':'y',level:horizontal?point.y:point.x,from:horizontal?Math.min(previous.x,point.x):Math.min(previous.y,point.y),to:horizontal?Math.max(previous.x,point.x):Math.max(previous.y,point.y)});}
        previous=point;
      }
    }
    const collisions=[];
    for(let i=0;i<segments.length;i++)for(const b of segments.slice(i+1)){
      const a=segments[i];if(a.id===b.id||a.axis!==b.axis)continue;
      const length=Math.min(a.to,b.to)-Math.max(a.from,b.from),gap=Math.abs(a.level-b.level);
      const visibleGap=gap*zoom-(a.stroke+b.stroke)/2;
      if(length>20&&visibleGap<2)collisions.push({a:a.id,b:b.id,length,gap,visibleGap});
    }
    return collisions;
  });
  await page.screenshot({path:'output/playwright/regressions-detail.png'});
  if(overview.miniatures<1||states.filter(Boolean).length<40||flickers>1||!hoverCleared||overlaps.length)throw new Error(JSON.stringify({overview,states,flickers,hoverCleared,overlaps}));
  return {overview,coveredMiniatures,hover:{samples:states.length,active:states.filter(Boolean).length,flickers,cleared:hoverCleared},overlaps};
}
