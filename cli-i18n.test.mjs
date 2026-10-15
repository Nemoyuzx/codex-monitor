import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { statusMessages } from './locales/status.mjs';

const root=path.dirname(fileURLToPath(import.meta.url));
const languages=['zh-CN','zh-TW','en','ja'];
function isolated(callback){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'codex-monitor-i18n-'));
  const bin=path.join(directory,'bin');
  fs.mkdirSync(bin);
  // Host tools return unavailable data; these tests exercise the actual CLI
  // without reading local conversations or depending on the machine's setup.
  const stub=path.join(directory,'host-tool.mjs');
  fs.writeFileSync(stub,'#!'+process.execPath+'\nprocess.exit(0);\n',{mode:0o755});
  for(const name of ['sysctl','memory_pressure','vm_stat','top','ps','pgrep','ioreg','netstat','scutil','route','ifconfig','pmset','du','df','curl']) fs.symlinkSync(stub,path.join(bin,name));
  const env={...process.env,CODEX_HOME:directory,PATH:bin,LC_ALL:'C',LANG:'C',CODEX_MONITOR_LANG:'zh-CN',
    HTTP_PROXY:'',HTTPS_PROXY:'',ALL_PROXY:'',http_proxy:'',https_proxy:'',all_proxy:''};
  const run=args=>spawnSync(process.execPath,[path.join(root,'bin/codex-monitor.mjs'),...args],{
    cwd:directory,env,encoding:'utf8',timeout:20_000,maxBuffer:2*1024*1024
  });
  try{return callback(run,directory);}finally{fs.rmSync(directory,{recursive:true,force:true});}
}

test('actual CLI help and validation suffix follow the requested language from any cwd',()=>{
  isolated(run=>{
    for(const locale of languages){
      const help=run(['--help','--lang',locale]);
      assert.equal(help.status,0,help.stderr);
      assert.ok(help.stdout.includes(statusMessages.helpTitle[locale]));
      assert.ok(help.stdout.includes('--lang'));
      const error=run(['--bad','--lang',locale]);
      assert.equal(error.status,1);
      assert.ok(error.stderr.includes(statusMessages.usageHint[locale]),locale+': '+error.stderr);
      if(locale==='en') assert.ok(!/\p{Script=Han}/u.test(error.stderr));
    }
  });
});

test('actual one-shot UI localizes without unresolved placeholders or hidden Chinese English labels',()=>{
  isolated((run,directory)=>{
    for(const locale of languages){
      const result=run(['--once','--no-probes','--lang',locale,'--metrics-db',path.join(directory,'missing.sqlite')]);
      assert.equal(result.status,0,result.stderr);
      assert.ok(result.stdout.includes(statusMessages.title[locale]));
      assert.ok(!/\{[A-Za-z0-9_]+\}/.test(result.stdout),locale+' unresolved message field');
      if(locale==='en') assert.ok(!/\p{Script=Han}/u.test(result.stdout),'English CLI contains untranslated built-in text');
    }
  });
});

test('locale changes preserve the machine-readable JSON schema and availability semantics',()=>{
  isolated((run,directory)=>{
    let shape;
    for(const locale of ['en','ja']){
      const result=run(['--once','--json','--no-probes','--lang',locale,'--metrics-db',path.join(directory,'missing.sqlite')]);
      assert.equal(result.status,0,result.stderr);
      const snapshot=JSON.parse(result.stdout);
      const current=Object.keys(snapshot).sort();
      if(shape) assert.deepEqual(current,shape);else shape=current;
      assert.equal(snapshot.networkProbes.disabled,true);
      assert.equal(snapshot.performance.available,false);
      assert.equal(Object.hasOwn(snapshot,'locale'),false);
      assert.equal(Object.hasOwn(snapshot,'lang'),false);
      assert.ok(Object.hasOwn(snapshot,'host')&&Object.hasOwn(snapshot,'activity'));
    }
  });
});

