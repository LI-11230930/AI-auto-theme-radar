import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync,existsSync,readFileSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {startOperator} from '../src/operator.ts';
test('网页数据库备份与演练需要本机令牌，路径不能越界，正式业务计数不变',async()=>{
 const root=mkdtempSync(join(tmpdir(),'radar-backup-http-')),previous=process.env.THEME_RADAR_CONFIG;let server:Awaited<ReturnType<typeof startOperator>>|undefined;
 try{const path=join(root,'config.json');writeFileSync(path,JSON.stringify({dataDir:root,topics:[],recipient:null,xiaohongshu:{enabled:false}}));process.env.THEME_RADAR_CONFIG=path;server=await startOperator(0);const base='http://127.0.0.1:'+(server.address() as any).port,state=await(await fetch(base+'/api/state')).json() as any;
 const post=(url:string,body:any={},token=state.token,origin=base)=>fetch(base+url,{method:'POST',headers:{'Content-Type':'application/json','X-Radar-Token':token,Origin:origin},body:JSON.stringify(body)});
 assert.equal((await post('/api/backups/create',{},'wrong')).status,403);assert.equal(existsSync(join(root,'backups')),false);
 assert.equal((await post('/api/backups/create',{},state.token,'https://foreign.example')).status,403);
 const response=await post('/api/backups/create');assert.equal(response.status,200);const created=await response.json() as any;assert.equal(created.emailSent,false);const original=readFileSync(join(root,'backups',created.name));
 const listing=await(await fetch(base+'/api/backups')).json() as any;assert.equal(listing.total,1);assert.equal(listing.backups[0].name,created.name);assert.ok(!JSON.stringify(listing).includes(root));
 assert.equal((await post('/api/backups/check',{name:'../radar.sqlite'})).status,400);
 const checked=await post('/api/backups/check',{name:created.name});assert.equal(checked.status,200);const rehearsal=await checked.json() as any;assert.equal(rehearsal.allRowsMatched,true);assert.equal(rehearsal.activeDatabaseReplaced,false);assert.equal(rehearsal.temporaryCopyRemoved,true);
 assert.deepEqual(readFileSync(join(root,'backups',created.name)),original);assert.deepEqual((await(await fetch(base+'/api/state')).json() as any).stats,state.stats);
 assert.match(await(await fetch(base+'/')).text(),/id="backup-create"/);assert.equal((await fetch(base+'/assets/backup.js')).status,200);
 }finally{if(server)await new Promise<void>(r=>server!.close(()=>r()));if(previous===undefined)delete process.env.THEME_RADAR_CONFIG;else process.env.THEME_RADAR_CONFIG=previous;rmSync(root,{recursive:true,force:true});}
});
