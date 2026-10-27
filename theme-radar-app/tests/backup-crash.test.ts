import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {spawn} from 'node:child_process';import {once} from 'node:events';
import {Store} from '../src/store.ts';import {rehearseBackup} from '../src/backup.ts';
test('真实强制终止隔离SQLite进程后，已提交投递和租约可恢复，未提交事务回滚',async()=>{
 const root=mkdtempSync(join(tmpdir(),'radar-crash-recovery-')),path=join(root,'crash.sqlite');let store:Store|undefined;
 const code=`import {Store} from ${JSON.stringify(new URL('../src/store.ts',import.meta.url).href)};
 const store=new Store(process.argv[1]);
 store.prepareDelivery('interrupted','email','fixture@example.test','frozen-fixture-body');
 store.beginDelivery('interrupted');store.claim('interrupted-round','fixture',120000);
 store.db.exec('BEGIN IMMEDIATE');store.db.prepare('INSERT INTO logs(created_at,event,data) VALUES(?,?,?)').run('fixture','not-committed','{}');
 process.stdout.write('ready\\n');setInterval(()=>{},1000);`;
 const child=spawn(process.execPath,['--input-type=module','-e',code,path],{windowsHide:true,stdio:['ignore','pipe','pipe']}),closed=once(child,'exit');
 try{
  await new Promise<void>((ready,fail)=>{const timer=setTimeout(()=>fail(Error('isolated fixture child did not prepare WAL')),5000);child.once('error',e=>{clearTimeout(timer);fail(e);});child.once('exit',()=>{clearTimeout(timer);fail(Error('fixture child exited before crash point'));});child.stdout.once('data',data=>{if(String(data).includes('ready')){clearTimeout(timer);ready();}});});
  assert.equal(child.kill('SIGKILL'),true);await closed;
  store=new Store(path);assert.equal(store.delivery('interrupted').state,'submitting');assert.equal(store.job('interrupted-round').state,'running');assert.equal((store.db.prepare("SELECT count(*) n FROM logs WHERE event='not-committed'").get() as any).n,0);
  const backup=store.backup(join(root,'post-crash.sqlite')),report=rehearseBackup(backup);assert.equal(report.allRowsMatched,true);assert.equal(report.submittingMarkedUncertain,1);assert.equal(report.runningLeasesRetired,1);
  assert.equal(store.delivery('interrupted').state,'submitting');assert.equal(store.job('interrupted-round').state,'running');assert.equal(store.beginDelivery('interrupted'),false);
 }finally{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await closed;}store?.close();rmSync(root,{recursive:true,force:true});}
});
