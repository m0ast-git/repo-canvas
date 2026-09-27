async(page)=>{
 const errors=[];page.on('pageerror',error=>errors.push(error.message));await page.reload();
 await page.getByRole('button',{name:'Обновить Canvas',exact:true}).click();const dialog=page.getByRole('dialog',{name:'Построение карты'});await dialog.waitFor();
 for(let i=0;i<6;i++)await page.keyboard.press('Tab');
 if(!await dialog.evaluate(element=>element.contains(document.activeElement)))throw new Error('Focus escaped the dialog');
 await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});
 if(await page.locator('.workspace').evaluate(element=>element.inert))throw new Error('Workspace remained inert');
 await page.getByRole('button',{name:'Приём заявок 10 элементов',exact:true}).click();await page.getByRole('button',{name:'Шаг заявки 2',exact:true}).click();
 await page.getByRole('heading',{name:'Шаг заявки 2',exact:true}).waitFor();
 await page.getByText('Получает',{exact:true}).waitFor();await page.getByText('Передаёт',{exact:true}).waitFor();
 await page.screenshot({path:'output/playwright/final-context.png'});
 await page.getByRole('button',{name:'Закрыть контекст'}).click();
 await page.getByTitle('Тёмная тема',{exact:true}).click();await page.waitForTimeout(250);await page.screenshot({path:'output/playwright/final-dark.png'});
 await page.getByTitle('Светлая тема',{exact:true}).click();
 if(errors.length)throw new Error(errors.join('\n'));return {modalFocus:true,context:true,themes:true,errors};
}
