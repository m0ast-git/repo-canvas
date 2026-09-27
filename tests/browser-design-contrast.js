// Uses computed colors and ancestor opacity; disabled/hidden controls are excluded.
export function inspectDesignContrast() {
  const parse=value=>{const numbers=value.match(/[\d.]+/g)?.map(Number);if(!numbers)return null;if(value.startsWith('color(srgb'))return numbers.slice(0,3).map(number=>number*255).concat(numbers[3]??1);if(value.startsWith('rgb'))return numbers.slice(0,3).concat(numbers[3]??1);return null;};
  const blend=(front,back)=>front.slice(0,3).map((value,index)=>value*front[3]+back[index]*(1-front[3]));
  const luminance=color=>color.slice(0,3).map(value=>{const s=value/255;return s<=.04045?s/12.92:((s+.055)/1.055)**2.4;}).reduce((sum,value,index)=>sum+value*[.2126,.7152,.0722][index],0);
  const ratio=(first,second)=>(Math.max(luminance(first),luminance(second))+.05)/(Math.min(luminance(first),luminance(second))+.05);
  const violations=[],samples=[];
  const root=document.querySelector('dialog[open]')||document;
  for(const element of root.querySelectorAll('h1,h2,h3,p,strong,small,span,button,a,label,dt,dd,summary,output,input,textarea,select')){
    if(element.closest('[disabled],[aria-hidden="true"]'))continue;
    const rect=element.getBoundingClientRect(),style=getComputedStyle(element);
    if(!rect.width||!rect.height||rect.bottom<0||rect.top>innerHeight||rect.right<0||rect.left>innerWidth||style.visibility==='hidden')continue;
    const text=(element.value||element.textContent||'').trim();if(!text||element.children.length&&[...element.children].some(child=>child.textContent?.trim()))continue;
    let opacity=1,background=[255,255,255],backgroundFound=false;
    for(let parent=element;parent;parent=parent.parentElement){const css=getComputedStyle(parent);opacity*=Number(css.opacity);const color=parse(css.backgroundColor);if(!backgroundFound&&color?.[3]===1){background=color;backgroundFound=true;}}
    if(opacity<.01)continue;
    const foreground=parse(style.color);if(!foreground)continue;
    const actual=blend([foreground[0],foreground[1],foreground[2],foreground[3]*opacity],background),contrast=ratio(actual,background);
    const entry={text:text.slice(0,100),contrast:Number(contrast.toFixed(2)),color:style.color,background:background.slice(0,3),opacity};
    samples.push(entry);if(contrast<4.5)violations.push(entry);
  }
  return {checked:samples.length,minimum:Math.min(...samples.map(item=>item.contrast)),violations};
}
