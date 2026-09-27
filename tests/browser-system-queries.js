async page => {
  if(!page.url().startsWith('http://127.0.0.1:4174/'))throw Error('Use the isolated system fixture');
  const comment='Комментарий после переноса кеша '+Date.now();
  const comparisons=[];const count=request=>{if(request.url().includes('/api/history/compare?'))comparisons.push(request.url());};
  const state=()=>page.evaluate(async()=>(await fetch('/api/state')).json());
  page.on('request',count);
  try {
    await page.locator('.live-pill').click();
    await page.getByRole('button',{name:'Предыдущий чекпоинт',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('.app-shell')?.dataset.checkpoint!=='live');
    await page.locator('.timeline-heading button[aria-expanded=false]').click();
    const pending=page.waitForResponse(response=>response.url().includes('/api/history/compare?'));
    await page.getByRole('button',{name:'Сравнивать от выбранного',exact:true}).click();await pending;
    await page.getByRole('button',{name:'Предыдущий чекпоинт',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('.comparison-range'));
    await page.waitForTimeout(250);
    const selected=await page.locator('.app-shell').getAttribute('data-checkpoint');
    const before=await state();const initialRequests=comparisons.length;
    await page.evaluate(async s=>{const r=await fetch('/api/rename',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({canvasRevision:s.revision,kind:'entity',id:'module-1',values:{title:'Проверка данных '+s.revision,description:'Проверяет заявку'}})});if(!r.ok)throw Error(await r.text());},before);
    await page.waitForFunction(()=>document.querySelector('.live-pill')?.textContent.includes('+'));
    await page.waitForTimeout(1300);
    if(comparisons.length!==initialRequests)throw Error('Live invalidated fixed historical comparison');
    if(await page.locator('.app-shell').getAttribute('data-checkpoint')!==selected)throw Error('Live replaced selected history');
    await page.getByRole('textbox',{name:'Комментарий к прошлому',exact:true}).fill(comment);
    await page.getByRole('button',{name:'Добавить',exact:true}).click();
    await page.getByText(comment,{exact:true}).waitFor();
    await page.getByRole('button',{name:'Убрать сравнение',exact:true}).click();
    const offlineStart=Date.now();
    await page.route('**/api/revision',route=>route.abort());
    await page.locator('.header-connection.offline').waitFor({timeout:6500});
    const offlineMs=Date.now()-offlineStart;
    if(!await page.locator('.react-flow__node').count())throw Error('Network failure removed saved map');
    await page.unroute('**/api/revision');
    await page.locator('.header-connection.online').waitFor({timeout:8000});
    await page.locator('.live-pill').click();
    await page.waitForFunction(()=>document.querySelector('.app-shell')?.dataset.checkpoint==='live');
    await page.screenshot({path:'output/playwright/system-queries.png'});
    return {fixedComparisonRequests:initialRequests,extraRequestsDuringLive:0,historyStayedSelected:true,comments:true,offlineMs,automaticRecovery:true};
  } finally {page.off('request',count);await page.unroute('**/api/revision');}
}
