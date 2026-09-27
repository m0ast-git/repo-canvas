async(page)=>{
 await page.addInitScript(()=>{const NativeWorker=window.Worker;window.Worker=class extends NativeWorker{postMessage(message,...args){if(message?.type==='route-drag'&&message.settle)setTimeout(()=>super.postMessage(message,...args),1200);else super.postMessage(message,...args);}};});
 await page.reload();await page.getByRole('button',{name:'Приём заявок 10 элементов',exact:true}).click();await page.waitForTimeout(2200);
 const node=page.locator('[data-id="entity:module-2"] .entity-node');const box=await node.boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+box.width/2+12,box.y+box.height/2+10);
 const response=page.waitForResponse(r=>r.url().endsWith('/api/layout')&&r.request().method()==='POST');await page.mouse.up();const saved=await(await response).json();await page.waitForTimeout(400);
 const early=await page.evaluate(async()=>(await fetch('/api/state')).json());if(early._geometry)throw new Error('Checkpoint captured before the routing worker settled');
 const until=Date.now()+10000;let final;while(Date.now()<until){final=await page.evaluate(async()=>(await fetch('/api/state')).json());if(final._geometry)break;await page.waitForTimeout(100);}
 if(!final._geometry||final.revision!==saved.revision)throw new Error('Checkpoint did not receive the final revision geometry');return {preparingWhileWorkerRuns:true,finalGeometryRecorded:true};
}
