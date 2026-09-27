async page=>{
  const original=await page.evaluate(async()=>(await fetch('/api/state')).json());
  const title='Проверка очень длинного названия текущей работы: обновление карты, связей и пояснений для пользователя';
  const work={id:'ui-contract-work',title,actor:'codex',status:'active',targets:[original.entities[0].id],updatedAt:new Date().toISOString()};
  const fixture={...original,work:[work]};
  const check=(ok,message)=>{if(!ok)throw new Error(message);};
  await page.route('**/api/state*',route=>route.fulfill({contentType:'application/json',body:JSON.stringify(fixture)}));
  await page.route('**/api/history/geometry',route=>route.fulfill({contentType:'application/json',body:'{"saved":false}'}));
  try {
    await page.setViewportSize({width:1600,height:1000});await page.reload();await page.locator('.work-node').waitFor();
    await page.getByRole('button',{name:'Показать всё',exact:true}).click();await page.waitForTimeout(500);
    const geometry=await page.evaluate(()=>{const rail=document.querySelector('.left-rail').getBoundingClientRect(),card=document.querySelector('.now-list button').getBoundingClientRect(),work=document.querySelector('.work-node'),text=work.querySelector('strong');const zoom=new DOMMatrix(getComputedStyle(document.querySelector('.react-flow__viewport')).transform).a;return{railFits:card.left>=rail.left&&card.right<=rail.right,work:work.getBoundingClientRect().toJSON(),font:parseFloat(getComputedStyle(text).fontSize)*zoom,animation:getComputedStyle(work.querySelector('i')).animationName};});
    check(geometry.railFits,'Work card exceeds the rail');check(geometry.work.width>=30&&geometry.work.height>=14&&geometry.font>=9,`Work disappeared at overview scale: ${JSON.stringify(geometry)}`);
    check(geometry.animation!=='none','Active work has no activity signal');
    await page.locator('.work-node').hover();await page.locator('.reading-preview').waitFor();
    check((await page.locator('.reading-preview').innerText()).includes(title),'Full work title is unavailable at overview scale');
    await page.screenshot({path:'output/playwright/recovery-work.png'});
    fixture.work=[{...work,status:'done'}];await page.reload();await page.locator('.area-node').first().waitFor();
    check(await page.locator('.work-node').count()===0,'Completed work left a ghost card');
    return {longCardFits:true,workReadableInOverview:true,workFont:geometry.font,activitySignal:true,fullTitleOnHover:true,completedRemoved:true,fixtureOnly:true};
  } finally {await page.unroute('**/api/state*');await page.unroute('**/api/history/geometry');await page.reload();}
}
