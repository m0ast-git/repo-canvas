async(page)=>{
 await page.reload();await page.getByRole('button',{name:'Поиск · Ctrl+F',exact:true}).click();await page.locator('.canvas-search input').fill('Production quality checks 1.4');await page.locator('.canvas-search button').first().click();await page.waitForTimeout(700);
 const node=page.locator('[data-id="entity:e4"] .entity-node');const box=await node.boundingBox();if(!box)throw new Error('Target node is not visible');
 const before=await page.evaluate(async()=>(await fetch('/api/state')).json());
 await page.evaluate(()=>{window.dragFrames=[];window.dragMeasure=true;let previous=performance.now();const frame=at=>{if(!window.dragMeasure)return;window.dragFrames.push(at-previous);previous=at;requestAnimationFrame(frame);};requestAnimationFrame(frame);});
 await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();for(let i=1;i<=80;i++){await page.mouse.move(box.x+box.width/2+i*.25,box.y+box.height/2+i*.15);await page.waitForTimeout(16);}
 const response=page.waitForResponse(r=>r.url().endsWith('/api/layout')&&r.request().method()==='POST');const released=Date.now();await page.mouse.up();if(!(await response).ok())throw new Error('Drag was not persisted');
 const frames=await page.evaluate(()=>{window.dragMeasure=false;return window.dragFrames.filter(value=>value>0).sort((a,b)=>a-b);});
 let after;const until=Date.now()+20000;while(Date.now()<until){after=await page.evaluate(async()=>(await fetch('/api/state')).json());if(after.revision>before.revision&&after._geometry)break;await page.waitForTimeout(100);}
 if(!after?._geometry)throw new Error('Final routing did not settle into the checkpoint');
 const result={nodes:after.entities.length,dragFrameP95Ms:frames[Math.floor(frames.length*.95)],longFrames:frames.filter(value=>value>=100).length,settledMs:Date.now()-released,moved:after.entities.find(item=>item.id==='e4').x!==before.entities.find(item=>item.id==='e4').x};
 await page.screenshot({path:'output/playwright/drag-performance.png'});return result;
}
