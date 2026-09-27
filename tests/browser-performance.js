async(page)=>{
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.setViewportSize({width:1366,height:768});const started=Date.now();await page.reload();await page.locator('.react-flow__node').first().waitFor();const usefulFirstMs=Date.now()-started;
 await page.waitForTimeout(600);
 const actual=await page.evaluate(async()=>(await fetch('/api/state')).json());
 await page.evaluate(()=>{window.frameSamples=[];window.frameCollecting=true;let previous=performance.now();const frame=at=>{if(!window.frameCollecting)return;window.frameSamples.push(at-previous);previous=at;requestAnimationFrame(frame);};requestAnimationFrame(frame);});
 const pane=await page.locator('.canvas-wrap').boundingBox();await page.mouse.move(pane.x+pane.width/2,pane.y+70);await page.mouse.down();
 for(let i=0;i<120;i++){await page.mouse.move(pane.x+pane.width/2+Math.sin(i/20)*90,pane.y+70+Math.sin(i/30)*30);await page.waitForTimeout(16);}
 await page.mouse.up();
 const frames=await page.evaluate(()=>{window.frameCollecting=false;const values=window.frameSamples.filter(value=>value>0).sort((a,b)=>a-b);return {count:values.length,p95Ms:values[Math.floor(values.length*.95)],meanMs:values.reduce((a,b)=>a+b,0)/values.length,longFrames:values.filter(value=>value>=100).length};});
 const inputTimes=[];const heapSamples=[];
 for(let i=0;i<100;i++){const at=Date.now();await page.getByRole('button',{name:'Понять проект',exact:true}).click();await page.getByRole('heading',{name:'Производство на заказ'}).waitFor();inputTimes.push(Date.now()-at);await page.getByRole('button',{name:'Закрыть контекст'}).click();if(i%25===0||i===99)heapSamples.push({actions:i+1,heapMB:await page.evaluate(()=>performance.memory?.usedJSHeapSize/1024/1024)});}
 inputTimes.sort((a,b)=>a-b);
 const memory=await page.evaluate(()=>({heapMB:performance.memory?.usedJSHeapSize/1024/1024,nodes:document.querySelectorAll('.react-flow__node').length,elements:document.querySelectorAll('*').length}));
 const historyTimes=[];
 for(let i=0;i<10;i++){const at=Date.now();await page.getByRole('button',{name:'Предыдущий чекпоинт',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.app-shell')?.dataset.checkpoint!=='live');historyTimes.push(Date.now()-at);await page.locator('.live-pill').click();await page.waitForFunction(()=>document.querySelector('.app-shell')?.dataset.checkpoint==='live');}
 historyTimes.sort((a,b)=>a-b);
 const result={entities:actual.entities.length,relations:actual.relations.length,viewport:{width:1366,height:768},usefulFirstMs,frames,fps:1000/frames.meanMs,inputP95Ms:inputTimes[94],historyP95Ms:historyTimes[9],heapSamples,memory,errors};
 await page.screenshot({path:`output/playwright/performance-${actual.entities.length}.png`});
 return result;
}
