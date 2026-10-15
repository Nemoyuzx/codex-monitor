import test from 'node:test';
import assert from 'node:assert/strict';
import { createTopSampler, parseTopSnapshot } from './top-sampler.mjs';

const fixture = (packets=10, bytes=1, disk=10) => [
  'Processes: 100 total, 2 running, 98 sleeping, 300 threads',
  'CPU usage: 12.0% user, 8.0% sys, 80.0% idle',
  'PhysMem: 12G used (2G wired, 1G compressor), 4G unused',
  '1,000(0) swapins, 2,000(0) swapouts',
  'Networks: packets: '+packets+'/'+bytes+'K in, '+(packets+1)+'/'+(bytes+1)+'K out',
  'Disks: '+disk+'/'+bytes+'M read, '+(disk+2)+'/'+(bytes+2)+'M written',
].join('\n');

test('top counters retain units and establish rates only from two valid timed observations',()=>{
  const first=parseTopSnapshot(fixture(),1000);
  assert.equal(first.netInRate,null);assert.equal(first.diskReadRate,null);
  assert.equal(first.memUsed,12*1024**3);assert.equal(first.memComp,1024**3);
  assert.equal(first.cpuIdle,80);assert.equal(first.swapins,1000);
  const second=parseTopSnapshot(fixture(20,3,30),3000,first);
  assert.equal(second.netInRate,1024);assert.equal(second.netPktInRate,5);
  assert.equal(second.diskReadRate,1024**2);assert.equal(second.diskOpReadRate,10);
  assert.equal(parseTopSnapshot(fixture(20,3,30),4000,second).netInRate,0);
});

test('missing/reset counters and clock rollback stay unknown and cannot bridge a failed sample',()=>{
  const first=parseTopSnapshot(fixture(20,5,30),1000);
  const missing=parseTopSnapshot('',2000,first);
  for(const key of ['netInRate','netOutRate','netPktInRate','diskReadRate','diskOpWriteRate'])assert.equal(missing[key],null);
  assert.equal(parseTopSnapshot(fixture(30,8,40),3000,missing).netInRate,null);
  assert.equal(parseTopSnapshot(fixture(10,1,5),2000,first).netInRate,null);
  assert.equal(parseTopSnapshot(fixture(30,8,40),900,first).netInRate,null);
  assert.equal(parseTopSnapshot(fixture(30,8,40),Infinity,first).netInRate,null);
});

test('top sampler is single-flight with bounded cache, force and clock rollback refresh',async()=>{
  let at=1000,calls=0,release;
  const sampler=createTopSampler({now:()=>at,run:async()=>{calls++;await new Promise(r=>release=r);return {stdout:fixture()};}});
  const first=sampler.sample(),same=sampler.sample();assert.equal(first,same);
  assert.equal(calls,1,'launch immediately so top overlaps the caller\'s synchronous sampling');
  await Promise.resolve();assert.equal(calls,1);release();const value=await first;
  at=1500;assert.equal(await sampler.sample(),value);assert.equal(calls,1);
  const forced=sampler.sample({force:true});await Promise.resolve();release();await forced;assert.equal(calls,2);
  at=900;const rollback=sampler.sample();await Promise.resolve();release();await rollback;assert.equal(calls,3);
});

test('aborted top work settles without invented values or launching an already-aborted subprocess',async()=>{
  const controller=new AbortController();let calls=0;
  const sampler=createTopSampler({run:async(_file,_args,{signal})=>{
    calls++;return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true}));
  }});
  const pending=sampler.sample({signal:controller.signal});await Promise.resolve();controller.abort();
  const value=await pending;assert.equal(value.netInRate,null);assert.equal(value.memUsed,undefined);
  await sampler.sample({force:true,signal:controller.signal});assert.equal(calls,1);
});

