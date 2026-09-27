import {Worker, isMainThread, parentPort, workerData} from 'node:worker_threads';

export function runArchitectInWorker({signal,onProgress,...options}={}) {
  return new Promise((resolve,reject)=>{
    const worker=new Worker(new URL(import.meta.url),{workerData:options});
    let settled=false;
    const finish=(error,result)=>{if(settled)return;settled=true;signal?.removeEventListener('abort',abort);if(error)reject(error);else resolve(result);};
    const abort=()=>worker.postMessage({type:'abort'});
    signal?.addEventListener('abort',abort,{once:true});
    if(signal?.aborted)abort();
    worker.on('message',message=>{
      if(message.type==='progress')onProgress?.(message.value);
      if(message.type==='done')finish(null,message.value);
      if(message.type==='failed')finish(Object.assign(new Error(message.error),{audit:message.audit}));
    });
    worker.on('error',error=>finish(error));
    worker.on('exit',code=>{if(!settled)finish(new Error(`Построение остановилось до сохранения карты (код ${code}).`));});
  });
}

if(!isMainThread) {
  const controller=new AbortController();
  parentPort.on('message',message=>{if(message.type==='abort')controller.abort();});
  try {
    const {runArchitect}=await import('./architect.mjs');
    const result=await runArchitect({...workerData,signal:controller.signal,onProgress:value=>parentPort.postMessage({type:'progress',value})});
    const {state,...value}=result;
    parentPort.postMessage({type:'done',value});
  } catch(error) {parentPort.postMessage({type:'failed',error:error.message,audit:error.audit});}
  finally {parentPort.close();}
}
