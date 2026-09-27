async page => {
  await page.setViewportSize({width:1600,height:1000});
  await page.getByRole('button',{name:'Показать всю карту',exact:true}).click();
  await page.waitForTimeout(400);
  const result = await page.evaluate(() => ({
    zoom:new DOMMatrix(getComputedStyle(document.querySelector('.react-flow__viewport')).transform).a,
    routing:document.querySelector('.canvas-wrap').dataset,
    areas:[...document.querySelectorAll('.area-node')].map(node=>({id:node.closest('[data-id]').dataset.id,color:getComputedStyle(node).getPropertyValue('--area-color').trim(),border:getComputedStyle(node,'::before').borderColor,background:getComputedStyle(node,'::before').backgroundColor,status:node.dataset.status})),
    routes:[...document.querySelectorAll('[data-route-source]')].map(group=>({source:group.dataset.routeSource,target:group.dataset.routeTarget,stroke:getComputedStyle(group.querySelector('.route-path')).stroke,kind:group.querySelector('.route-path').getAttribute('class')})),
    pulses:document.querySelectorAll('.work-activity[data-pulsing=true]').length
  }));
  await page.screenshot({path:'output/playwright/appearance-real.png'});
  return result;
}
