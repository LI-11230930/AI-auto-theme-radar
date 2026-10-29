import test from 'node:test';import assert from 'node:assert/strict';
import {Store} from '../src/store.ts';import {redactLogText,serializeLogData} from '../src/log-redaction.ts';

test('日志按字段名递归脱敏，包括非字符串和数组凭据',()=>{
 const data={password:'synthetic-password',nested:{access_token:'synthetic-access',refreshToken:'synthetic-refresh',apiKey:'synthetic-key',client_secret:'synthetic-client'},headers:{Authorization:'synthetic-auth',Cookie:'synthetic-cookie'},tokens:['synthetic-array'],credentials:{user:'synthetic-user'},pwd:123456};
 const text=serializeLogData(data),parsed=JSON.parse(text);assert.doesNotMatch(text,/synthetic-|123456/);assert.equal(parsed.password,'[redacted]');assert.equal(parsed.nested.refreshToken,'[redacted]');assert.equal(parsed.tokens,'[redacted]');assert.equal(parsed.credentials,'[redacted]');
});
test('自由文本过滤Bearer、Basic及没有标签的GitHub凭据',()=>{
 const values=['synthetic.bearer+/=','c3ludGhldGljOm9ubHk=','github_pat_'+ 'A'.repeat(60),'ghp_'+ 'B'.repeat(36)];const text=redactLogText('Bearer '+values[0]+'; Basic '+values[1]+'; '+values[2]+' '+values[3]);for(const value of values)assert.ok(!text.includes(value));assert.match(text,/Bearer \[redacted\]/);assert.match(text,/Basic \[redacted\]/);
});
test('文本JSON、查询参数和Cookie不保留凭据值',()=>{
 for(const text of ['{"password":"synthetic value with spaces"}',"access_token='synthetic value'",'https://example.test/?xsec_token=synthetic-query&lang=zh','SESSDATA=synthetic-session; bili_jct=synthetic-csrf','Cookie: other=synthetic-cookie; SESSDATA=synthetic-session\nstatus=403']){assert.doesNotMatch(redactLogText(text),/synthetic/);}
 assert.match(redactLogText('https://example.test/?token=synthetic-query&lang=zh'),/&lang=zh/);
});
test('代理URL用户信息及完整或截断私钥块被过滤',()=>{
 assert.equal(redactLogText('http://synthetic-user:synthetic-pass@127.0.0.1:7890/path'),'http://[redacted]@127.0.0.1:7890/path');
 for(const end of ['-----END '+'PRIVATE KEY-----',''])assert.equal(redactLogText('-----BEGIN '+'PRIVATE KEY-----\nsynthetic-key-material\n'+end),'[redacted]');
});
test('保留条目ID、错误码、时间与计数，且不修改原对象',()=>{
 const input={itemKey:'github:sample/tool',eventId:'fixture-event',code:'HTTP_403',status:403,tokenCount:12,selected:false,changes:[{field:'stars',before:0,after:2}],at:'2026-10-29T00:00:00Z',note:'正文未取得，保留恢复队列。'};assert.deepEqual(JSON.parse(serializeLogData(input)),input);const sensitive={nested:{password:'synthetic-original'}};serializeLogData(sensitive);assert.equal(sensitive.nested.password,'synthetic-original');
});
test('Store真实落库的事件名和数据都脱敏，不产生业务状态',()=>{
 const store=new Store(':memory:');try{const before=store.stats();store.log('fixture Bearer synthetic-event',{nested:{password:'synthetic-structured'},note:'access_token=synthetic-inline'});const row=store.db.prepare('SELECT event,data FROM logs').get() as any;assert.doesNotMatch(row.event+row.data,/synthetic-/);assert.equal(JSON.parse(row.data).nested.password,'[redacted]');assert.equal(store.stats().items,before.items);assert.equal(store.stats().deliveries,before.deliveries);assert.equal(store.stats().jobs,before.jobs);}finally{store.close();}
});
test('序列化失败不会写半条日志，既有历史记录不迁移',()=>{
 const store=new Store(':memory:');try{store.db.prepare('INSERT INTO logs(created_at,event,data) VALUES(?,?,?)').run('fixture','legacy','{"password":"legacy-synthetic"}');const before=store.db.prepare('SELECT * FROM logs').all(),cycle:any={};cycle.self=cycle;assert.throws(()=>store.log('fixture',cycle));assert.deepEqual(store.db.prepare('SELECT * FROM logs').all(),before);}finally{store.close();}
});
