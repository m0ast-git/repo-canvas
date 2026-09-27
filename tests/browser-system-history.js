async page => {
  if(!page.url().startsWith('http://127.0.0.1:4174/'))throw Error('Use the isolated system fixture');
  const state=()=>page.evaluate(async()=>(await fetch('/api/state')).json());
  const waitSaved=stage=>page.waitForFunction(async()=>{const s=await(await fetch('/api/state')).json();return s._geometry?.format===2&&s._geometry.routes.every(r=>r.finalGeometry);},{},{polling:100,timeout:12000}).catch(error=>{throw Error(stage+': '+error.message);});
  await page.waitForFunction(()=>document.querySelector('.canvas-wrap')?.dataset.routingReady==='true');
  await waitSaved('initial geometry');
  const before=await state();
  const paths=()=>page.evaluate(()=>Object.fromEntries([...document.querySelectorAll('.route-path')].map(p=>[p.id,p.getAttribute('d')])));
  const initial=await paths();
  const response=await page.evaluate(async s=>{const r=await fetch('/api/rename',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({canvasRevision:s.revision,kind:'entity',id:'module-0',values:{title:'Приём данных',description:'Сохраняет заявку'}})});if(!r.ok)throw Error(await r.text());return r.json();},before);
  await page.waitForFunction(revision=>Number(document.querySelector('.app-shell')?.dataset.revision)>revision,before.revision);
  await waitSaved('renamed geometry');
  const after=await state();
  await page.getByRole('button',{name:'Предыдущий чекпоинт',exact:true}).click();
  await page.waitForFunction(id=>document.querySelector('.app-shell')?.dataset.checkpoint===id,before._historyHead.id);
  await page.waitForFunction(()=>document.querySelector('.canvas-wrap')?.dataset.routingReady==='true');
  const past=await paths();
  if(!Object.keys(initial).length)throw Error('Initial SVG is empty');
  if(JSON.stringify(initial)!==JSON.stringify(past))throw Error('Historical SVG differs from recorded Live');
  if(await page.locator('.canvas-wrap').getAttribute('data-routing-run')!=='0')throw Error('History invoked router');
  if(await page.locator('.area-resize-control').count())throw Error('History allows resizing');
  const recorded=await page.evaluate(async id=>(await fetch('/api/history/state?id='+encodeURIComponent(id))).json(),before._historyHead.id);
  if(JSON.stringify(recorded._geometry.routes)!==JSON.stringify(before._geometry.routes))throw Error('History was rewritten');
  await page.screenshot({path:'output/playwright/system-history.png'});
  await page.locator('.live-pill').click();
  await page.waitForFunction(()=>document.querySelector('.app-shell')?.dataset.checkpoint==='live');
  if((await state()).revision!==after.revision)throw Error('History reading wrote map events');
  return {recordedFinalRoutes:before._geometry.routes.length,exactSvg:true,noHistoryRouting:true,immutableGeometry:true,liveRevision:after.revision};
}
