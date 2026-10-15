import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root=path.dirname(fileURLToPath(import.meta.url));
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function deadline(promise,timeout,message){
  let timer;
  try{return await Promise.race([promise,new Promise((_resolve,reject)=>{timer=setTimeout(()=>reject(Error(message)),timeout);})]);}
  finally{clearTimeout(timer);}
}
async function until(predicate,timeout=12_000){
  const deadline=Date.now()+timeout;
  while(Date.now()<deadline){if(predicate())return;await wait(10);}
  throw Error('Timed out waiting for CLI lifecycle condition');
}
async function fixture(callback){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'codex-monitor-lifecycle-'));
  const bin=path.join(directory,'bin');fs.mkdirSync(bin);
  const stub=path.join(directory,'host-tool.mjs');
  fs.writeFileSync(stub,'#!'+process.execPath+'\n'+
    "import fs from 'node:fs';import path from 'node:path';\n"+
    "if(path.basename(process.argv[1])==='top'&&process.env.TOP_STARTED){fs.writeFileSync(process.env.TOP_STARTED,String(process.pid));setTimeout(()=>process.exit(0),10000);}else process.exit(0);\n",{mode:0o755});
  for(const name of ['sysctl','memory_pressure','vm_stat','top','ps','pgrep','ioreg','netstat','scutil','route','ifconfig','pmset','du','df','curl'])fs.symlinkSync(stub,path.join(bin,name));
  let child,closed,stdout='',stderr='',ended=false;
  const start=(extra={})=>{
    child=spawn(process.execPath,[path.join(root,'bin/codex-monitor.mjs'),'--watch','--json','--no-probes','--lang','en','--metrics-db',path.join(directory,'absent.sqlite')],{
      cwd:directory,env:{...process.env,CODEX_HOME:directory,PATH:bin,LC_ALL:'C',HTTP_PROXY:'',HTTPS_PROXY:'',ALL_PROXY:'',http_proxy:'',https_proxy:'',all_proxy:'',...extra},stdio:['ignore','pipe','pipe']
    });
    child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
    child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);
    closed=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>{ended=true;resolve({code,signal});});});
  };
  const frames=()=>stdout.split('\n').filter(Boolean).flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}});
  try{await callback({directory,start,frames,close:()=>closed,kill:()=>child.kill('SIGTERM'),stderr:()=>stderr});}
  finally{
    if(child&&!ended){child.kill('SIGTERM');try{await deadline(closed,1000,'Cleanup timeout');}catch{}if(!ended)child.kill('SIGKILL');await closed;}
    fs.rmSync(directory,{recursive:true,force:true});
  }
}

test('watch reconnects when a missing log database is created after startup without restarting',async()=>{
  await fixture(async({directory,start,frames,close,kill,stderr})=>{
    start();await until(()=>frames().length>0);
    assert.equal(frames()[0].activity.availability.logs,false);
    const filename=path.join(directory,'logs_1.sqlite'),db=new DatabaseSync(filename);
    db.exec('CREATE TABLE logs (id INTEGER PRIMARY KEY, ts INTEGER, level TEXT, target TEXT, feedback_log_body TEXT)');
    db.prepare('INSERT INTO logs(ts,level,target,feedback_log_body) VALUES(?,?,?,?)').run(Math.floor(Date.now()/1000),'WARN','lifecycle-fixture','private test body');
    db.close();
    const hash=()=>createHash('sha256').update(fs.readFileSync(filename)).digest('hex'),before=hash();
    await until(()=>frames().some(frame=>frame.activity.availability.logs===true));
    const recovered=frames().find(frame=>frame.activity.availability.logs===true);
    assert.equal(recovered.activity.alerts.warn10m,1);
    assert.ok(!JSON.stringify(recovered).includes('private test body'));
    kill();assert.equal((await close()).code,0,stderr());
    assert.equal(hash(),before,'read-only monitor changed the source database');
  });
});

test('SIGTERM interrupts an in-progress top subprocess instead of waiting for its timeout',async()=>{
  await fixture(async({directory,start,close,kill,stderr})=>{
    const marker=path.join(directory,'top-started');
    start({TOP_STARTED:marker});await until(()=>fs.existsSync(marker));
    const pid=Number(fs.readFileSync(marker,'utf8')),at=Date.now();
    kill();const result=await deadline(close(),2800,'Quit remained blocked by top');
    assert.equal(result.code,0,stderr());assert.ok(Date.now()-at<2800);
    await until(()=>{try{process.kill(pid,0);return false;}catch{return true;}},1000);
  });
});

