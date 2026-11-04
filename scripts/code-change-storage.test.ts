import assert from 'node:assert/strict';
import {test} from 'node:test';
import {serialize} from 'node:v8';
import {prepareCodeChangeStorage} from '../packages/workshop-backend/src/code-change-storage.ts';
import {composeCodeChange, type CodeChange} from '../packages/workshop-shared/src/code-change.ts';

const budget=1536*1024;
test('large ASCII blueprint and mixed text preserve bytes and bound the actual V8 record',()=>{
  // Slicing an ASCII suffix from a wide source must not retain an unexpectedly wide encoding.
  for(const content of [('€'+'a'.repeat(480000)).slice(1),'\u00ff'.repeat(480000),'€'.repeat(480000),'😀'.repeat(240000)]){
    const change:CodeChange={1:[['server.js',{set:content}],['client.js',{set:'b'.repeat(480000)}]]};
    const result=prepareCodeChangeStorage(change,budget);
    assert.deepEqual(result.change,change);
    assert.ok(serialize(result.change).byteLength<=result.bytes);
  }
  const crmLike:CodeChange={1:[['a.js',{set:'a'.repeat(450000)}],['b.js',{set:'b'.repeat(450000)}]]};
  const result=prepareCodeChangeStorage(crmLike,budget);
  assert.ok(result.bytes<budget);
  assert.ok(serialize({change:result.change,createdGadgets:[{gadgetId:1,title:'CRM',bindingName:'CRM'}]}).byteLength<budget);
});
test('a later Unicode edit is checked against the composed storage representation',()=>{
  const initial:CodeChange={1:[['a.js',{set:'a'.repeat(480000)}],['b.js',{set:'b'.repeat(480000)}],['c.js',{set:'c'.repeat(480000)}]]};
  const first=prepareCodeChangeStorage(initial,budget);
  assert.ok(first.bytes<budget);
  const wide:CodeChange={1:[['a.js',{edit:[480000,[0,'€']]}],['b.js',{edit:[480000,[0,'€']]}]]};
  const combined=prepareCodeChangeStorage(composeCodeChange(first.change,wide),budget);
  assert.ok(combined.bytes>budget);
  assert.ok(serialize(combined.change).byteLength<=combined.bytes);
});
