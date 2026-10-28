import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';import {join,resolve} from 'node:path';import {tmpdir} from 'node:os';import {loadConfig} from '../src/config.ts';
test('Windows BOM配置可读取，显式凭据位置相对配置解析，无效Github对象拒绝',t=>{
 const dir=mkdtempSync(join(tmpdir(),'radar-github-config-')),file=join(dir,'config.json');t.after(()=>rmSync(dir,{recursive:true,force:true}));
 writeFileSync(file,'\uFEFF'+JSON.stringify({dataDir:'data',topics:[],github:{credentialFile:'credentials/github.json'}}));assert.equal(loadConfig(file).github.credentialFile,resolve(dir,'credentials/github.json'));
 for(const github of ['invalid',[],null,{credentialFile:17},{credentialFile:'bad\npath'}]){writeFileSync(file,JSON.stringify({dataDir:'data',topics:[],github}));assert.throws(()=>loadConfig(file),{code:'INVALID_CONFIG'});}
});
