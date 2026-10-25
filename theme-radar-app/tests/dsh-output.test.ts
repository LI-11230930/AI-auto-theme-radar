import test from 'node:test';
import assert from 'node:assert/strict';
import {parseResult} from '../src/runner.ts';
test('DSH accepts final event only and rejects incomplete JSON',()=>{
  const reply={ok:true};
  assert.deepEqual(parseResult('{"type":"status","phase":"turn_end","reason":{"kind":"completed"}}\n'+JSON.stringify({type:'final',text:JSON.stringify(reply)})),reply);
  assert.throws(()=>parseResult('{"type":"text","text":"{\\"ok\\":true}"}'));
  assert.throws(()=>parseResult(JSON.stringify({type:'final',text:'{"ok":true'})));
});
test('DSH failed completion cannot be hidden by a later final event',()=>{
  for(const kind of ['failed','cancelled','max-tokens'])assert.throws(()=>parseResult(JSON.stringify({type:'status',phase:'turn_end',reason:{kind}})+'\n'+JSON.stringify({type:'final',text:'{"ok":true}'})),{code:'AGENT_FAILED'});
});
