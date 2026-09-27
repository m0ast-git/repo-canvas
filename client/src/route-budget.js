export const MAX_VISIBLE_ROUTES=60;

export function routeBudget(routes,{selection,areaId="all",flows=[]}={}) {
  if(routes.length<=MAX_VISIBLE_ROUTES)return routes;
  const relationIds=new Set((selection?.route?.relations||[]).map(item=>item.id));
  const primary=new Set(flows.flatMap(flow=>(flow.transitions||[]).map(step=>step.relationId)));
  const selected=selection&&`${selection.kind}:${selection.id}`;
  // A large unfocused graph is represented by area aggregates. Do not spend a
  // routing transaction on unrelated connectors hidden beneath that overview.
  const candidates=relationIds.size?routes.filter(route=>(route.relations||[]).some(item=>relationIds.has(item.id))):["entity","work"].includes(selection?.kind)?routes.filter(route=>route.source===selected||route.target===selected):areaId!=="all"?routes.filter(route=>route.sourceAreaId===areaId&&(route.targetAreaId===areaId||route.type==="work")):[];
  const score=route=>{
    if((route.relations||[]).some(item=>relationIds.has(item.id)))return 100;
    if(route.source===selected||route.target===selected)return 90;
    if(areaId!=="all"&&(route.sourceAreaId===areaId||route.targetAreaId===areaId))return 80;
    if((route.relations||[]).some(item=>primary.has(item.id)))return 50;
    return route.type==="work"?40:route.sourceAreaId!==route.targetAreaId?30:10;
  };
  return [...candidates].sort((a,b)=>score(b)-score(a)||a.id.localeCompare(b.id)).slice(0,MAX_VISIBLE_ROUTES);
}
