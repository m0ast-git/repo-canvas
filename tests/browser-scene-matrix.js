async(page)=>{
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.reload();
  const nav=page.getByRole('navigation',{name:'Разделы проекта'});
  const captures=[];
  for(const theme of ['light','dark']){
    await page.setViewportSize({width:1366,height:900});
    if(theme==='dark')await page.getByRole('button',{name:'Тёмная тема',exact:true}).click();
    for(const scene of ['overview','flow','element','history']){
      if(scene==='overview'){
        await nav.getByRole('button',{name:'Карта',exact:true}).click();
        await page.getByRole('button',{name:'Показать всё',exact:true}).click();
      }
      if(scene==='flow'){
        await nav.getByRole('button',{name:'Сценарии',exact:true}).click();
        if(await page.locator('.flow-title').count())await page.locator('.flow-title').first().click();
      }
      if(scene==='element')await page.locator('.flow-steps button').nth(1).click();
      if(scene==='history'){
        await nav.getByRole('button',{name:'Карта',exact:true}).click();
        await page.getByRole('button',{name:'Предыдущий чекпоинт',exact:true}).click();
        await page.locator('.app-shell.is-historical').waitFor();
        await page.locator('.timeline-heading button[aria-expanded]').click();
      }
      await page.waitForTimeout(700);
      for(const width of [1366,390]){
        await page.setViewportSize({width,height:900});await page.waitForTimeout(200);
        if(scene==='history'||scene==='overview'){await page.getByRole('button',{name:'Показать всё',exact:true}).click();await page.waitForTimeout(650);}
        if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw new Error(`Overflow: ${scene}/${theme}/${width}`);
        const path=`output/playwright/scene-${scene}-${theme}-${width}.png`;
        await page.screenshot({path});captures.push(path);
      }
      await page.setViewportSize({width:1366,height:900});
    }
    await page.locator('.timeline-heading button[aria-expanded]').click();
    await page.locator('.live-pill').click();
  }
  await page.getByRole('button',{name:'Светлая тема',exact:true}).click();
  if(errors.length)throw new Error(errors.join('\n'));
  return {scenes:4,themes:2,widths:[1366,390],captures,errors};
}
