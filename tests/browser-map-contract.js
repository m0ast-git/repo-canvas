async page => {
  const check=(ok,message)=>{if(!ok)throw new Error(message);};
  await page.setViewportSize({width:1600,height:1000});
  await page.getByRole('button',{name:'Показать всё',exact:true}).click();
  await page.locator('.zoom-tiers').getByRole('button',{name:'Элементы',exact:true}).click();await page.waitForTimeout(600);
  const point=await page.evaluate(()=>{
    const frame=document.querySelector('.canvas-wrap').getBoundingClientRect();
    for(const line of document.querySelectorAll('.route-path'))for(const t of [.6,.4,.8,.2]){
      const p=line.getPointAtLength(line.getTotalLength()*t),s=new DOMPoint(p.x,p.y).matrixTransform(line.getScreenCTM());
      if(s.x>frame.left+30&&s.x<frame.right-30&&s.y>frame.top+50&&s.y<frame.bottom-50&&document.elementFromPoint(s.x,s.y)?.closest('.react-flow__edge'))return{x:s.x,y:s.y};
    }
  });check(point,'No visible route');
  await page.mouse.click(point.x,point.y);await page.waitForTimeout(300);
  const selected=await page.locator('.app-shell').getAttribute('data-selection');
  check(selected.startsWith('route:'),'Click did not pin a connection');
  check(await page.locator('.is-focus-node').count()>=2,'Connected objects are not highlighted');
  const blank=await page.evaluate(()=>{const b=document.querySelector('.canvas-wrap').getBoundingClientRect();for(let x=b.right-40;x>b.left+60;x-=70)for(let y=b.bottom-50;y>b.top+50;y-=70)if(document.elementFromPoint(x,y)?.classList.contains('react-flow__pane'))return{x,y};});check(blank,'No blank canvas');
  await page.mouse.move(blank.x,blank.y);await page.mouse.down();await page.mouse.move(blank.x-80,blank.y-30,{steps:5});
  check(await page.locator('.route-label:not(.is-interaction-hidden)').count()===0,'Labels float during pan');
  await page.mouse.up();await page.waitForTimeout(400);
  check(await page.locator('.app-shell').getAttribute('data-selection')===selected,'Pan cleared the pinned route');
  const chips=await page.evaluate(()=>{
    const b=document.querySelector('.canvas-wrap').getBoundingClientRect();
    return [...document.querySelectorAll('.endpoint-chip')].map(node=>{const r=node.getBoundingClientRect();return{inside:r.left>=b.left&&r.top>=b.top&&r.right<=b.right&&r.bottom<=b.bottom,rect:r.toJSON(),radius:parseFloat(getComputedStyle(node).borderRadius)};});
  });check(chips.every(chip=>chip.inside&&chip.rect.width>chip.rect.height&&chip.radius<10),'Offscreen nodes clipped or rounded into pills');
  for(let i=0;i<chips.length;i++)for(const other of chips.slice(i+1)){const a=chips[i].rect,b=other.rect;check(a.right<=b.left||b.right<=a.left||a.bottom<=b.top||b.bottom<=a.top,'Offscreen nodes overlap');}
  await page.screenshot({path:'output/playwright/recovery-pinned.png'});
  await page.mouse.click(blank.x-80,blank.y-30);await page.waitForTimeout(200);
  check(await page.locator('.app-shell').getAttribute('data-selection')==='','Blank click failed to clear selection');
  check(await page.locator('.route-path.is-active').count()===0,'Route hover remained after blank click');
  await page.getByRole('button',{name:'Легенда',exact:true}).click();await page.locator('.legend').waitFor();
  check(await page.locator('.legend .route-planned').count()>0&&await page.locator('.legend .route-live-work').count()>0,'Legend omits planned or live work');
  await page.screenshot({path:'output/playwright/recovery-legend.png'});
  await page.getByRole('button',{name:'Легенда',exact:true}).click();
  await page.getByRole('button',{name:'Тёмная тема',exact:true}).click();
  await page.getByRole('button',{name:'Показать всё',exact:true}).click();await page.waitForTimeout(350);
  await page.screenshot({path:'output/playwright/recovery-dark.png'});
  await page.getByRole('button',{name:'Светлая тема',exact:true}).click();
  await page.setViewportSize({width:390,height:844});await page.waitForTimeout(300);
  await page.screenshot({path:'output/playwright/recovery-mobile.png'});
  check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Mobile horizontal overflow');
  await page.setViewportSize({width:1600,height:1000});
  return {routePinned:true,connectedObjectsHighlighted:true,panKeepsPin:true,labelsHiddenDuringPan:true,offscreenNodes:chips.length,blankClears:true,legend:true,themes:true,mobile:true};
}
