import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,upstream} from './helpers.mjs';
import {MODELS} from '../server/chat.js';
const answer=()=>upstream([{choices:[{delta:{content:'你好，'}}]},{choices:[{delta:{content:'世界！'}}]},{choices:[{delta:{},finish_reason:'stop'}],usage:{total_tokens:10}}]).body;

test('Workers AI streaming, model allowlist, fixed conversations, history and ownership',async()=>{
  const calls=[];const f=fixture({AI:{run:async(model,input)=>{calls.push({model,input});return answer();}}});
  try{
    assert.equal((await f.call('/api/chat',{body:{message:'hi'}})).status,401);
    const cookie=await f.register();
    const before=await(await f.call('/api/chat/quota',{cookie})).json();assert.equal(before.remaining,20);assert.equal(before.models.length,3);assert.equal(before.configured,true);
    assert.equal((await f.call('/api/chat',{cookie,body:{message:'hi',model:'unknown-paid-model'}})).status,400);
    assert.equal((await(await f.call('/api/chat/quota',{cookie})).json()).used,0);
    const response=await f.call('/api/chat',{cookie,body:{message:'解释 AI',model:'qwen3'}});
    assert.equal(response.status,200);const output=await response.text();await f.finish();
    assert.match(output,/event: done/);assert.match(output,/你好/);
    assert.equal(calls[0].model,MODELS[0].model);assert.equal(calls[0].input.max_tokens,512);assert.equal(calls[0].input.stream,true);
    const list=await(await f.call('/api/conversations',{cookie})).json();const id=list.conversations[0].id;
    assert.equal(list.conversations[0].model,'qwen3');
    const detail=await(await f.call(`/api/conversations/${id}`,{cookie})).json();
    assert.equal(detail.messages[1].content,'你好，世界！');assert.equal(detail.messages[1].model,'qwen3');assert.equal(detail.messages[1].status,'complete');
    assert.equal((await f.call('/api/chat',{cookie,body:{message:'换模型',conversationId:id,model:'glm-flash'}})).status,409);
    const second=await f.call('/api/chat',{cookie,body:{message:'继续',conversationId:id}});await second.text();await f.finish();
    assert.equal(calls[1].input.messages.length,4);assert.equal(calls[1].input.messages[2].role,'assistant');
    const other=await f.register('other_user');
    assert.equal((await f.call(`/api/conversations/${id}`,{cookie:other})).status,404);
    assert.equal((await f.call(`/api/conversations/${id}`,{cookie:other,method:'DELETE'})).status,404);
    assert.equal((await f.call('/api/chat',{cookie:other,body:{conversationId:id,message:'steal'}})).status,404);
    assert.equal((await f.call(`/api/conversations/${id}`,{cookie,method:'DELETE'})).status,200);
    assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM chat_messages').get().n,0);
  }finally{await f.finish();f.close();}
});

test('missing binding, validation, CSRF and daily quota prevent inference',async()=>{
  const f=fixture({AI:null,CHAT_DAILY_LIMIT:'1'});let calls=0;
  try{
    const cookie=await f.register();
    assert.equal((await f.call('/api/chat',{cookie,body:{message:'hello'}})).status,503);
    assert.equal((await(await f.call('/api/chat/quota',{cookie})).json()).used,0);
    f.env.AI={run:async()=>{calls++;return answer();}};
    assert.equal((await f.call('/api/chat',{cookie,body:{message:'hi'},origin:'https://attacker.example'})).status,403);
    assert.equal((await f.call('/api/chat',{cookie,body:{message:'a'.repeat(2001)}})).status,400);
    await(await f.call('/api/chat',{cookie,body:{message:'first'}})).text();await f.finish();
    assert.equal((await f.call('/api/chat',{cookie,body:{message:'second'}})).status,429);assert.equal(calls,1);
  }finally{await f.finish();f.close();}
});

test('global quota and sanitized Workers AI errors',async()=>{
  let calls=0;const f=fixture({CHAT_GLOBAL_DAILY_LIMIT:'1',AI:{run:async()=>{calls++;throw new Error('private upstream error 3040');}}});
  try{
    const cookie=await f.register();const text=await(await f.call('/api/chat',{cookie,body:{message:'hello'}})).text();await f.finish();
    assert.match(text,/event: error/);assert.ok(!text.includes('private upstream error'));
    assert.equal(f.sql.prepare("SELECT status FROM chat_messages WHERE role='assistant'").get().status,'error');
    const other=await f.register('other_user');assert.equal((await f.call('/api/chat',{cookie:other,body:{message:'hello',model:'llama-3.3'}})).status,429);assert.equal(calls,1);
    assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM chat_locks').get().n,0);
  }finally{await f.finish();f.close();}
});

test('stop cancels pending binding invocation and releases concurrency lock',async()=>{
  let resolve;const f=fixture({AI:{run:()=>new Promise(r=>{resolve=r;})}});
  try{
    const cookie=await f.register();const response=await f.call('/api/chat',{cookie,body:{message:'hello'}});
    assert.equal((await f.call('/api/chat',{cookie,body:{message:'parallel'}})).status,409);
    await response.body.cancel();await f.finish();resolve(answer());
    assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM chat_locks').get().n,0);
    assert.equal(f.sql.prepare("SELECT status FROM chat_messages WHERE role='assistant'").get().status,'stopped');
  }finally{await f.finish();f.close();}
});

test('legacy Workers AI SSE and DONE markers are handled',async()=>{
  const f=fixture({AI:{run:async()=>upstream([{response:'分块中文'},'[DONE]']).body}});
  try{const cookie=await f.register();const text=await(await f.call('/api/chat',{cookie,body:{message:'hi',model:'llama-3.3'}})).text();await f.finish();assert.match(text,/event: done/);assert.match(text,/分块中文/);}
  finally{await f.finish();f.close();}
});

test('truncated streams and token limits are not reported as complete',async()=>{
  const f=fixture({AI:{run:async()=>upstream([{choices:[{delta:{content:'partial'}}]}]).body}});
  try{
    const cookie=await f.register();const text=await(await f.call('/api/chat',{cookie,body:{message:'hello'}})).text();await f.finish();
    assert.match(text,/event: error/);assert.ok(!text.includes('event: done'));
    assert.equal(f.sql.prepare("SELECT status FROM chat_messages WHERE role='assistant'").get().status,'error');
    f.env.AI.run=async()=>upstream([{choices:[{delta:{content:'short'},finish_reason:'length'}]}]).body;
    const limited=await(await f.call('/api/chat',{cookie,body:{message:'hello'}})).text();await f.finish();assert.match(limited,/incomplete/);
  }finally{await f.finish();f.close();}
});

test('old schema migrates without losing history; OpenAI conversations stay readable',async()=>{
  const f=fixture();
  try{
    f.sql.exec('ALTER TABLE chat_conversations DROP COLUMN model');
    const cookie=await f.register();const user=f.sql.prepare('SELECT id FROM users').get();const id=crypto.randomUUID();
    f.sql.prepare('INSERT INTO chat_conversations(id,user_id,title,created_at,updated_at) VALUES (?,?,?,?,?)').run(id,user.id,'旧对话',1,1);
    f.sql.prepare("INSERT INTO chat_messages(conversation_id,role,content,status,model,created_at) VALUES (?,'assistant','旧回答','complete','gpt-4.1-mini',1)").run(id);
    assert.equal((await f.call(`/api/conversations/${id}`,{cookie})).status,200);
    assert.ok(f.sql.prepare('PRAGMA table_info(chat_conversations)').all().some(c=>c.name==='model'));
    assert.equal((await f.call('/api/chat',{cookie,body:{conversationId:id,message:'continue'}})).status,409);
    assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM chat_messages').get().n,1);
  }finally{await f.finish();f.close();}
});
