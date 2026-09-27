import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

// Run in a separate process: an unhandled rejection must fail this test even
// when the caller catches the eventual timeout from runCodexStructured.
for (const mode of ['timeout','abort','malformed','success','reconnected']) {
  test(`model process ${mode} does not terminate its host`, () => {
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'canvas-lifecycle-'));
    try {
      fs.writeFileSync(path.join(root,'exec'), ['success','reconnected'].includes(mode)
        ? `console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'{"ok":true}'}}));`
        : mode==='malformed' ? `console.log('not json');setInterval(()=>{},100);` : `setInterval(()=>{},100);`);
      const moduleUrl=new URL('../repo-canvas/scripts/model-runtime.mjs',import.meta.url).href;
      const script=`import {runCodexStructured} from ${JSON.stringify(moduleUrl)};
        const controller=new AbortController();
        if(${JSON.stringify(mode)}==='abort')setTimeout(()=>controller.abort(),150);
        try {
          const result=await runCodexStructured({role:'observer',cwd:process.cwd(),prompt:'test',outputSchema:{type:'object'},timeoutMs:350,signal:controller.signal,
            profile:{model:'fixture'},session:{cwd:process.cwd(),codexHome:process.cwd(),profile:{model:'fixture'},executable:process.execPath,turns:0,threadId:'fixture'}});
          console.log('result:'+result.value.ok);
        } catch(error) {console.log('caught:'+error.message);}
        await new Promise(resolve=>setTimeout(resolve,150));console.log('host alive');`;
      // A fresh invocation rather than resume, while avoiding real credentials.
      const runnable=script.replace("threadId:'fixture'","threadId:null");
      if(['success','reconnected'].includes(mode))fs.writeFileSync(path.join(root,'exec'),`console.log(JSON.stringify({type:'thread.started',thread_id:'fixture'}));`+(mode==='reconnected'?`console.log(JSON.stringify({type:'error',message:'Reconnecting... stream disconnected'}));`:``)+fs.readFileSync(path.join(root,'exec'),'utf8')+`console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:8,output_tokens:2}}));`);
      const result=spawnSync(process.execPath,['--input-type=module','-e',runnable],{cwd:root,encoding:'utf8',timeout:6000,windowsHide:true});
      assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/host alive/);
      assert.match(result.stdout,['success','reconnected'].includes(mode)?/result:true/:/caught:/);
    } finally {fs.rmSync(root,{recursive:true,force:true});}
  });
}
