async page => {
  const check=(ok,message)=>{if(!ok)throw new Error(message);};
  await page.setViewportSize({width:1600,height:1000});
  await page.getByRole('button',{name:'Показать всё',exact:true}).click();
  await page.waitForTimeout(500);
  const titles=page.locator('.overview-entity strong');
  check(await titles.count()>0,'Overview lost node titles');
  const first=page.locator('.overview-entity').first();
  await first.hover();await page.locator('.reading-preview').waitFor();
  check((await page.locator('.reading-preview').innerText()).includes(await first.locator('strong').innerText()),'Hover reads another node');
  await page.mouse.move(1580,880);await page.waitForTimeout(150);
  check(await page.locator('.reading-preview').count()===0,'Reading preview stuck');
  await first.click();await page.locator('.inspector-zone').waitFor();
  const position=await page.evaluate(()=>({inspector:document.querySelector('.inspector-zone').getBoundingClientRect().top,tree:document.querySelector('.project-section').getBoundingClientRect().top}));
  check(position.inspector<position.tree,'Object description is below navigation');
  await page.getByRole('button',{name:'Показать всё',exact:true}).click();
  const history=await page.evaluate(async()=>(await fetch('/api/history?limit=20000')).json());
  const targetIndex=4,target=history.checkpoints[targetIndex],next=history.checkpoints[targetIndex+1];
  await page.getByRole('spinbutton',{name:'Шаг по чекпоинтам'}).fill(String(history.checkpoints.length-1-targetIndex));
  await page.getByRole('button',{name:'Предыдущий чекпоинт',exact:true}).click();
  await page.waitForFunction(id=>document.querySelector('.app-shell')?.dataset.checkpoint===id,target.id);
  const past=await page.evaluate(async id=>(await fetch('/api/history/state?id='+id)).json(),target.id);
  check(Number(await page.locator('.app-shell').getAttribute('data-revision'))===past.revision,'Historical revision does not match the selected checkpoint');
  await page.getByRole('button',{name:'Показать всё',exact:true}).click();await page.waitForTimeout(500);
  await page.screenshot({path:'output/playwright/recovery-history.png'});
  await page.getByRole('spinbutton',{name:'Шаг по чекпоинтам'}).fill('1');
  await page.getByRole('slider',{name:'Чекпоинт карты',exact:true}).press('ArrowRight');
  await page.waitForFunction(id=>document.querySelector('.app-shell')?.dataset.checkpoint===id,next.id);
  await page.locator('.live-pill').click();await page.waitForFunction(()=>document.querySelector('.app-shell')?.dataset.checkpoint==='live');
  const shown=await page.locator('.app-shell').getAttribute('data-revision');
  await page.route('**/api/history/state?*',route=>route.abort('failed'));
  await page.route('**/api/architect/status?*',route=>route.abort('failed'));
  try {
    await page.getByRole('spinbutton',{name:'Шаг по чекпоинтам'}).fill(String(history.checkpoints.length-1-12));
    await page.getByRole('button',{name:'Предыдущий чекпоинт',exact:true}).click();
    await page.locator('.history-error').waitFor();
    check(!/failed to fetch/i.test(await page.locator('.history-error').innerText()),'Raw network error leaked');
    check(await page.locator('.app-shell').getAttribute('data-checkpoint')==='live','Failed seek moved the cursor to an unloaded state');
    await page.locator('.architect-banner').getByText('Нет связи с Canvas',{exact:true}).waitFor();
    check(await page.locator('.job-heartbeat').count()===0,'False heartbeat while disconnected');
    await page.screenshot({path:'output/playwright/recovery-offline.png'});
  } finally {await page.unroute('**/api/history/state?*');await page.unroute('**/api/architect/status?*');}
  await page.locator('.history-error').getByRole('button',{name:'Повторить',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.app-shell')?.dataset.checkpoint!=='live');
  await page.locator('.live-pill').click();await page.getByRole('spinbutton',{name:'Шаг по чекпоинтам'}).fill('1');
  await page.getByRole('button',{name:'Показать всё',exact:true}).click();await page.waitForTimeout(700);
  await page.screenshot({path:'output/playwright/recovery-overview.png'});
  return {overviewTitles:await titles.count(),delayedReadingAndDismiss:true,inspectorAboveTree:true,historyRevisions:[past.revision,next.revision],failedSeekKeepsShownState:true,networkErrorExplained:true,noFalseHeartbeat:true,retryRecovered:true,liveRevisionBeforeFailure:shown};
}
