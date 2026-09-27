async(page)=>{
  const check=(value,message)=>{if(!value)throw new Error(message)};
  const startedAt=new Date(Date.now()-61000).toISOString();
  let job={status:'done',running:false,kind:'code-review',startedAt,finishedAt:new Date().toISOString(),result:{verified:false,issue:{code:'stale-sources'},summary:'Непонятный внутренний пакет доказательств'}};
  let submissions=0;
  await page.route('**/api/architect/status*',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(job)}));
  await page.route('**/api/architect/refresh',async route=>{
    submissions++;check(route.request().postDataJSON().reason==='stale-sources','The update reason was lost');
    job={status:'running',running:true,kind:'build',startedAt:new Date().toISOString(),phase:'sources',updateReason:'stale-sources'};
    await route.fulfill({status:202,contentType:'application/json',body:JSON.stringify({...job,started:true})});
  });
  try {
    await page.reload();const notice=page.locator('.architect-banner');
    await notice.getByText('Canvas устарел',{exact:true}).waitFor();
    check(await notice.getByRole('button',{name:'Обновить',exact:true}).count()===1,'No clear update action');
    check(!/пакет доказательств|эксперт|вердикт/.test(await notice.textContent()),'Internal model text leaked');
    await notice.getByRole('button',{name:'Обновить',exact:true}).click();
    const preset=page.getByRole('dialog');await preset.locator('.model-role input').first().waitFor();
    await preset.getByRole('button',{name:'Обновить',exact:true}).click();
    await notice.getByText('Обновляем Canvas',{exact:true}).waitFor();
    check(submissions===1,'Model selection started duplicate updates');
    check(await page.getByRole('dialog').count()===0,'The model preset did not close after starting');
    job={status:'done',running:false,kind:'build',startedAt,finishedAt:new Date(Date.parse(startedAt)+61000).toISOString(),updateReason:'stale-sources',result:{revision:123,calls:2,models:['architect-test','verifier-test'],usage:{totalTokens:12804}}};
    await notice.getByText('Canvas обновлён',{exact:true}).waitFor();
    const text=await notice.textContent();check(/1 мин 1 с/.test(text)&&/12\s804/.test(text)&&text.includes('architect-test, verifier-test'),'Time, tokens or actual models missing');
    const reported=await notice.locator('.job-statistics').textContent();await page.waitForTimeout(1200);
    check(await notice.locator('.job-statistics').textContent()===reported,'Completed time keeps increasing');
    return {modelPresetBeforeUpdate:true,reasonPreserved:true,noInternalMonologue:true,usageAndModels:true,frozenDuration:true};
  } finally {
    await page.unroute('**/api/architect/status*');await page.unroute('**/api/architect/refresh');await page.reload();
  }
}
