async page=>{
  const check=(ok,message)=>{if(!ok)throw new Error(message);};
  const state=()=>page.evaluate(async()=>(await fetch('/api/state')).json());
  await page.setViewportSize({width:6000,height:4000});
  await page.getByRole('button',{name:'Показать всё',exact:true}).click();await page.waitForTimeout(500);
  await page.locator('.zoom-tiers').getByRole('button',{name:'Элементы',exact:true}).click();await page.waitForTimeout(500);
  const before=await state();const entity=before.entities.find(item=>!item.parentId&&item.kind!=='person'&&!before.entities.some(child=>child.parentId===item.id));
  const area=before.areas.find(item=>item.id!==entity.areaId&&before.entities.some(e=>e.areaId===item.id));
  const source=page.locator(`[data-id="entity:${entity.id}"] .entity-node`),destination=page.locator(`[data-id="area:${area.id}"] .area-node`);
  const a=await source.boundingBox(),b=await destination.boundingBox();check(a&&b,'Missing visible source or destination');
  const occupant=before.entities.find(item=>item.areaId===area.id&&!item.parentId&&!before.entities.some(child=>child.parentId===item.id));
  const occupied=await page.locator(`[data-id="entity:${occupant.id}"] .entity-node`).boundingBox();check(occupied,'No occupied destination slot');
  await page.mouse.move(a.x+a.width/2,a.y+a.height/2);await page.mouse.down();await page.mouse.move(occupied.x+occupied.width/2,occupied.y+occupied.height/2,{steps:22});
  await page.locator('.area-drop-preview').waitFor();
  let saving=page.waitForResponse(r=>r.url().endsWith('/api/layout')&&r.request().method()==='POST');await page.mouse.up();check((await saving).ok(),'Cross-area drop failed');
  const after=await state();check(after.entities.find(item=>item.id===entity.id).areaId===area.id,'Drop did not change membership');await page.waitForTimeout(700);
  const geometry=await page.evaluate(({areaId,ids})=>{const area=document.querySelector(`[data-id="area:${areaId}"] .area-node`),frame=area.getBoundingClientRect(),header=area.querySelector('header').getBoundingClientRect();return ids.map(id=>{const r=document.querySelector(`[data-id="entity:${id}"]`).getBoundingClientRect();return{inside:r.left>=frame.left-.5&&r.right<=frame.right+.5&&r.bottom<=frame.bottom+.5&&r.top>=header.bottom,rect:r.toJSON()};});},{areaId:area.id,ids:after.entities.filter(item=>item.areaId===area.id&&!item.parentId).map(item=>item.id)});
  check(geometry.every(item=>item.inside),'A node overlaps the area header or boundary');
  for(let i=0;i<geometry.length;i++)for(const other of geometry.slice(i+1)){const a=geometry[i].rect,b=other.rect;check(a.right<=b.left||b.right<=a.left||a.bottom<=b.top||b.bottom<=a.top,'Packed nodes overlap');}
  await page.screenshot({path:'output/playwright/recovery-reparent.png'});
  saving=page.waitForResponse(r=>r.url().endsWith('/api/layout')&&r.request().method()==='POST');await page.keyboard.press('Control+z');check((await saving).ok(),'Undo failed');
  const restored=(await state()).entities.find(item=>item.id===entity.id);check(restored.areaId===entity.areaId,'Undo failed to restore membership');check(restored.ownerAreaId===entity.ownerAreaId&&restored.ownerParentId===entity.ownerParentId,'Undo left a hidden ownership override');
  await page.setViewportSize({width:1600,height:1000});await page.getByRole('button',{name:'Показать всё',exact:true}).click();
  return {dropOntoOccupiedSlot:true,preview:true,headerClearance:true,noNodeOverlap:true,undoRestoredMembership:true};
}
