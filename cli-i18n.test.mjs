import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { statusMessages } from './locales/status.mjs';
import { truncVis } from './resource-panel.mjs';

const root=path.dirname(fileURLToPath(import.meta.url));
const languages=['zh-CN','zh-TW','en','ja'];
function isolated(callback){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'codex-monitor-i18n-'));
  const stub=path.join(directory,'host-tool.mjs');
  fs.writeFileSync(stub,'process.exit(0);\n');
  const bootstrap=path.join(directory,'host-bootstrap.mjs');
  fs.writeFileSync(bootstrap,[
    "import cp from 'node:child_process';",
    "import {syncBuiltinESMExports} from 'node:module';",
    'const execFile=cp.execFile;',
    "cp.execSync=()=>'';cp.execFileSync=()=>'';",
    'cp.execFile=(file,args,options,callback)=>execFile(process.execPath,[process.env.CODEX_MONITOR_TEST_STUB,file],options,callback);',
    'syncBuiltinESMExports();',
  ].join('\n'));
  const env={...process.env,CODEX_HOME:directory,HOME:directory,USERPROFILE:directory,LC_ALL:'C',LANG:'C',CODEX_MONITOR_LANG:'zh-CN',
    CODEX_MONITOR_TEST_STUB:stub,
    HTTP_PROXY:'',HTTPS_PROXY:'',ALL_PROXY:'',http_proxy:'',https_proxy:'',all_proxy:''};
  const run=(args,nodeArgs=[])=>spawnSync(process.execPath,[...nodeArgs,'--import',pathToFileURL(bootstrap).href,path.join(root,'bin/codex-monitor.mjs'),...args],{
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

test('actual Windows first sample preserves unknown process CPU and still renders JSON and UI',()=>{
  isolated((run,directory)=>{
    const mock=path.join(directory,'windows-host.mjs');
    const snapshot={
      processes:[{pid:42424242,ppid:4,name:'explorer.exe',executable:'C:\\Windows\\explorer.exe',command:'C:\\Windows\\explorer.exe',
        cpu100ns:'10000000',rssBytes:'4194304',startedAt:Date.now()-10000}],
      networks:[{name:'Fixture Ethernet',ifIndex:1,inBytes:'1000',outBytes:'2000'}],
      routes:[{name:'Fixture Ethernet',ifIndex:1,prefix:'0.0.0.0/0',metric:1,interfaceMetric:1}],
      disks:[{id:'0',readBytes:'1024',writeBytes:'2048',readOps:'1',writeOps:'2'}],battery:[],
      operatingSystem:{TotalVisibleMemorySize:'1048576',FreePhysicalMemory:'524288'},pagefiles:[],
    };
    fs.writeFileSync(mock,[
      "import cp from 'node:child_process';",
      "import {syncBuiltinESMExports} from 'node:module';",
      "Object.defineProperty(process,'platform',{value:'win32'});",
      'const snapshot='+JSON.stringify(snapshot)+';',
      "cp.execFileSync=file=>/powershell\\.exe$/i.test(String(file))?JSON.stringify(snapshot):'';",
      'syncBuiltinESMExports();',
    ].join('\n'));
    const nodeArgs=['--import',pathToFileURL(path.join(directory,'host-bootstrap.mjs')).href,'--import',pathToFileURL(mock).href];
    const result=run(['--once','--json','--no-probes','--lang','en'],nodeArgs);
    assert.equal(result.status,0,result.stderr);
    const measured=JSON.parse(result.stdout);
    assert.equal(measured.host.processes.topCpu[0].name,'explorer.exe');
    assert.equal(measured.host.processes.topCpu[0].cpuPercent,null);
    assert.equal(measured.host.network.inRate,null);
    const ui=run(['--once','--no-probes','--lang','en'],nodeArgs);
    assert.equal(ui.status,0,ui.stderr);
    assert.ok(ui.stdout.includes('explorer.exe —'));
    assert.ok(!/NaN|Infinity/.test(ui.stdout));
  });
});

test('actual diagnostics primary uses compact adaptive sections in every language and a wide terminal',()=>{
  isolated((run,directory)=>{
    const bootstrap=path.join(directory,'wide-terminal.mjs');
    fs.writeFileSync(bootstrap,'Object.defineProperty(process.stdout,"columns",{value:251,configurable:true});\n');
    const variants=[...languages.map(locale=>({locale,width:61,nodeArgs:[],color:'--no-color'})),
      {locale:'en',width:73,nodeArgs:['--import',pathToFileURL(bootstrap).href],color:'--color'}];
    const strip=value=>value.replace(/\x1b\[[0-9;?]*[A-Za-z]/g,'');
    const compact=value=>value.replace(/\s/g,'');
    for(const {locale,width,nodeArgs,color} of variants){
      const result=run(['--once','--view','diagnostics','--no-probes','--lang',locale,color,
        '--metrics-db',path.join(directory,'missing.sqlite')],nodeArgs);
      assert.equal(result.status,0,result.stderr);
      if(color==='--color') assert.ok(result.stdout.includes('\x1b['));
      const left=result.stdout.split('\n').map(line=>truncVis(strip(line),width).trimEnd());
      const titles=['processesTitle','networkTitle','storageTitle','verdictTitle'];
      const positions=titles.map(key=>left.findIndex(line=>line.startsWith('▍'+statusMessages[key][locale])));
      assert.ok(positions.every((index,i)=>index>=0&&(!i||index>positions[i-1])),locale+': all four primary headings must use the information renderer');
      const next=left.findIndex((line,i)=>i>positions[3]&&line.startsWith('▍'));
      const end=next<0?left.findLastIndex(Boolean)+1:next;
      const primary=left.slice(positions[0],end);
      assert.ok(primary.every(Boolean),locale+': no empty rows inside or between diagnostics primary sections');
      const text=compact(primary.join(''));
      for(const key of ['probesDisabled','noSpeed','verdictIncomplete','httpDisabled']){
        assert.ok(text.includes(compact(statusMessages[key][locale])),locale+': '+key);
      }
      const tokenLabel=compact(statusMessages.tokenTotal[locale].split(':')[0]);
      assert.ok(primary.some(line=>compact(line).includes(tokenLabel)&&line.includes('—')),locale+': unavailable cumulative tokens stay unknown');
      for(const level of ['ERROR','WARN','INFO','DEBUG','TRACE']) assert.ok(text.includes(level+'=—'),locale+': '+level);
      assert.ok(!/\{[A-Za-z0-9_]+\}/.test(primary.join('')));
      if(locale==='en') assert.ok(!/\p{Script=Han}/u.test(primary.join('')));
    }
  });
});

test('actual extension and running pages show discovered fixtures without exposing secrets or clipping active agents to the thread limit',()=>{
  isolated((run,directory)=>{
    const privateValue='never-output-private-fixture';
    const skill=path.join(directory,'skills','fixture-skill');fs.mkdirSync(skill,{recursive:true});
    fs.writeFileSync(path.join(skill,'SKILL.md'),'---\nname: fixture-skill\ndescription: Safe inventory fixture.\n---\n'+privateValue);
    fs.writeFileSync(path.join(directory,'config.toml'),'[mcp_servers.fixture-mcp]\ncommand = "codex-mcp-test-dummy"\n[mcp_servers.fixture-mcp.env]\nTOKEN = "'+privateValue+'"\n');
    const stateFile=path.join(directory,'state_fixture.sqlite'),historyFile=path.join(directory,'thread_history_fixture.sqlite');
    const state=new DatabaseSync(stateFile),history=new DatabaseSync(historyFile),now=Date.now();
    try{
      state.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,source TEXT,agent_nickname TEXT,name TEXT,title TEXT,model TEXT,archived INTEGER,tokens_used INTEGER,updated_at_ms INTEGER,created_at_ms INTEGER,cwd TEXT,cli_version TEXT);CREATE TABLE thread_spawn_edges(parent_thread_id TEXT,child_thread_id TEXT PRIMARY KEY);');
      history.exec('CREATE TABLE thread_turns(thread_id TEXT,turn_id TEXT,status TEXT,started_at INTEGER);CREATE TABLE thread_items(thread_id TEXT,turn_id TEXT,item_id TEXT,item_type TEXT,rollout_ordinal INTEGER,created_at_ms INTEGER,started_at_ms INTEGER,completed_at_ms INTEGER,item_json TEXT);');
      for(const [id,title,source,age]of [
        ['runtime-main','Fixture main task retained beyond the display limit','vscode',10000],
        ['runtime-agent','Fixture child worker retained beyond the display limit','subagent',5000],
        ['runtime-stale','Fixture stale worker must be excluded','subagent',7200000],
      ]){
        state.prepare('INSERT INTO threads VALUES(?,?,NULL,NULL,?,?,0,10,?,?,?,?)').run(id,source,title,'fixture-model',now,now-age,directory,'fixture');
        history.prepare('INSERT INTO thread_turns VALUES(?,?,?,?)').run(id,'turn-'+id,'inProgress',now-age);
      }
      state.prepare('INSERT INTO thread_spawn_edges VALUES(?,?)').run('runtime-main','runtime-agent');
    }finally{state.close();history.close();}
    const before=[stateFile,historyFile].map(file=>fs.readFileSync(file));
    const compact=value=>value.replace(/\x1b\[[0-9;?]*[A-Za-z]/g,'').replace(/\s/g,'');
    for(const locale of ['en','ja']){
      const extensions=run(['--once','--view','extensions','--no-probes','--lang',locale]);
      assert.equal(extensions.status,0,extensions.stderr);
      for(const value of ['fixture-mcp','fixture-skill','Safe inventory fixture.'])assert.ok(compact(extensions.stdout).includes(compact(value)),locale+': '+value);
      assert.ok(!extensions.stdout.includes(privateValue),'inventory must not output Skill bodies or MCP environment values');
      const running=run(['--once','--view','running','--threads','1','--no-probes','--lang',locale]);
      assert.equal(running.status,0,running.stderr);
      for(const name of ['Fixture main task retained beyond the display limit','Fixture child worker retained beyond the display limit']){
        assert.ok(compact(running.stdout).includes(compact(name)),locale+': '+name);
      }
      assert.ok(!running.stdout.includes('Fixture stale worker must be excluded'));
      assert.ok(!/\{[A-Za-z0-9_]+\}/.test(extensions.stdout+running.stdout));
    }
    for(const [index,file]of [stateFile,historyFile].entries())assert.deepEqual(fs.readFileSync(file),before[index],'CLI changed its read-only source');
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

