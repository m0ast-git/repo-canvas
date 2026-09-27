async page => {
  if(!page.url().startsWith('http://127.0.0.1:4174/'))throw Error('Use the isolated appearance fixture');
  const check=(ok,message)=>{if(!ok)throw Error(message);};
  const contrast=()=>page.evaluate(()=>{
    const ctx=document.createElement('canvas').getContext('2d');
    const rgba=value=>{ctx.clearRect(0,0,1,1);ctx.fillStyle=value;ctx.fillRect(0,0,1,1);return [...ctx.getImageData(0,0,1,1).data].slice(0,3);};
    const luminance=rgb=>rgb.map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;}).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
    const ratio=(a,b)=>{const x=luminance(rgba(a)),y=luminance(rgba(b));return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);};
    const areas=[...document.querySelectorAll('.area-node')].map(node=>{const css=getComputedStyle(node,'::before');return {id:node.closest('[data-id]').dataset.id,contour:ratio(css.borderColor,css.backgroundColor),title:ratio(getComputedStyle(node.querySelector('h2')).color,css.backgroundColor)};});
    const cards=[...document.querySelectorAll('.canvas-card')].map(node=>{const css=getComputedStyle(node),text=node.querySelector('strong');return {id:node.closest('[data-id]').dataset.id,contour:ratio(css.borderColor,css.backgroundColor),title:ratio(getComputedStyle(text).color,css.backgroundColor)};});
    return {areas,cards,canvas:getComputedStyle(document.querySelector('.canvas-wrap')).backgroundColor};
  });
  await page.keyboard.press('Escape');
  const reports=[];
  for(const theme of ['light','dark']){
    const toggle=page.getByRole('button',{name:theme==='light'?'Светлая тема':'Тёмная тема',exact:true});if(await toggle.count())await toggle.click();
    await page.getByRole('button',{name:'Показать всю карту',exact:true}).click();
    await page.waitForTimeout(300);
    const report=await contrast();
    for(const item of [...report.areas,...report.cards]){
      check(item.contour>=3,`${theme} contour has low contrast: ${JSON.stringify(item)}`);
      check(item.title>=4.5,`${theme} title has low contrast: ${JSON.stringify(item)}`);
    }
    if(theme==='light')check(report.canvas==='rgb(255, 255, 255)','Light canvas was tinted');
    reports.push({theme,...report});
  }
  await page.unroute('**/api/state*');await page.unroute('**/api/revision');await page.unroute('**/api/history/geometry');
  await page.reload();await page.locator('.area-node').first().waitFor();
  const expand=page.locator('.timeline-heading button[aria-expanded=false]');if(await expand.count())await expand.click();
  await page.locator('.checkpoint-list button').first().click();
  await page.waitForFunction(()=>!document.querySelector('.live-pill')?.classList.contains('is-live'));
  await page.getByRole('button',{name:'Показать всю карту',exact:true}).click();
  await page.waitForTimeout(300);
  const history=await page.evaluate(()=>({
    indicators:[...document.querySelectorAll('.work-activity')].map(node=>({pulsing:node.dataset.pulsing,label:node.getAttribute('aria-label'),animation:getComputedStyle(node.querySelector('i'),'::after').animationName})),
    run:document.querySelector('.canvas-wrap').dataset.routingRun,
    paths:document.querySelectorAll('.route-path').length
  }));
  check(history.indicators.length>0,'Historical fixture has no work to verify');
  check(history.indicators.every(item=>item.pulsing==='false'&&item.animation==='none'&&item.label.includes('на этом снимке')),'History claims that past work is running now');
  check(history.run==='0'&&history.paths>0,'History lost saved routes or launched the router');
  await page.screenshot({path:'output/playwright/appearance-history.png'});
  await page.locator('.live-pill').click();
  await page.setViewportSize({width:390,height:844});
  await page.getByRole('button',{name:'Показать всю карту',exact:true}).click();
  await page.waitForTimeout(300);
  const narrow=await page.evaluate(()=>({overflow:document.documentElement.scrollWidth>innerWidth,paths:document.querySelectorAll('.route-path').length}));
  check(!narrow.overflow&&narrow.paths>0,'Narrow view lost the map or overflowed');
  await page.screenshot({path:'output/playwright/appearance-narrow.png'});
  return {reports,history,narrow};
}
