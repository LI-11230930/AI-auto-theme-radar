import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync,mkdirSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {asarEntryExists} from '../src/asar-entry.ts';import {runnerSetup} from '../src/setup-status.ts';
function archive(file:string,entry:any,body='abc'){
 const text=Buffer.from(JSON.stringify({files:{lib:{files:{'cli.js':entry}}}})),bytes=8+Math.ceil(text.length/4)*4,header=Buffer.alloc(bytes),prefix=Buffer.alloc(8);prefix.writeUInt32LE(4,0);prefix.writeUInt32LE(bytes,4);header.writeUInt32LE(bytes-4,0);header.writeUInt32LE(text.length,4);text.copy(header,8);writeFileSync(file,Buffer.concat([prefix,header,Buffer.from(body)]));
}
test('Electron ASAR内CLI不是普通磁盘文件，目录索引可定位且仅DSH显式入口支持',()=>{
 const root=mkdtempSync(join(tmpdir(),'radar-asar-'));try{const file=join(root,'app.asar'),cli=join(file,'lib','cli.js');archive(file,{size:3,offset:'0'});
 assert.equal(asarEntryExists(cli),true);assert.equal(asarEntryExists(join(file,'lib','missing.js')),false);
 const config={dataDir:root,defaultAgent:'DSH',runners:{DSH:{command:process.execPath,prefixArgs:['--expose-internals',cli]}}};
 assert.equal(runnerSetup(config).state,'ready');config.runners.DSH.prefixArgs=[cli];assert.equal(runnerSetup(config).code,'RUNNER_SCRIPT_MISSING');
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('损坏、超大头部、越界正文和指向目录的ASAR条目不算存在',()=>{
 const root=mkdtempSync(join(tmpdir(),'radar-asar-bad-'));try{const file=join(root,'app.asar'),cli=join(file,'lib','cli.js');
 archive(file,{size:30,offset:'0'});assert.equal(asarEntryExists(cli),false);
 archive(file,{files:{}});assert.equal(asarEntryExists(cli),false);
 writeFileSync(file,Buffer.from([4,0,0,0,255,255,255,127]));assert.equal(asarEntryExists(cli),false);
 writeFileSync(file,'bad');assert.equal(asarEntryExists(cli),false);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('ASAR解包条目必须有匹配的实际文件，未解包不算完成',()=>{
 const root=mkdtempSync(join(tmpdir(),'radar-asar-unpacked-'));try{const file=join(root,'app.asar'),cli=join(file,'lib','cli.js');archive(file,{size:3,unpacked:true},'');assert.equal(asarEntryExists(cli),false);mkdirSync(join(file+'.unpacked','lib'),{recursive:true});writeFileSync(join(file+'.unpacked','lib','cli.js'),'abc');assert.equal(asarEntryExists(cli),true);
 }finally{rmSync(root,{recursive:true,force:true});}
});
