async page=>{
  if(!page.url().startsWith('http://127.0.0.1:4174/'))throw Error('Use the isolated load fixture');
  await page.setViewportSize({width:1366,height:900});
  const start=Date.now();await page.reload();await page.locator('.react-flow__node').first().waitFor();const firstNodesMs=Date.now()-start;
  await page.waitForFunction(()=>document.querySelector('.canvas-wrap')?.dataset.routingReady==='true',{},{timeout:30000});
  const readyMs=Date.now()-start;
  const snapshot=await page.evaluate(async()=>(await fetch('/api/state')).json());
  await page.evaluate(()=>{window.frames=[];window.measuring=true;let previous=performance.now();const tick=at=>{if(!window.measuring)return;window.frames.push(at-previous);previous=at;requestAnimationFrame(tick);};requestAnimationFrame(tick);});
  const run=await page.locator('.canvas-wrap').getAttribute('data-routing-run');
  await page.mouse.move(680,500);await page.mouse.down({button:'middle'});
  for(let i=0;i<75;i++){await page.mouse.move(680+Math.sin(i/15)*140,500+Math.cos(i/20)*60);await page.waitForTimeout(16);}
  await page.mouse.up({button:'middle'});
  const frames=await page.evaluate(()=>{window.measuring=false;return window.frames.filter(x=>x>0).sort((a,b)=>a-b);});
  const afterRun=await page.locator('.canvas-wrap').getAttribute('data-routing-run');
  await page.screenshot({path:'output/playwright/system-load.png'});
  return {entities:snapshot.entities.length,relations:snapshot.relations.length,firstNodesMs,readyMs,panFrameP95Ms:frames[Math.floor(frames.length*.95)],longFrames:frames.filter(x=>x>=100).length,noRoutingDuringPan:run===afterRun,renderedPaths:await page.locator('.route-path').count(),heapMB:await page.evaluate(()=>performance.memory?.usedJSHeapSize/1024/1024)};
}
