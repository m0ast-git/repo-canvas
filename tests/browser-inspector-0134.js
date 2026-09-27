async page=>{
 await page.setViewportSize({width:1600,height:1000});await page.reload();await page.locator('.area-node').first().waitFor();
 await page.getByRole('button',{name:'Показать всё',exact:true}).click();
 const tree=page.locator('.tree-area').filter({hasText:'Запуск Canvas'});await tree.locator('header').click();
 await page.locator('.left-rail').getByRole('button',{name:'Локальный сервер канваса',exact:true}).click();
 await page.locator('.left-rail').getByRole('button',{name:'Детали',exact:true}).click();
 const panel=page.locator('.context-panel');await panel.locator('.source-link button').first().click();await panel.locator('.source-reader pre').waitFor();
 const inline=await panel.locator('.evidence-section').evaluate(e=>!!e.querySelector('.source-reader'));
 if(!inline)throw Error('Source preview is not inline');
 if((await panel.innerText()).includes('operational'))throw Error('Raw status');
 const file=panel.locator('.source-link a').first();const href=await file.getAttribute('href');const result=await page.evaluate(async href=>{const r=await fetch(href);return {status:r.status,text:await r.text()};},href);
 if(result.status!==200||!result.text.includes('<pre>')||!result.text.includes('<mark>'))throw Error('File view failed');
 const telemetry=await page.locator('.telemetry>span').evaluateAll(nodes=>nodes.filter(n=>getComputedStyle(n).display!=='none').every(n=>getComputedStyle(n).borderLeftWidth==='0px'&&getComputedStyle(n).alignItems==='center'));
 if(!telemetry)throw Error('Stats not centered');
 await page.screenshot({path:'output/playwright/0134-details.png'});
 const arrows=await page.locator('.route-path[marker-start]').count();if(!arrows)throw Error('No bidirectional arrowheads');
 await page.getByRole('button',{name:'Перестроить Canvas',exact:true}).click();await page.locator('.model-role').first().waitFor();
 if(await page.getByRole('dialog').locator('input[type=number]').count())throw Error('Budget editor still present');
 await page.screenshot({path:'output/playwright/0134-rebuild.png'});await page.getByRole('button',{name:'Отмена',exact:true}).click();
 return {inline,fileView:result.status,telemetry,budgetRemoved:true};
}
