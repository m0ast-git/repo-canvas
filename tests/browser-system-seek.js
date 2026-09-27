async page=>{
  if(!page.url().startsWith('http://127.0.0.1:4174/'))throw Error('Use the isolated system fixture');
  await page.reload();await page.locator('.header-connection.online').waitFor();
  const index=await page.evaluate(async()=>(await fetch('/api/history?limit=20000')).json());
  const first=index.checkpoints[0],second=index.checkpoints[1];
  const target='**/api/history/state?id='+first.id;
  let aborted=0;
  const failed=request=>{if(request.url().includes(first.id))aborted++;};page.on('requestfailed',failed);
  await page.route(target,async route=>{const response=await route.fetch();await page.waitForTimeout(1200);await route.fulfill({response}).catch(()=>{});});
  try {
    await page.locator('.timeline-heading button[aria-expanded=false]').click();
    await page.getByRole('spinbutton',{name:'Шаг по чекпоинтам'}).fill(String(index.checkpoints.length-1));
    const started=page.waitForRequest(request=>request.url().includes('/api/history/state?id='+first.id));
    await page.getByRole('button',{name:'Предыдущий чекпоинт',exact:true}).click();await started;
    await page.getByRole('spinbutton',{name:'Шаг по чекпоинтам'}).fill('1');
    await page.getByRole('button',{name:'Следующий чекпоинт',exact:true}).click();
    await page.waitForFunction(id=>document.querySelector('.app-shell')?.dataset.checkpoint===id,second.id);
    await page.waitForTimeout(1400);
    if(await page.locator('.app-shell').getAttribute('data-checkpoint')!==second.id)throw Error('Late response replaced selected history');
    if(!aborted)throw Error('Obsolete request was not aborted');
    await page.locator('.live-pill').click();
    return {obsoleteRequestAborted:true,lateResponseIgnored:true};
  } finally {await page.unroute(target);page.off('requestfailed',failed);}
}
