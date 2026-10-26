import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,upstream} from './helpers.mjs';

test('authenticated streaming, stored history, context replay, ownership and deletion',async()=>{
  const f=fixture();const original=globalThis.fetch;let calls=[];
  globalThis.fetch=async(url,options)=>{calls.push({url,options,body:JSON.parse(options.body)});return upstream([
    {type:'response.output_text.delta',delta:'你好，'}, {type:'response.output_text.delta',delta:'世界！'},
    {type:'response.completed',response:{usage:{input_tokens:10,output_tokens:5}}}]);};
  try{
    assert.equal((await f.call('/api/chat',{body:{message:'hi'}})).status,401);
    const cookie=await f.register();
    const before=await(await f.call('/api/chat/quota',{cookie})).json();assert.equal(before.remaining,20);
    const response=await f.call('/api/chat',{cookie,body:{message:'解释 AI',model:'expensive-override'}});
    assert.equal(response.status,200);assert.match(response.headers.get('Content-Type'),/text\/event-stream/);
    const output=await response.text();await f.finish();
    assert.match(output,/event: done/);assert.match(output,/你好/);assert.ok(!output.includes('test-secret-not-real'));
    assert.equal(calls[0].url,'https://api.openai.com/v1/responses');
    assert.equal(calls[0].body.model,'gpt-4.1-mini');assert.equal(calls[0].body.store,false);assert.equal(calls[0].body.max_output_tokens,512);
    const list=await(await f.call('/api/conversations',{cookie})).json();assert.equal(list.conversations.length,1);
    const id=list.conversations[0].id;
    const detail=await(await f.call(`/api/conversations/${id}`,{cookie})).json();
    assert.equal(detail.messages.length,2);assert.equal(detail.messages[1].content,'你好，世界！');assert.equal(detail.messages[1].status,'complete');
    const second=await f.call('/api/chat',{cookie,body:{message:'再解释一下',conversationId:id}});await second.text();await f.finish();
    assert.equal(calls[1].body.input.length,3);assert.equal(calls[1].body.input[1].role,'assistant');
    const other=await f.register('other_user');
    assert.equal((await f.call(`/api/conversations/${id}`,{cookie:other})).status,404);
    assert.equal((await f.call(`/api/conversations/${id}`,{cookie:other,method:'DELETE'})).status,404);
    assert.equal((await f.call('/api/chat',{cookie:other,body:{conversationId:id,message:'steal'}})).status,404);
    assert.equal((await f.call(`/api/conversations/${id}`,{cookie,method:'DELETE'})).status,200);
    assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM chat_messages').get().n,0);
    assert.equal((await f.call(`/api/conversations/${id}`,{cookie})).status,404);
  }finally{globalThis.fetch=original;await f.finish();f.close();}
});

test('key is required, validation and origin checks precede billing; per-user quotas persist',async()=>{
  const f=fixture({OPENAI_API_KEY:'',CHAT_DAILY_LIMIT:'1'});const original=globalThis.fetch;let n=0;
  globalThis.fetch=async()=>{n++;return upstream([{type:'response.output_text.delta',delta:'OK'},{type:'response.completed'}]);};
  try{
    const cookie=await f.register();
    assert.equal((await f.call('/api/chat',{cookie,body:{message:'hello'}})).status,503);
    assert.equal((await(await f.call('/api/chat/quota',{cookie})).json()).used,0);
    f.env.OPENAI_API_KEY='test';
    assert.equal((await f.call('/api/chat',{cookie,body:{message:'hi'},origin:'https://attacker.example'})).status,403);
    assert.equal((await f.call('/api/chat',{cookie,body:{message:'a'.repeat(2001)}})).status,400);
    const response=await f.call('/api/chat',{cookie,body:{message:'first'}});await response.text();await f.finish();
    assert.equal((await(await f.call('/api/chat/quota',{cookie})).json()).remaining,0);
    assert.equal((await f.call('/api/chat',{cookie,body:{message:'second'}})).status,429);assert.equal(n,1);
  }finally{globalThis.fetch=original;await f.finish();f.close();}
});

test('global quota caps all accounts, and upstream errors are saved without leaking secrets',async()=>{
  const f=fixture({CHAT_GLOBAL_DAILY_LIMIT:'1'});const original=globalThis.fetch;let n=0;
  globalThis.fetch=async()=>{n++;return new Response('private upstream error',{status:401});};
  try{
    const cookie=await f.register();const response=await f.call('/api/chat',{cookie,body:{message:'hello'}});
    const text=await response.text();await f.finish();assert.match(text,/event: error/);assert.ok(!text.includes('private upstream error'));
    assert.equal(f.sql.prepare("SELECT status FROM chat_messages WHERE role='assistant'").get().status,'error');
    const other=await f.register('other_user');assert.equal((await f.call('/api/chat',{cookie:other,body:{message:'hello'}})).status,429);assert.equal(n,1);
    assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM chat_locks').get().n,0);
  }finally{globalThis.fetch=original;await f.finish();f.close();}
});

test('concurrent requests are rejected, stopping cancels upstream and releases user lock',async()=>{
  const f=fixture();const original=globalThis.fetch;
  globalThis.fetch=async(url,options)=>new Promise((resolve,reject)=>{
    options.signal.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError')),{once:true});
  });
  try{
    const cookie=await f.register();const response=await f.call('/api/chat',{cookie,body:{message:'hello'}});
    assert.equal((await f.call('/api/chat',{cookie,body:{message:'parallel'}})).status,409);
    await response.body.cancel();await f.finish();
    assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM chat_locks').get().n,0);
    assert.equal(f.sql.prepare("SELECT status FROM chat_messages WHERE role='assistant'").get().status,'stopped');
  }finally{globalThis.fetch=original;await f.finish();f.close();}
});

test('truncated SSE is not reported as a successful answer',async()=>{
  const f=fixture();const original=globalThis.fetch;
  globalThis.fetch=async()=>upstream([{type:'response.output_text.delta',delta:'partial'}]);
  try{
    const cookie=await f.register();const r=await f.call('/api/chat',{cookie,body:{message:'hello'}});const text=await r.text();await f.finish();
    assert.match(text,/event: error/);assert.ok(!text.includes('event: done'));
    const row=f.sql.prepare("SELECT content,status FROM chat_messages WHERE role='assistant'").get();
    assert.equal(row.content,'partial');assert.equal(row.status,'error');
  }finally{globalThis.fetch=original;await f.finish();f.close();}
});
