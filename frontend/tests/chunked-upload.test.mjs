import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
process.env.NEXT_PUBLIC_API_BASE_URL = 'https://backend.test';
globalThis.document = { documentElement: { lang: 'zh' } };
const { uploadCourseFiles, UploadError } = await import('../src/lib/learn/upload.ts');
const { createCourseFromMaterials, createProjectCourse } = await import('../src/lib/learn/api.ts');
const { isUnconfirmedCreate } = await import('../src/lib/learn/create-outcome.ts');
const { pendingState } = await import('../src/lib/learn/pending-courses.ts');
const json = (x, status = 200) => new Response(JSON.stringify(x), {status});

test('16 MB is uploaded in <= 1 MB authenticated chunks; only upload ID goes to course endpoint', async t => {
 const data = new Uint8Array(16 * 1024 * 1024 + 123).fill(65);
 const file = new File([data], 'large.pdf');
 let chunks = [], manifest, submitted = false;
 t.mock.method(globalThis, 'fetch', async (url, init) => {
  if (url === '/api/token') return json({token:'test',expires_at:Date.now()/1000+900});
  assert.equal(init.headers.get('Authorization'), 'Bearer test');
  if (url.endsWith('/api/backend/uploads')) { manifest = JSON.parse(init.body); return json({id:'abc',chunk_bytes:1048576}); }
  if (init.method === 'PUT') { assert.ok(init.body.size <= 1048576);chunks.push(Buffer.from(await init.body.arrayBuffer()));return json({ok:true}); }
  if (init.method === 'DELETE') return json({ok:true});
  assert.ok(url.endsWith('/courses/from-materials'));
  assert.equal(init.body.get('upload_id'),'abc');assert.equal(init.body.get('files'),null);
  submitted = true;return json({id:7});
 });
 assert.equal((await createCourseFromMaterials('large','',[file],'standard','zh')).id,7);
 assert.ok(submitted);assert.deepEqual(Buffer.concat(chunks), Buffer.from(data));
 assert.equal(manifest.files[0].sha256,createHash('sha256').update(data).digest('hex'));
});

test('network failure or 413 during upload is a definitive failure, never an unconfirmed generation',async t=>{
 for(const failure of ['network','413']) {
  let courseCalls=0;
  t.mock.method(globalThis,'fetch',async(url,init)=>{
   if(url==='/api/token')return json({token:'test',expires_at:Date.now()/1000+900});
   if(url.endsWith('/api/backend/uploads'))return json({id:'bad',chunk_bytes:1048576});
   if(init.method==='DELETE')return json({ok:true});
   if(String(url).includes('/courses/'))courseCalls++;
   if(failure==='network')throw new TypeError('Failed to fetch');
   return new Response('Payload Too Large',{status:413});
  });
  const error=await createCourseFromMaterials('x','',[new File(['abc'],'x.txt')],'standard').catch(e=>e);
  assert.ok(error instanceof UploadError);assert.equal(isUnconfirmedCreate(error),false);
  assert.match(error.message,/尚未开始生成/);assert.equal(courseCalls,0);
 }
});

test('file limits fail before any network operation', async t=>{
 t.mock.method(globalThis,'fetch',()=>{throw new Error('must not fetch');});
 const e=await uploadCourseFiles([new File([new Uint8Array(21*1024*1024)],'big.pdf')]).catch(e=>e);
 assert.ok(e instanceof UploadError);assert.match(e.message,/20 MB/);
});

test('unconfirmed generation keeps running (no "create again") within the expected window; old pending records become stalled',()=>{
 const now=Date.now();const item={kind:'materials',startedAt:now,unconfirmed:true};
 assert.equal(pendingState(item,now),'running');
 assert.equal(pendingState(item,now+14*60_000),'running');
 assert.equal(pendingState(item,now+15*60_000),'stalled');
 assert.equal(pendingState({kind:'source',startedAt:now-16*60_000},now),'stalled');
 assert.equal(pendingState({kind:'topic',startedAt:now},now),'running');
});

test('materials and project upload preserve file paths without multipart file payloads',async t=>{
 const paths=[];
 t.mock.method(globalThis,'fetch',async(url,init)=>{
  if(url==='/api/token')return json({token:'test',expires_at:Date.now()/1000+900});
  if(url.endsWith('/api/backend/uploads')){paths.push(JSON.parse(init.body).files[0].name);return json({id:'abc',chunk_bytes:1048576});}
  if(init.method==='PUT'||init.method==='DELETE')return json({ok:true});
  assert.equal(init.body.get('upload_id'),'abc');assert.equal(init.body.get('files'),null);return json({id:2});
 });
 const f=new File(['hello'],'note.md');Object.defineProperty(f,'webkitRelativePath',{value:'folder/note.md'});
 await createCourseFromMaterials('x','',[f],'standard','zh');await createProjectCourse('x',[f],'zh');
 assert.deepEqual(paths,['folder/note.md','folder/note.md']);
});

test('a transient chunk failure is retried (chunk PUT is idempotent) instead of failing the whole upload', async t => {
 const attempts = new Map();
 t.mock.method(globalThis, 'fetch', async (url, init) => {
  if (url === '/api/token') return json({token:'test',expires_at:Date.now()/1000+900});
  if (url.endsWith('/api/backend/uploads')) return json({id:'r',chunk_bytes:1048576});
  if (init.method === 'PUT') {
   const n = (attempts.get(url) ?? 0) + 1; attempts.set(url, n);
   if (n === 1) throw new TypeError('Failed to fetch');
   if (n === 2) return new Response('Bad Gateway', {status: 502});
   return json({ok:true});
  }
  return json({ok:true});
 });
 assert.equal(await uploadCourseFiles([new File(['abc'],'a.md')]), 'r');
 assert.deepEqual([...attempts.values()], [3]);
});

test('client errors are not retried; Chinese pages never get an English backend sentence appended', async t => {
 let puts = 0;
 t.mock.method(globalThis, 'fetch', async (url, init) => {
  if (url === '/api/token') return json({token:'test',expires_at:Date.now()/1000+900});
  if (url.endsWith('/api/backend/uploads')) return json({detail:'Too many unfinished uploads; please retry later.'}, 429);
  if (init.method === 'PUT') puts++;
  return json({ok:true});
 });
 const e = await uploadCourseFiles([new File(['abc'],'a.md')]).catch(e=>e);
 assert.ok(e instanceof UploadError); assert.equal(puts, 0);
 assert.match(e.message, /未完成的上传太多/); assert.doesNotMatch(e.message, /[A-Za-z]{4,}/);
});

test('without crypto.subtle (plain-http LAN address) the upload fails before any request with a clear reason', async t => {
 const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
 Object.defineProperty(globalThis, 'crypto', {value: {}, configurable: true});
 t.after(() => Object.defineProperty(globalThis, 'crypto', original));
 t.mock.method(globalThis, 'fetch', () => { throw new Error('must not fetch'); });
 const e = await uploadCourseFiles([new File(['abc'],'a.md')]).catch(e=>e);
 assert.ok(e instanceof UploadError); assert.match(e.message, /HTTPS/); assert.doesNotMatch(e.message, /TypeError|undefined/);
});

test('upload progress is reported per chunk in bytes, from 0 up to the total, before the course request', async t => {
 const a = new File([new Uint8Array(2 * 1024 * 1024 + 10)], 'a.pdf'), b = new File(['abc'], 'b.md');
 const total = a.size + b.size, seen = [];
 t.mock.method(globalThis, 'fetch', async (url, init) => {
  if (url === '/api/token') return json({token:'test',expires_at:Date.now()/1000+900});
  if (url.endsWith('/api/backend/uploads')) return json({id:'p',chunk_bytes:1048576});
  if (init.method === 'PUT' || init.method === 'DELETE') return json({ok:true});
  assert.deepEqual(seen.at(-1), [total, total]);
  return json({id:9});
 });
 await createProjectCourse('x', [a, b], 'zh', (sent, all) => seen.push([sent, all]));
 assert.deepEqual(seen.map(([sent]) => sent), [0, 1048576, 2097152, a.size, total]);
 assert.ok(seen.every(([, all]) => all === total));
});
