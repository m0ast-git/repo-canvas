async page=>{
  const check=(ok,message)=>{if(!ok)throw new Error(message);};
  await page.setViewportSize({width:1600,height:1000});await page.reload();
  const initial=await page.evaluate(async()=>(await fetch('/api/models')).json());
  await page.getByRole('button',{name:'Перестроить Canvas',exact:true}).click();
  const dialog=page.getByRole('dialog');await dialog.locator('.model-role input').first().waitFor();
  const selected=await dialog.locator('.model-role input').evaluateAll(nodes=>nodes.map(node=>node.value));
  const boxes=await dialog.locator('.model-role').evaluateAll(nodes=>nodes.map(node=>node.getBoundingClientRect().toJSON()));
  check(boxes.every((box,i)=>!i||box.top>=boxes[i-1].bottom),'Role rows overlap or collapse into columns');
  check(selected[0]===initial.roles.architect.recommended.model,'Architect recommendation missing');
  check(selected[1]===initial.roles.verifier.recommended.model,'Verifier recommendation missing');
  const efforts=await dialog.locator('.model-role').evaluateAll(nodes=>nodes.map(node=>node.querySelectorAll('select')[1].value));
  check(efforts.join(',')==='medium,medium,low,low','Default reasoning differs from the role contract');
  await page.screenshot({path:'output/playwright/0133-model-presets.png'});
  let submitted=false;
  await page.route('**/api/architect/refresh',async route=>{submitted=true;await route.fulfill({status:202,contentType:'application/json',body:JSON.stringify({status:'running',running:true,started:true,kind:'build'})});});
  try{await dialog.getByRole('button',{name:'Перестроить',exact:true}).click();await dialog.waitFor({state:'hidden'});check(submitted,'Start action was not sent');}finally{await page.unroute('**/api/architect/refresh');await page.reload();}
  const saved=await page.evaluate(async()=>(await fetch('/api/models')).json());
  check(saved.config.modelPool.length===4,'Four roles were not saved');
  await page.getByRole('button',{name:'Настройки',exact:true}).click();
  await page.locator('.context-panel .model-role input').first().waitFor();
  check(await page.locator('.context-panel .model-role input').count()===4,'Saved roles unavailable in settings');
  await page.screenshot({path:'output/playwright/0133-model-settings.png'});
  await page.getByRole('button',{name:'Карта',exact:true}).click();
  return {recommendations:selected,efforts,persisted:true,settingsEditable:true,noModelCallMade:true};
}
