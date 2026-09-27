import assert from 'node:assert/strict';
import test from 'node:test';
import { QueryObserver } from '@tanstack/react-query';
import { createProjectQueryClient, LIVE_KEY, liveQueryOptions, setLiveSnapshot, historySnapshotOptions, historyComparisonOptions, trimHistoryCache } from '../client/src/project-queries.js';

const response=value=>({ok:true,json:async()=>value});
test('concurrent readers share one fetch and historical comparison ignores Live revisions',async()=>{
  const client=createProjectQueryClient();let calls=0;
  const api=async()=>{calls++;return response({id:'cp-one'});};
  try {
    await Promise.all([client.fetchQuery(historySnapshotOptions(api,'cp-one')),client.fetchQuery(historySnapshotOptions(api,'cp-one'))]);
    assert.equal(calls,1);
    const a=historyComparisonOptions(api,'cp-one','cp-two',3),b=historyComparisonOptions(api,'cp-one','cp-two',4);
    assert.deepEqual(a.queryKey,b.queryKey);
    await client.fetchQuery(a);await client.fetchQuery(b);assert.equal(calls,2);
    assert.notDeepEqual(historyComparisonOptions(api,'cp-one',null,3).queryKey,historyComparisonOptions(api,'cp-one',null,4).queryKey);
  } finally {client.clear();}
});

test('a late Live fetch cannot overwrite a newer saved owner action or its layout seed',async()=>{
  const client=createProjectQueryClient();let release;let requested;
  const ready=new Promise(resolve=>requested=resolve);
  const api=async url=>url==='/api/revision'?response({revision:2}):new Promise(resolve=>{release=()=>resolve(response({revision:2,entities:[{id:'x',ownerLabel:'old'}]}));requested();});
  try {
    setLiveSnapshot(client,{revision:1,entities:[]});
    const fetch=client.fetchQuery({...liveQueryOptions(client,api),staleTime:0});await ready;
    setLiveSnapshot(client,{revision:3,entities:[{id:'x',ownerLabel:'saved'}],_layoutSeed:{layoutVersion:1}});
    release();await fetch;
    const saved=client.getQueryData(LIVE_KEY).snapshot;
    assert.equal(saved.revision,3);assert.equal(saved.entities[0].ownerLabel,'saved');assert.ok(saved._layoutSeed);
    setLiveSnapshot(client,{revision:3,entities:saved.entities});assert.ok(client.getQueryData(LIVE_KEY).snapshot._layoutSeed);
  } finally {client.clear();}
});

test('changing the observed checkpoint aborts the previous request through TanStack',async()=>{
  const client=createProjectQueryClient();const signals=new Map();let began;
  const ready=new Promise(resolve=>began=resolve);
  const api=(url,{signal})=>new Promise((resolve,reject)=>{signals.set(url,signal);signal.addEventListener('abort',()=>reject(new DOMException('Cancelled','AbortError')),{once:true});if(url.includes('cp-b'))resolve(response({_history:{id:'cp-b'}}));else began();});
  const observer=new QueryObserver(client,historySnapshotOptions(api,'cp-a'));
  const unsubscribe=observer.subscribe(()=>{});
  try {
    await ready;observer.setOptions(historySnapshotOptions(api,'cp-b'));
    await client.fetchQuery(historySnapshotOptions(api,'cp-b'));
    assert.equal(signals.get('/api/history/state?id=cp-a').aborted,true);
    assert.equal(observer.getCurrentResult().data._history.id,'cp-b');
  } finally {unsubscribe();client.clear();}
});

test('history cache is bounded without discarding the currently observed checkpoint',()=>{
  const client=createProjectQueryClient();
  const api=async()=>response({});
  const observer=new QueryObserver(client,{...historySnapshotOptions(api,'cp-0'),enabled:true});
  client.setQueryData(['history','state','cp-0'],{_history:{id:'cp-0'}});
  const unsubscribe=observer.subscribe(()=>{});
  try {
    for(let i=1;i<30;i++)client.setQueryData(['history','state','cp-'+i],{_history:{id:'cp-'+i}},{updatedAt:Date.now()+i});
    trimHistoryCache(client);
    assert.ok(client.getQueryData(['history','state','cp-0']));
    assert.ok(client.getQueryCache().findAll({queryKey:['history','state']}).length<=8);
  } finally {unsubscribe();client.clear();}
});
