// Public snapshots are small; complete work proposals stay addressable by ID.
export function publicSnapshot(snapshot) {
  const compact=({_checkpoint,verification,...item})=>({...item,...(verification?{verification:{state:verification.state,reason:verification.reason,readability:verification.readability,at:verification.at,testStatus:verification.testStatus}}:{})});
  return {...snapshot,map:compact(snapshot.map||{}),areas:(snapshot.areas||[]).map(compact),entities:(snapshot.entities||[]).map(compact),relations:(snapshot.relations||[]).map(compact),work:(snapshot.work||[]).map(({id,title,status,targets,actor,updatedAt,session,provisional,note,verification,x,y,layoutVersion})=>({id,title,status,targets,actor,updatedAt,session,provisional,x,y,layoutVersion,note:String(note||"").slice(0,240),verificationState:verification?.state||null}))};
}

const collections=["areas","entities","relations","work"];
export function snapshotDelta(previous,next) {
  if(!previous)return {type:"snapshot",snapshot:next};
  const changes={};
  for(const kind of collections) {
    const before=new Map((previous[kind]||[]).map(item=>[item.id,item]));
    const after=new Set((next[kind]||[]).map(item=>item.id));
    changes[kind]={upsert:(next[kind]||[]).filter(item=>JSON.stringify(before.get(item.id))!==JSON.stringify(item)),remove:[...before.keys()].filter(id=>!after.has(id)),order:(next[kind]||[]).map(item=>item.id)};
  }
  const fields=Object.fromEntries(Object.entries(next).filter(([key,value])=>!collections.includes(key)&&JSON.stringify(previous[key])!==JSON.stringify(value)));
  const removedFields=Object.keys(previous).filter(key=>!Object.hasOwn(next,key));
  return {type:"delta",baseRevision:previous.revision,revision:next.revision,changes,fields,removedFields};
}
