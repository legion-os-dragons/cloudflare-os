import assert from 'node:assert/strict';
import {test} from 'node:test';
import {auditRuntimeSources,runtimeRepositories} from './runtime-constraints.ts';

const app='packages/workshop-frontend/src/app.ts';
const violations=(source:string,file=app)=>auditRuntimeSources(new Map([[file,source]])).filter(site=>site.rule);
test('the real Workshop source has no request-lifetime or app-specific RPC bypass',()=>{
  const found=auditRuntimeSources(runtimeRepositories(process.cwd())).filter(site=>site.rule);
  assert.deepEqual(found,[],JSON.stringify(found,null,2));
});
test('finds imported aliases, namespace members, destructuring and factory wrappers',()=>{
  const cases=[
    `import {newWebSocketRpcSession as open} from 'capnweb'; open('/api');`,
    `import * as rpc from 'capnweb';rpc.newHttpBatchRpcSession('/api');`,
    `import * as rpc from 'capnweb';const {newWebSocketRpcSession:open}=rpc;function connect(){return open('/api')}connect();`,
    `import * as rpc from 'capnweb';const key='newHttpBatchRpcSession';const open=rpc[key];open('/api');`,
    `const {newWebSocketRpcSession:open}=require('capnweb');open('/api');`,
    `import {newHttpBatchRpcSession as open} from 'capnweb';const methods=new Set(['documentRead']);function dispatch(method){if(methods.has(method))return open('/api');}`,
  ];
  for(const source of cases)assert.ok(violations(source).length>0,source);
});
test('does not classify comments, shadowed imports or browser-only message ports as Worker sessions',()=>{
  assert.deepEqual(violations(`// newWebSocketRpcSession('/api')\nconst text="newHttpBatchRpcSession('/api')";`),[]);
  assert.deepEqual(violations(`import {newWebSocketRpcSession as open} from 'capnweb';function f(open){open('local')} `),[]);
  assert.deepEqual(violations(`import{newMessagePortRpcSession}from'capnweb';newMessagePortRpcSession(port);`),[]);
});
test('legacy backend WebSockets fail regardless of aliases or enclosing wrappers',()=>{
  assert.equal(violations(`import{newWebSocketRpcSession as create}from'capnweb';function response(){return create(socket,api)}`, 'packages/workshop-backend/src/server.ts')[0]?.rule,'worker-lifetime-websocket');
});
test('records shared and Durable Object ownership rather than banning legitimate browser messaging',()=>{
  const sources=new Map([
    ['packages/workshop-frontend/src/rpcTransport.ts',`import{RpcSession}from'capnweb';new RpcSession(transport);`],
    ['packages/workshop-backend/src/connection.ts',`import{DurableObject as Actor}from'cloudflare:workers';import{RpcSession}from'capnweb';class Connection extends Actor {open(){new RpcSession(transport)}}`],
  ]);
  const sites=auditRuntimeSources(sources);assert.equal(sites.length,2);assert.equal(sites.find(site=>site.owner==='durable-object')?.api,'RpcSession');assert.ok(sites.every(site=>!site.rule));
});
test('finds raw application API fetches outside the shared transport',()=>{
  assert.ok(violations("fetch(`/api`)").length);
  assert.ok(violations("fetch(`${origin}/api`)").length);
  assert.ok(violations("const post=fetch;post('/api')").length);
  assert.deepEqual(violations("fetch('/api/client-errors')"),[]);
});
test('follows imported wrappers rather than checking only direct constructor names',()=>{
  const files=new Map([
    [app,`import {connect as open} from './helper.js';open();`],
    ['packages/workshop-frontend/src/helper.ts',`import * as rpc from 'capnweb';export function connect(){return rpc.newWebSocketRpcSession('/api')}`],
  ]);
  assert.ok(auditRuntimeSources(files).some(site=>site.file===app&&site.rule==='shared-connection-bypass'));
});
test('requires bounded parsing before decoding raw connection forms',()=>{
  assert.equal(violations(`export async function fetch(request:Request){return request.formData()}`,'packages/gatekeeper-example/src/index.ts')[0]?.rule,'unbounded-request-form');
  assert.equal(violations(`async function connect(request){const alias=request;return alias.formData()}`,'packages/gatekeeper-example/src/index.ts')[0]?.rule,'unbounded-request-form');
  assert.deepEqual(violations(`export async function fetch(request:Request){return new Response(boundedBytes,{headers}).formData()}`,'packages/gatekeeper-example/src/index.ts'),[]);
});
