async(page)=>{
  const state=()=>page.evaluate(async()=>(await fetch('/api/state')).json());
  const jobState=()=>page.evaluate(async()=>(await fetch('/api/architect/status')).json());
  const waitJob=async(kind,startedAt)=>{
    const until=Date.now()+240000;let job;
    do {job=await jobState();if(job.kind===kind&&job.startedAt===startedAt&&!job.running)break;await page.waitForTimeout(500);}while(Date.now()<until);
    if(job.status!=='done')throw new Error(job.error||'Native model job failed');return job;
  };
  await page.setViewportSize({width:1600,height:1000});await page.reload();
  const until=Date.now()+30000;while(!(await state())._geometry){if(Date.now()>until)throw new Error('Geometry was not recorded');await page.waitForTimeout(200);}
  const before=await state();
  const previousJob=await jobState();const resuming=previousJob.kind==='correction'&&['running','done'].includes(previousJob.status);
  await page.locator('[data-id^="area:"]').first().waitFor();
  await page.getByRole('button',{name:'Показать всё',exact:true}).click();await page.waitForTimeout(600);
  await page.screenshot({path:'output/playwright/native-project-overview.png'});
  await page.getByRole('button',{name:'Понять проект',exact:true}).click();
  await page.getByRole('button',{name:'Сценарии',exact:true}).click();
  await page.locator('.flow-title').first().click();await page.waitForTimeout(400);
  await page.screenshot({path:'output/playwright/native-project-flow.png'});
  const item=before.entities.find(entity=>entity.id==='live_observer')||before.entities[0];
  const originalLabel=resuming?item.label:item.ownerLabel||item.label;
  let correctionStart=previousJob.startedAt;
  if(!resuming){
  const area=before.areas.find(area=>area.id===item.areaId);
  await page.getByRole('button',{name:`${area.ownerTitle||area.title} ${before.entities.filter(entity=>entity.areaId===area.id).length} элементов`,exact:true}).click();
  await page.getByRole('button',{name:item.ownerLabel||item.label,exact:true}).first().click();
  await page.getByLabel('Своими словами',{exact:true}).fill('Сделай название короче: 3–5 обычных русских слов через пользу этого блока. Смысл, состояние реализации и подробное описание сохрани.');
  const submitted=page.waitForResponse(response=>response.url().endsWith('/api/corrections')&&response.request().method()==='POST');
  await page.getByRole('button',{name:'Применить поправку',exact:true}).click();
  correctionStart=(await (await submitted).json()).startedAt;
  }
  const corrected=await waitJob('correction',correctionStart);const after=await state();
  if(!resuming&&after.revision===before.revision)throw new Error('Correction was not saved');
  if(JSON.stringify(after.relations)!==JSON.stringify(before.relations))throw new Error('Wording correction changed relations');
  const undone=page.waitForResponse(response=>response.url().endsWith('/api/corrections/undo')&&response.request().method()==='POST');
  await page.getByRole('button',{name:'Отменить поправку',exact:true}).click();await undone;
  const restored=(await state()).entities.find(entity=>entity.id===item.id);if((restored.ownerLabel||restored.label)!==originalLabel)throw new Error('Undo did not restore the original wording');
  await page.getByRole('button',{name:'Понять проект',exact:true}).click();
  const revision=(await state()).revision;
  await page.getByLabel('Вопрос о проекте',{exact:true}).fill('Как изменения кода попадают на живую карту и что защищает её от ошибочного заявления агента, что работа готова? Коротко, по-человечески.');
  const questionSent=page.waitForResponse(response=>response.url().endsWith('/api/questions')&&response.request().method()==='POST');
  await page.getByRole('button',{name:'Разобраться',exact:true}).click();
  const answer=await waitJob('question',(await (await questionSent).json()).startedAt);
  await page.getByText(answer.result.answer,{exact:true}).waitFor({timeout:15000});
  await page.locator('.project-answer').scrollIntoViewIfNeeded();
  if((await state()).revision!==revision)throw new Error('Question changed the map');
  await page.screenshot({path:'output/playwright/native-project-answer.png'});
  return {project:before.map.projectTitle,entities:before.entities.length,relations:before.relations.length,flow:before.map.keyFlows[0]?.title,correctedEntity:item.id,wording:after.entities.find(entity=>entity.id===item.id).ownerLabel,correction:corrected.result,undo:true,questionReadOnly:true,answer:answer.result};
}
