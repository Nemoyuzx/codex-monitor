import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { renderDemo, PREVIEW_FILES } from './scripts/demo.mjs';
import { SUPPORTED_LOCALES } from './i18n.mjs';

const root=path.dirname(fileURLToPath(import.meta.url));
const visibleText=svg=>[...svg.matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/g)].map(match=>match[1]
  .replaceAll('&amp;','&').replaceAll('&lt;','<').replaceAll('&gt;','>').replaceAll('&quot;','"')).join('');

test('every localized preview is deterministic, scoped and matches the committed README asset',()=>{
  for(const locale of SUPPORTED_LOCALES){
    const svg=renderDemo({locale});
    assert.equal(svg,renderDemo({locale}));
    assert.equal(svg,fs.readFileSync(path.join(root,'docs',PREVIEW_FILES[locale]),'utf8'),locale+' preview is stale');
    assert.ok(svg.includes('width="2056" height="1250"'));
    assert.ok(svg.includes('lang="'+locale+'"'));
    const text=visibleText(svg);
    assert.ok(text.includes('DEMO'));
    if(locale==='en') assert.ok(!/\p{Script=Han}/u.test(text),'English preview includes untranslated built-in text');
  }
});

test('redactions remove originals from text, attributes and metadata rather than covering recoverable text',()=>{
  const forbidden=['example-model','示例会话A','示例会话B','192.0.2.20','192.0.2.1','192.0.2.53','192.0.2.10','203.0.113.20','203.0.113.40','2001:db8::','demo-a','demo-b','/Users/','/home/'];
  for(const locale of SUPPORTED_LOCALES){
    const svg=renderDemo({locale}),text=visibleText(svg).replace(/\s+/g,'');
    for(const value of forbidden){assert.ok(!text.includes(value),locale+': exposed '+value);assert.ok(!svg.includes(value),locale+': source exposed '+value);}
    assert.ok((svg.match(/data-redacted="true"/g)||[]).length>=16,locale+' missing opaque masks');
    assert.ok(!text.includes('█'),'mask glyphs must become opaque shapes');
    assert.ok(!/https?:\/\//.test(text),'a network endpoint remains in visible text');
    assert.ok(!/<(?:image|script|foreignObject)\b|\b(?:href|onload)=/i.test(svg),'unexpected active or external SVG content');
  }
});

test('preview CLI can generate one language outside the checkout and rejects invalid flags before writing',()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'codex-monitor-preview-'));
  try{
    const output=path.join(directory,'output');
    const run=args=>spawnSync(process.execPath,[path.join(root,'scripts/demo.mjs'),...args],{cwd:directory,encoding:'utf8'});
    const valid=run(['--lang=en','--output-dir',output]);assert.equal(valid.status,0,valid.stderr);
    assert.deepEqual(fs.readdirSync(output),['preview-en.svg']);
    assert.equal(fs.readFileSync(path.join(output,'preview-en.svg'),'utf8'),renderDemo({locale:'en'}));
    const invalidPath=path.join(directory,'should-not-exist');
    const invalid=run(['--lang','unsupported','--output-dir',invalidPath]);
    assert.equal(invalid.status,1);assert.equal(fs.existsSync(invalidPath),false);
    assert.equal(run(['--unexpected']).status,1);
  }finally{fs.rmSync(directory,{recursive:true,force:true});}
});

test('all READMEs link every language and its matching redacted preview',()=>{
  const readmes={'zh-CN':'README.md','zh-TW':'README.zh-TW.md',en:'README.en.md',ja:'README.ja.md'};
  for(const [locale,filename] of Object.entries(readmes)){
    const text=fs.readFileSync(path.join(root,filename),'utf8');
    for(const target of Object.values(readmes))assert.ok(text.includes(']('+target+')'),filename+': missing '+target);
    assert.ok(text.includes('(docs/'+PREVIEW_FILES[locale]+')'),filename+': wrong preview language');
  }
});

