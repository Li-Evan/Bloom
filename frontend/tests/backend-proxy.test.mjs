import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { forwardBackendRequest } from '../src/lib/backend-proxy.ts';

test('same-origin forwarding preserves auth and errors without forwarding cookies or other headers',async()=>{
 process.env.BACKEND_URL='https://backend.test';
 const fn=mock.method(globalThis,'fetch',async(url,init)=>{
  assert.equal(String(url),'https://backend.test/api/courses/5/syllabus/regenerate?locale=zh');
  assert.equal(init.headers.get('authorization'),'Bearer user-test');
  assert.equal(init.headers.get('idempotency-key'),null);
  assert.equal(init.headers.get('cookie'),null);
  assert.equal(init.redirect,'manual');
  assert.equal(await new Response(init.body).text(),'request');
  return Response.json({detail:'conflict'}, {status:409});
 });
 try {
  const res=await forwardBackendRequest(new Request('https://frontend.test/api/backend/courses/5/syllabus/regenerate?locale=zh',{method:'POST',headers:{Authorization:'Bearer user-test',Cookie:'private=secret','Idempotency-Key':'once'},body:'request'}),['courses','5','syllabus','regenerate']);
  assert.equal(res.status,409);assert.deepEqual(await res.json(),{detail:'conflict'});
  assert.equal(res.headers.get('cache-control'),'no-store');assert.equal(fn.mock.callCount(),1);
 } finally { fn.mock.restore(); }
});

test('streaming bridge returns before the upstream stream ends',async()=>{
 process.env.BACKEND_URL='https://backend.test';
 let controller;
 const body=new ReadableStream({start(c){controller=c;c.enqueue(new TextEncoder().encode('data: first\n\n'));}});
 const fn=mock.method(globalThis,'fetch',async()=>new Response(body,{headers:{'Content-Type':'text/event-stream'}}));
 try {
  const res=await forwardBackendRequest(new Request('https://frontend.test/api/backend/courses/5/next'),['courses','5','next']);
  const reader=res.body.getReader();assert.match(new TextDecoder().decode((await reader.read()).value),/first/);
  controller.close();assert.equal((await reader.read()).done,true);
 } finally {fn.mock.restore();}
});

test('bridge rejects path traversal and does not follow redirects or retry writes',async()=>{
 process.env.BACKEND_URL='https://backend.test';
 const fn=mock.method(globalThis,'fetch',async()=>new Response(null,{status:307,headers:{Location:'https://other.test'}}));
 try {
  assert.equal((await forwardBackendRequest(new Request('https://front.test'),['..','internal'])).status,400);
  assert.equal(fn.mock.callCount(),0);
  const res=await forwardBackendRequest(new Request('https://front.test',{method:'POST'}),['courses']);
  assert.equal(res.status,502);assert.equal(res.headers.get('location'),null);assert.equal(fn.mock.callCount(),1);
  assert.equal((await res.json()).detail,'后端返回了意外的跳转（原因：HTTP 307）');
 }finally{fn.mock.restore();}
});

test('bridge waits for headers longer than the route may run (800 s); a body silent past the browser\'s 120 s stream timeout is stuck: SSE beats every 10 s',async()=>{
 process.env.BACKEND_URL='https://backend.test';
 const fn=mock.method(globalThis,'fetch',async(_url,init)=>{
  assert.ok(init.dispatcher,'a dispatcher must replace the default 300-second timeouts');
  const options=init.dispatcher[Object.getOwnPropertySymbols(init.dispatcher).find((s)=>s.description==='options')];
  assert.ok(options.headersTimeout>=900_000,`headersTimeout ${options.headersTimeout}`);
  assert.ok(options.bodyTimeout>120_000&&options.bodyTimeout<=180_000,`bodyTimeout ${options.bodyTimeout}`);
  return Response.json({ok:true});
 });
 try { assert.equal((await forwardBackendRequest(new Request('https://front.test'),['health'])).status,200); }
 finally{fn.mock.restore();}
});

test('bridge failures say why and differ from any backend answer',async()=>{
 delete process.env.BACKEND_URL;
 const missing=await forwardBackendRequest(new Request('https://front.test'),['courses']);
 assert.equal(missing.status,500);
 assert.equal((await missing.json()).detail,'前端没有配置后端地址（原因：BACKEND_URL is not set）');

 process.env.BACKEND_URL='https://backend.test/';
 const refused=mock.method(globalThis,'fetch',async()=>{throw new TypeError('fetch failed',{cause:Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:443'),{code:'ECONNREFUSED'})});});
 try {
  const res=await forwardBackendRequest(new Request('https://front.test'),['courses']);
  assert.equal(res.status,502);
  assert.equal((await res.json()).detail,'无法连接后端服务（原因：ECONNREFUSED connect ECONNREFUSED 127.0.0.1:443）');
 } finally {refused.mock.restore();}

 const page=mock.method(globalThis,'fetch',async(url)=>{
  assert.equal(String(url),'https://backend.test/api/courses');
  return new Response('An error occurred with your deployment\n\nFUNCTION_INVOCATION_TIMEOUT',{status:504,headers:{'x-vercel-error':'FUNCTION_INVOCATION_TIMEOUT','content-type':'text/plain'}});
 });
 try {
  const res=await forwardBackendRequest(new Request('https://front.test',{method:'POST'}),['courses']);
  assert.equal(res.status,504);
  assert.match((await res.json()).detail,/^后端没有返回可读的错误（原因：HTTP 504 FUNCTION_INVOCATION_TIMEOUT An error occurred with your deployment/);
 } finally {page.mock.restore();}
});

test('bridge rejects dot segments however they are encoded: Next decodes once, so %252e%252e arrives as %2e%2e',async()=>{
 process.env.BACKEND_URL='https://backend.test';
 const fn=mock.method(globalThis,'fetch',async()=>Response.json({ok:true}));
 try {
  for (const path of [['%2e%2e','openapi.json'],['%2E%2e','%2e%2E','docs'],['%2e','health'],['courses','%2e%2e','..'],['a%2Fb'],['a%5Cb'],['courses','']]) {
   const res=await forwardBackendRequest(new Request('https://front.test'),path);
   assert.equal(res.status,400,JSON.stringify(path));
   assert.deepEqual(await res.json(),{detail:'Invalid API path.'});
  }
  assert.equal(fn.mock.callCount(),0);
 } finally {fn.mock.restore();}
});

test('bridge stays under BACKEND_URL\'s own path prefix and keeps legitimate encoded segments as one segment',async()=>{
 process.env.BACKEND_URL='https://backend.test/svc/';
 const urls=[];
 const fn=mock.method(globalThis,'fetch',async(url)=>{urls.push(String(url));return Response.json({ok:true});});
 try {
  for (const path of [['courses','5'],['notes','%E4%BD%A0%E5%A5%BD'],['notes','你好'],['items','100%'],['items','..x'],['items','%252e%252e']]) {
   assert.equal((await forwardBackendRequest(new Request('https://front.test/x?locale=zh'),path)).status,200,JSON.stringify(path));
  }
  assert.deepEqual(urls,[
   'https://backend.test/svc/api/courses/5?locale=zh',
   'https://backend.test/svc/api/notes/%E4%BD%A0%E5%A5%BD?locale=zh',
   'https://backend.test/svc/api/notes/%E4%BD%A0%E5%A5%BD?locale=zh',
   'https://backend.test/svc/api/items/100%25?locale=zh',
   'https://backend.test/svc/api/items/..x?locale=zh',
   'https://backend.test/svc/api/items/%252e%252e?locale=zh',
  ]);
 } finally {fn.mock.restore();}
});

test('platform error pages are not backend answers: status becomes 502 (only 504/413/429 kept), the reason drops CSS and scripts',async()=>{
 process.env.BACKEND_URL='https://backend.test';
 const page='<!doctype html><html><head><style>body{margin:0;font-family:-apple-system,sans-serif}.c{color:#666}</style><script type="module">window.x=1</script></head><body><h1>404: NOT_FOUND</h1><p>Code: DEPLOYMENT_NOT_FOUND</p></body></html>';
 const cases=[
  [404,{'content-type':'text/html','x-vercel-error':'DEPLOYMENT_NOT_FOUND'},page,502,'HTTP 404 DEPLOYMENT_NOT_FOUND 404: NOT_FOUND Code: DEPLOYMENT_NOT_FOUND'],
  [401,{'content-type':'text/html; charset=utf-8'},'<html><body><SCRIPT>location.href="/sso"</SCRIPT>Authentication Required</body></html>',502,'HTTP 401 Authentication Required'],
  [500,{'content-type':'text/plain'},'A server error has occurred\n\nFUNCTION_INVOCATION_FAILED',502,'HTTP 500 A server error has occurred FUNCTION_INVOCATION_FAILED'],
  [404,{'content-type':'application/json','x-vercel-error':'NOT_FOUND'},'{"error":{"code":"404"}}',502,'HTTP 404 NOT_FOUND {"error":{"code":"404"}}'],
  [413,{'content-type':'text/plain','x-vercel-error':'FUNCTION_PAYLOAD_TOO_LARGE'},'Request Entity Too Large',413,'HTTP 413 FUNCTION_PAYLOAD_TOO_LARGE Request Entity Too Large'],
  [429,{'content-type':'text/plain'},'Too Many Requests',429,'HTTP 429 Too Many Requests'],
 ];
 for (const [status,headers,body,expected,reason] of cases) {
  const fn=mock.method(globalThis,'fetch',async()=>new Response(body,{status,headers}));
  try {
   const res=await forwardBackendRequest(new Request('https://front.test'),['courses','1']);
   assert.equal(res.status,expected,`${status} ${body.slice(0,30)}`);
   assert.equal((await res.json()).detail,`后端没有返回可读的错误（原因：${reason}）`);
  } finally {fn.mock.restore();}
 }
 const json=mock.method(globalThis,'fetch',async()=>Response.json({detail:'找不到这门课程'},{status:404}));
 try {
  const res=await forwardBackendRequest(new Request('https://front.test'),['courses','1']);
  assert.equal(res.status,404);assert.deepEqual(await res.json(),{detail:'找不到这门课程'});
 } finally {json.mock.restore();}
});
