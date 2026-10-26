import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker.js';

test('Worker sends APIs to code and ordinary pages to static assets',async()=>{
  const seen=[];const env={ASSETS:{fetch:async request=>{seen.push(new URL(request.url).pathname);return new Response('static page');}}};
  const execution={waitUntil(){}};
  assert.equal(await(await worker.fetch(new Request('https://atlas.example/chat'),env,execution)).text(),'static page');
  assert.deepEqual(seen,['/chat']);
  const unauthorized=await worker.fetch(new Request('https://atlas.example/api/chat/quota'),env,execution);
  assert.equal(unauthorized.status,503);assert.match(unauthorized.headers.get('Content-Type'),/application\/json/);
  assert.equal((await worker.fetch(new Request('https://atlas.example/api/unknown'),env,execution)).status,404);
  assert.equal((await worker.fetch(new Request('https://atlas.example/api/auth/me'),env,execution)).status,503);
  assert.deepEqual(seen,['/chat']);
});
