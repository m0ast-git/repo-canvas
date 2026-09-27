async page=>{
  const check=(ok,message)=>{if(!ok)throw new Error(message);};
  await page.setViewportSize({width:3000,height:2000});
  await page.getByRole('button',{name:'Показать всё',exact:true}).click();
  await page.locator('.zoom-tiers').getByRole('button',{name:'Элементы',exact:true}).click();await page.waitForTimeout(500);
  const target=await page.evaluate(()=>{const frame=document.querySelector('.canvas-wrap').getBoundingClientRect();for(const node of document.querySelectorAll('.react-flow__node-area')){const b=node.getBoundingClientRect();if(b.left>frame.left+30&&b.right<frame.right-70&&b.top>frame.top+30&&b.bottom<frame.bottom-70)return {id:node.dataset.id,box:b.toJSON()};}});
  check(target,'No fully visible area for drag and resize');
  const current=async()=>await page.evaluate(async()=>(await fetch('/api/state')).json());
  const before=await current();
  const saved=()=>page.waitForResponse(r=>r.url().endsWith('/api/layout')&&r.request().method()==='POST');
  const start={x:target.box.x+100,y:target.box.y+30};
  await page.mouse.move(start.x,start.y);await page.mouse.down();await page.mouse.move(start.x-35,start.y+15,{steps:8});
  check(await page.locator('.route-label:not(.is-interaction-hidden)').count()===0,'Area drag leaves floating labels');
  let saving=saved();await page.mouse.up();check((await saving).ok(),'Area move failed');await page.waitForTimeout(350);
  saving=saved();await page.keyboard.press('Control+z');check((await saving).ok(),'Area move undo failed');await page.waitForTimeout(500);
  const handle=page.locator(`[data-id="${target.id}"] .area-resize-control`);const h=await handle.boundingBox();
  check(h,'Missing corner resize handle');
  await page.mouse.move(h.x+h.width/2,h.y+h.height/2);await page.mouse.down();await page.mouse.move(h.x+h.width/2+45,h.y+h.height/2+25,{steps:8});
  check(await page.locator('.route-label:not(.is-interaction-hidden)').count()===0,'Resize leaves floating labels');
  saving=saved();await page.mouse.up();check((await saving).ok(),'Resize did not persist');await page.waitForTimeout(400);
  const grown=await current(),id=target.id.replace(/^area:/,'');
  check(Number(grown.areas.find(a=>a.id===id).minWidth)>Number(before.areas.find(a=>a.id===id).minWidth||0),'Resize did not expand area');
  await page.screenshot({path:'output/playwright/recovery-resize.png'});
  saving=saved();await page.keyboard.press('Control+z');check((await saving).ok(),'Resize undo failed');await page.waitForTimeout(500);
  const after=await current();
  for(const entity of before.entities){const actual=after.entities.find(e=>e.id===entity.id);check(actual.x===entity.x&&actual.y===entity.y,'Area move/undo changed a member position');}
  return {areaDrag:true,resizeCorner:true,labelsHiddenDuringBoth:true,undoRestoredMembers:true};
}
