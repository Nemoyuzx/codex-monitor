import assert from 'node:assert/strict';
import test from 'node:test';
import { SUPPORTED_LOCALES, normalizeLocale, resolveLocale, getLocale, withLocale,
  createTranslator, formatAgo } from './i18n.mjs';
import { optionsCatalog } from './locales/options.mjs';
import { dashboardCatalog } from './locales/dashboard.mjs';
import resourceCatalog from './locales/resource.mjs';
import { statusMessages } from './locales/status.mjs';

test('POSIX locale tags normalize script/region aliases without accepting unrelated languages', () => {
  for (const [input, expected] of Object.entries({ 'en_US.UTF-8':'en', 'en-GB':'en', 'ja_JP.UTF-8':'ja',
    zh:'zh-CN','zh-Hans-CN':'zh-CN','zh_Hant_HK.UTF-8':'zh-TW','zh-TW':'zh-TW','zh_MO':'zh-TW',
    'C.UTF-8':'en', POSIX:'en' })) assert.equal(normalizeLocale(input),expected);
  for (const input of ['','auto','es-ES','not-a-locale',undefined,null]) assert.equal(normalizeLocale(input),null);
});

test('CLI locale selection honors explicit and standard environment precedence', () => {
  const env={CODEX_MONITOR_LANG:'ja',LC_ALL:'zh_TW.UTF-8',LC_MESSAGES:'zh_CN.UTF-8',LANG:'en_US.UTF-8'};
  assert.equal(resolveLocale('en',env),'en');
  assert.equal(resolveLocale('auto',env),'ja');
  assert.equal(resolveLocale('auto',{...env,CODEX_MONITOR_LANG:''}),'zh-TW');
  assert.equal(resolveLocale('auto',{LC_MESSAGES:'zh_CN.UTF-8',LANG:'ja_JP.UTF-8'}),'zh-CN');
  assert.equal(resolveLocale('auto',{LANG:'ja_JP.UTF-8'}),'ja');
  assert.equal(resolveLocale('auto',{LC_ALL:'es_ES.UTF-8',LANG:'zh_CN.UTF-8'}),'en');
  assert.equal(resolveLocale('auto',{}),'en');
  assert.throws(()=>resolveLocale('es',env),/Unsupported language/);
});

test('scoped locale restores on exceptions and isolates concurrent async renders', async () => {
  const initial=getLocale();
  assert.throws(()=>withLocale('en',()=>{assert.equal(getLocale(),'en');throw Error('expected');}),/expected/);
  assert.equal(getLocale(),initial);
  const seen=await Promise.all(['en','ja','zh-TW'].map(locale=>withLocale(locale,async()=>{
    await new Promise(resolve=>setTimeout(resolve,3));
    assert.equal(getLocale(),locale);
    return withLocale('zh-CN',()=>getLocale())+':'+getLocale();
  })));
  assert.deepEqual(seen,['zh-CN:en','zh-CN:ja','zh-CN:zh-TW']);
  assert.equal(getLocale(),initial);
});

test('translation interpolates values once and never translates user strings or prototype properties', () => {
  const t=createTranslator({ example:{'zh-CN':'用户 {value}',en:'User {value}'} });
  const user='用户 {value} 中文 --lang=ja';
  assert.equal(withLocale('en',()=>t('example',{value:user})),'User '+user);
  assert.equal(t('example',{},'ja'),'User {value}');
  assert.equal(t('__proto__',{},'en'),'__proto__');
  assert.equal(t('unregistered',{},'en'),'unregistered');
});

test('locale-specific relative time handles unavailable and future timestamps safely', () => {
  assert.match(formatAgo(0,120_000,'en'),/2 minutes ago/);
  assert.match(formatAgo(0,120_000,'ja'),/2.*分前/);
  assert.match(formatAgo(120_000,0,'en'),/now/);
  assert.equal(formatAgo(null,NaN,'en'),'—');
  assert.equal(formatAgo(null,120_000,'en'),'—');
  assert.equal(formatAgo(undefined,120_000,'en'),'—');
});

test('every shipped catalog has all four complete translations with the same interpolation fields', () => {
  const catalogs={optionsCatalog,dashboardCatalog,resourceCatalog,statusMessages};
  const fields=s=>[...String(s).matchAll(/\{([A-Za-z0-9_]+)\}/g)].map(m=>m[1]).sort();
  for(const [name,catalog] of Object.entries(catalogs)){
    assert.ok(Object.keys(catalog).length>0,name);
    for(const [key,entry] of Object.entries(catalog)){
      const expected=fields(entry['zh-CN']);
      for(const locale of SUPPORTED_LOCALES){
        assert.equal(typeof entry[locale],'string',name+':'+key+':'+locale);
        assert.ok(entry[locale].trim(),name+':'+key+':'+locale+' empty');
        assert.deepEqual(fields(entry[locale]),expected,name+':'+key+':'+locale+' placeholders');
      }
    }
  }
});

