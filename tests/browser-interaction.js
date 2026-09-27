async (page) => {
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const state = () => page.evaluate(async () => (await fetch('/api/state')).json());
  await page.getByRole('button', {name:'Приём заявок 10 элементов', exact:true}).click();
  const node = page.locator('[data-id="entity:module-0"] .entity-node');
  await node.waitFor({state:'visible'});
  // Wait for the focus transition to settle before measuring screen coordinates.
  await page.waitForTimeout(600);
  const initial = await state();
  const before = initial.entities.find(item => item.id === 'module-0');
  const box = await node.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 35, box.y + box.height / 2 + 12, {steps:1});
  const preview = page.locator('.area-drop-preview');
  await preview.waitFor({state:'visible'});
  const predicted = await preview.boundingBox();
  const save = page.waitForResponse(response => response.url().endsWith('/api/layout') && response.request().method() === 'POST');
  await page.mouse.up();
  check((await save).ok(), 'Drag was not saved');
  const after = await state();
  const moved = after.entities.find(item => item.id === before.id);
  check(Math.abs(moved.x - before.x) > 1, 'F01: single pointer movement was lost');
  for (const item of initial.entities.filter(item => item.id !== before.id)) {
    const actual = after.entities.find(value => value.id === item.id);
    check(actual.x === item.x && actual.y === item.y, `F02: unrelated neighbour moved: ${item.id}`);
  }
  const actualBox = await node.boundingBox();
  const error = Math.max(Math.abs(predicted.x - actualBox.x), Math.abs(predicted.y - actualBox.y));
  check(error <= 1, `F02: preview disagrees with commit by ${error}px`);
  const second = await page.context().newPage();
  try {
    await second.goto(page.url());
    const targetX = moved.x + 80;
    const response = await second.evaluate(async ({id, x, y}) => {
      const current = await (await fetch('/api/state')).json();
      const result = await fetch('/api/layout', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({canvasRevision:current.revision,items:[{kind:'entity',id,x,y}]})});
      return {status:result.status, data:await result.json()};
    }, {id:moved.id, x:targetX, y:moved.y});
    check(response.status === 201, 'Second-window layout update failed');
    await page.waitForFunction(({id, x}) => {
      const element = document.querySelector(`[data-id="entity:${id}"]`);
      return element && Math.abs(new DOMMatrix(getComputedStyle(element).transform).m41 - x) < 1;
    }, {id:moved.id, x:targetX}, {timeout:2500});
    await page.keyboard.press('Control+z');
    await page.getByText('Этот объект изменён в другой вкладке.', {exact:false}).waitFor();
    check((await state()).entities.find(item => item.id === moved.id).x === targetX, 'Undo overwrote a remote edit');
    await page.waitForFunction(x => Math.abs(new DOMMatrix(getComputedStyle(document.querySelector('[data-id="entity:module-0"]')).transform).m41-x)<1, targetX);
  } finally { await second.close(); }
  await page.reload();
  await page.getByRole('button', {name:'Приём заявок 10 элементов', exact:true}).waitFor();
  await page.route('**/api/**', route => route.abort('connectionrefused'));
  const disconnectedAt = Date.now();
  await page.locator('.connection.offline').waitFor({timeout:5000});
  const disconnectMs = Date.now() - disconnectedAt;
  await page.unroute('**/api/**');
  await page.locator('.connection.online').waitFor({timeout:6000});
  await page.screenshot({path:'output/playwright/stage1-interaction.png'});
  return {singleMove:true, neighboursStable:true, previewErrorPx:error, twoWindowSync:true, undoConflictProtected:true, disconnectMs};
}
