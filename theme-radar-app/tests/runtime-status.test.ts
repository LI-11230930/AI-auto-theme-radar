import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {createRuntimeStatus,serviceVersion} from '../src/runtime-status.ts';
test('源码在进程存活期间新增/修改/删除均提示重连，不扫描配置或凭据',()=>{
 const dir=mkdtempSync(resolve(tmpdir(),'radar-version-'));try{writeFileSync(resolve(dir,'a.ts'),'export const x=1');writeFileSync(resolve(dir,'config.local.json'),'not inspected');const status=createRuntimeStatus(dir);assert.equal(status().restartRequired,false);assert.equal(status().serviceVersion,serviceVersion);writeFileSync(resolve(dir,'config.local.json'),'changed secret');assert.equal(status().restartRequired,false);writeFileSync(resolve(dir,'b.ts'),'new module');assert.equal(status().restartRequired,true);unlinkSync(resolve(dir,'b.ts'));assert.equal(status().restartRequired,false);writeFileSync(resolve(dir,'a.ts'),'changed');assert.equal(status().restartRequired,true);unlinkSync(resolve(dir,'a.ts'));assert.equal(status().restartRequired,true);assert.doesNotMatch(JSON.stringify(status()),/changed secret/);}finally{rmSync(dir,{recursive:true,force:true});}
});
test('源码版本无法核对时保留未知，不错误报告新旧一致',()=>{const status=createRuntimeStatus(resolve(tmpdir(),'nonexistent-radar-runtime-fixture'));assert.equal(status().restartRequired,null);assert.equal(status().currentSourceFingerprint,null);});
