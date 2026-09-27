async page=>{
  const check=(ok,message)=>{if(!ok)throw new Error(message);};
  const state=()=>page.evaluate(async()=>(await fetch('/api/state')).json());
  await page.setViewportSize({width:6000,height:4000});await page.reload();await page.locator('.area-node').first().waitFor();
  await page.getByRole('button',{name:'Показать всё',exact:true}).click();
  await page.locator('.zoom-tiers').getByRole('button',{name:'Элементы',exact:true}).click();await page.waitForTimeout(800);
  const before=await state(),entity=before.entities.find(item=>item.id==='local-observer-agent'),group=before.entities.find(item=>item.id==='session-observer');
  check(entity&&group,'Expected real project nodes are missing');
  const source=page.locator(`[data-id="entity:${entity.id}"]`),parent=page.locator(`[data-id="entity:${group.id}"]`);
  const rect=async node=>node.evaluate(node=>{const m=new DOMMatrix(getComputedStyle(node).transform);return{x:m.m41,y:m.m42};});
  const a=await source.boundingBox(),b=await parent.locator('.group-contour').boundingBox();
  let undoCount=0;let result;
  try {
    await page.mouse.move(a.x+a.width/2,a.y+a.height/2);await page.mouse.down();await page.mouse.move(b.x+b.width*.5,b.y+b.height*.7,{steps:20});
    await page.locator('.area-drop-preview').waitFor();
    const preview=await page.locator('.area-drop-preview').boundingBox(),expanded=await parent.locator('.group-contour').boundingBox();
    check(preview.x>=expanded.x-2&&preview.y>=expanded.y-2&&preview.x+preview.width<=expanded.x+expanded.width+2&&preview.y+preview.height<=expanded.y+expanded.height+2,'Drop preview is outside the expanded parent');
    await page.screenshot({path:'output/playwright/0133-nested-preview.png'});
    const expected=await page.locator('.area-drop-preview').evaluate(node=>{const m=new DOMMatrix(getComputedStyle(document.querySelector('.react-flow__viewport')).transform);return{x:(parseFloat(node.style.left)-m.m41)/m.a,y:(parseFloat(node.style.top)-m.m42)/m.a};});
    await page.evaluate(id=>{window.dropSamples=[];const end=performance.now()+2500;function sample(){const node=document.querySelector(`[data-id="${id}"]`);if(node){const m=new DOMMatrix(getComputedStyle(node).transform);window.dropSamples.push({x:m.m41,y:m.m42,t:performance.now()});}if(performance.now()<end)requestAnimationFrame(sample);}requestAnimationFrame(sample);},`entity:${entity.id}`);
    let saving=page.waitForResponse(response=>response.url().endsWith('/api/layout')&&response.request().method()==='POST');await page.mouse.up();const response=await saving;check(response.ok(),'Nested drop was rejected');undoCount++;
    await page.waitForTimeout(1300);
    const after=await state();check(after.entities.find(item=>item.id===entity.id).parentId===group.id,'Nested drop did not persist the parent');
    const samples=await page.evaluate(()=>window.dropSamples.slice(3));
    const maxJump=Math.max(...samples.map(p=>Math.hypot(p.x-expected.x,p.y-expected.y)));
    check(maxJump<2,`Dropped node jumped ${maxJump} world units`);
    const childBefore=await rect(source),parentBefore=await rect(parent),header=await parent.locator('header').boundingBox();
    await page.mouse.move(header.x+header.width/2,header.y+20);await page.mouse.down();await page.mouse.move(header.x+header.width/2+45,header.y+45,{steps:12});
    const childDuring=await rect(source),parentDuring=await rect(parent);
    check(Math.abs((childDuring.x-childBefore.x)-(parentDuring.x-parentBefore.x))<1&&Math.abs((childDuring.y-childBefore.y)-(parentDuring.y-parentBefore.y))<1,'Dropped child did not follow the group');
    saving=page.waitForResponse(response=>response.url().endsWith('/api/layout')&&response.request().method()==='POST');await page.mouse.up();check((await saving).ok(),'Group move failed');undoCount++;await page.waitForTimeout(700);
    result={nestedParentSaved:true,previewInsideExpandedGroup:true,maxJump,childFollowsGroup:true};
  } finally {
    await page.mouse.up();
    for(let i=0;i<undoCount;i++){const saving=page.waitForResponse(response=>response.url().endsWith('/api/layout')&&response.request().method()==='POST');await page.keyboard.press('Control+z');const undoResponse=await saving;check(undoResponse.ok(),'Test undo failed: '+(undoResponse.ok()?'':await undoResponse.text()));await page.waitForTimeout(800);}
    const restored=(await state()).entities.find(item=>item.id===entity.id);check(restored.parentId===entity.parentId&&restored.ownerParentId===entity.ownerParentId,'Test did not restore the original membership');
    await page.setViewportSize({width:1600,height:1000});await page.getByRole('button',{name:'Показать всё',exact:true}).click();
  }
  return result;
}
