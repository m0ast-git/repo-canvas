async(page)=>{
  await page.setViewportSize({width:1600,height:1000});await page.reload();
  await page.locator('.area-node').first().waitFor();
  await page.locator('.zoom-tiers').getByRole('button',{name:'Элементы',exact:true}).click();await page.waitForTimeout(700);
  const target=await page.evaluate(()=>{
    const frame=document.querySelector('.canvas-wrap').getBoundingClientRect();
    for(const item of document.querySelectorAll('.entity-node')){
      const box=item.getBoundingClientRect(),node=item.closest('.react-flow__node');
      if(box.left>frame.left+20&&box.right<frame.right-50&&box.top>frame.top+20&&box.bottom<frame.bottom-30){const t=new DOMMatrix(getComputedStyle(node).transform);return{id:node.dataset.id,box:box.toJSON(),x:t.m41,y:t.m42};}
    }
  });
  if(!target)throw new Error('No visible element to drag');
  const start={x:target.box.x+target.box.width/2,y:target.box.y+target.box.height/2};
  await page.mouse.move(start.x,start.y);await page.mouse.down();await page.mouse.move(start.x+18,start.y+6,{steps:8});
  const saving=page.waitForResponse(r=>r.url().endsWith('/api/layout')&&r.request().method()==='POST');
  const released=Date.now();await page.mouse.up();if(!(await saving).ok())throw new Error('Move was not saved');
  const until=Date.now()+20000;let state;
  do{state=await page.evaluate(async()=>(await fetch('/api/state')).json());if(state._geometry?.routingVersion===9)break;await page.waitForTimeout(100);}while(Date.now()<until);
  if(state._geometry?.routingVersion!==6)throw new Error('Updated routing was not stored');
  const settledMs=Date.now()-released;
  await page.keyboard.press('Control+z');await page.getByText(/^Отменено:/).waitFor();
  await page.waitForTimeout(700);
  const restored=await page.locator(`[data-id="${target.id}"]`).evaluate(node=>{const t=new DOMMatrix(getComputedStyle(node).transform);return{x:t.m41,y:t.m42};});
  if(Math.abs(restored.x-target.x)>1||Math.abs(restored.y-target.y)>1)throw new Error('Undo did not restore the original position');
  return {dragSaved:true,originalPositionRestored:true,routingVersion:6,settledMs};
}
