async(page)=>{
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  const check=(value,message)=>{if(!value)throw new Error(message);};
  await page.setViewportSize({width:1600,height:1000});await page.reload();
  const nav=page.getByRole('navigation',{name:'Разделы проекта'});
  await nav.getByRole('button',{name:'Сценарии',exact:true}).click();
  await page.getByRole('heading',{name:'Выберите сценарий',exact:true}).waitFor();
  await page.locator('.flow-title').first().click();
  await page.locator('.flow-steps').waitFor();
  check(await page.getByRole('button',{name:'Все сценарии',exact:false}).count()===1,'No explicit return to scenarios');
  await page.locator('.flow-steps button').nth(1).click();
  await page.getByRole('button',{name:'Переименовать',exact:true}).waitFor();
  await page.waitForTimeout(650);
  check(await page.evaluate(()=>{
    const id=document.querySelector('.app-shell').dataset.selection;
    const node=document.querySelector(`[data-id="${id}"]`);if(!node)return false;
    const rect=node.getBoundingClientRect(),frame=document.querySelector('.canvas-wrap').getBoundingClientRect();
    return rect.width>0&&rect.x>=frame.left&&rect.right<=frame.right&&rect.y>=frame.top&&rect.bottom<=frame.bottom;
  }),'Scenario step did not bring its element into view');
  await page.getByRole('button',{name:'К сценарию',exact:false}).click();
  await page.locator('.flow-steps').waitFor();
  await page.screenshot({path:'output/playwright/design-scenario-navigation.png'});
  await nav.getByRole('button',{name:'Решения',exact:true}).click();
  await page.getByRole('heading',{name:'Почему устроено так',exact:true}).waitFor();
  await nav.getByRole('button',{name:'Настройки',exact:true}).click();
  await page.getByRole('heading',{name:'Исполнители',exact:true}).waitFor();
  await nav.getByRole('button',{name:'Карта',exact:true}).click();
  await page.getByRole('button',{name:'Показать всё',exact:true}).click();
  await page.waitForTimeout(900);
  const measurements=[];
  for(const [tier,name] of [['area','Области'],['entity','Элементы'],['detail',null]]){
    if(name) await page.locator('.zoom-tiers').getByRole('button',{name,exact:true}).click();
    else {
      for(let attempt=0;attempt<6;attempt++){
        const zoom=await page.locator('.react-flow__viewport').evaluate(element=>new DOMMatrix(getComputedStyle(element).transform).a);
        if(zoom>=1.15)break;
        await page.getByRole('button',{name:'+',exact:true}).click();await page.waitForTimeout(350);
      }
    }
    await page.waitForTimeout(900);
    const measured=await page.evaluate(()=>{
      const viewport=document.querySelector('.react-flow__viewport');const zoom=new DOMMatrix(getComputedStyle(viewport).transform).a;
      const frame=document.querySelector('.canvas-wrap').getBoundingClientRect();
      const rect=element=>{const box=element.getBoundingClientRect();return {x:box.x,y:box.y,width:box.width,height:box.height};};
      const visible=element=>{const box=rect(element);const style=getComputedStyle(element);return box.width>0&&box.height>0&&style.visibility!=='hidden'&&Number(style.opacity)>0&&box.x<frame.right&&box.x+box.width>frame.left&&box.y<frame.bottom&&box.y+box.height>frame.top;};
      const overlap=(a,b)=>a.x+.5<b.x+b.width&&a.x+a.width-.5>b.x&&a.y+.5<b.y+b.height&&a.y+a.height-.5>b.y;
      const captions=[...document.querySelectorAll('.route-label')].filter(visible).map(element=>({...rect(element),text:element.textContent,font:Number.parseFloat(getComputedStyle(element).fontSize)*Number(getComputedStyle(element).getPropertyValue('--label-scale')||1)*zoom}));
      const targets=[...document.querySelectorAll('.entity-node,.person-node,.work-node,.group-node>header,.area-node>header')].filter(visible).map(element=>({...rect(element),text:element.textContent.slice(0,45)}));
      const collisions=[];
      for(let i=0;i<captions.length;i++){for(let j=i+1;j<captions.length;j++)if(overlap(captions[i],captions[j]))collisions.push([captions[i].text,captions[j].text]);for(const target of targets)if(overlap(captions[i],target))collisions.push([captions[i].text,target.text]);}
      const headers=[...document.querySelectorAll('.area-node>header')].filter(visible).map(element=>{const heading=element.querySelector('h2');return Number.parseFloat(getComputedStyle(heading).fontSize)*new DOMMatrix(getComputedStyle(element).transform).a*zoom;});
      const heading=zoom<.5?Math.min(...headers):15*zoom;
      return {zoom,captions:captions.length,captionMaxPx:Math.max(0,...captions.map(c=>c.font)),headingMinPx:heading,collisions};
    });
    check(!measured.collisions.length,'Overlapping captions: '+JSON.stringify(measured.collisions));
    check(measured.captionMaxPx<=measured.headingMinPx*.65,'Relationship text dominates headings');
    if(tier==='area')check(measured.zoom<.5&&measured.captions>0,'Area overview must have readable relationship captions');
    if(tier==='entity')check(measured.zoom>=.5,'Entity level stayed too distant');
    if(tier==='detail')check(measured.zoom>=1.15&&measured.captions>0,'Detail caption hierarchy was not exercised');
    measurements.push({tier,...measured});
    await page.screenshot({path:`output/playwright/design-${tier}.png`});
  }
  await page.locator('.route-label').first().click();
  await page.locator('.context-body').getByText('СВЯЗЬ',{exact:true}).waitFor();
  await page.waitForTimeout(300);await page.screenshot({path:'output/playwright/design-selected-relationship.png'});
  await nav.getByRole('button',{name:'Сценарии',exact:true}).click();
  await page.waitForTimeout(500);await page.screenshot({path:'output/playwright/design-focused-flow.png'});
  await page.setViewportSize({width:390,height:844});await page.waitForTimeout(250);
  check(await nav.getByRole('button',{name:'Сценарии',exact:true}).isVisible(),'Primary navigation disappears on narrow screens');
  check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Horizontal overflow');
  check(await page.locator('.context-panel').evaluate(panel=>{
    const box=panel.getBoundingClientRect();
    for(let y=box.top+70;y<box.bottom-20;y+=40)for(let x=box.left+20;x<box.right-20;x+=40)if(!panel.contains(document.elementFromPoint(x,y)))return false;
    return true;
  }),'Canvas overlays cover the context panel');
  await page.screenshot({path:'output/playwright/design-mobile.png'});
  await page.setViewportSize({width:1600,height:1000});
  check(!errors.length,errors.join('\n'));
  return {directNavigation:true,scenarioStaysVisible:true,oneClickReturn:true,measurements,errors};
}
