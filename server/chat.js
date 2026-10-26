import {ApiError, json, sameOrigin, bodyJson, requireUser} from '../functions/api/auth/[[path]].js';

const initialized = new WeakMap();
const enc = new TextEncoder();
const DEFAULT_MODEL = 'gpt-4.1-mini';
const OUTPUT_LIMIT = 512;
const tables = [
  `CREATE TABLE IF NOT EXISTS chat_conversations (
    id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  'CREATE INDEX IF NOT EXISTS idx_chat_owner ON chat_conversations(user_id, updated_at)',
  `CREATE TABLE IF NOT EXISTS chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK(role IN ('user','assistant')), content TEXT NOT NULL,
    status TEXT NOT NULL, model TEXT, created_at INTEGER NOT NULL)`,
  'CREATE INDEX IF NOT EXISTS idx_chat_messages ON chat_messages(conversation_id, id)',
  `CREATE TABLE IF NOT EXISTS chat_usage (
    scope TEXT NOT NULL, day TEXT NOT NULL, requests INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(scope, day))`,
  `CREATE TABLE IF NOT EXISTS chat_locks (
    user_id INTEGER PRIMARY KEY, request_id TEXT NOT NULL, expires_at INTEGER NOT NULL)`
];
async function initialize(db) {
  if (!initialized.has(db)) initialized.set(db, db.batch(tables.map(sql => db.prepare(sql))).catch(err => {
    initialized.delete(db); throw err;
  }));
  await initialized.get(db);
}
function limit(value, fallback, max) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 1 ? Math.min(number, max) : fallback;
}
function config(env) {
  return {daily:limit(env.CHAT_DAILY_LIMIT,20,100), global:limit(env.CHAT_GLOBAL_DAILY_LIMIT,200,2000),
    model:env.OPENAI_MODEL || DEFAULT_MODEL};
}
function day() { return new Date().toISOString().slice(0,10); }
async function quota(db, userId, env) {
  const count = await db.prepare('SELECT requests FROM chat_usage WHERE scope = ? AND day = ?').bind(`user:${userId}`,day()).first();
  const global = await db.prepare('SELECT requests FROM chat_usage WHERE scope = ? AND day = ?').bind('site',day()).first();
  const settings = config(env);
  return {limit:settings.daily, used:count?.requests || 0, remaining:Math.max(0,settings.daily-(count?.requests || 0)),
    available:(global?.requests || 0) < settings.global, resetsAt:`${new Date(Date.now()+86400000).toISOString().slice(0,10)}T00:00:00Z`,
    model:settings.model, configured:!!env.OPENAI_API_KEY};
}
async function owned(db, userId, id) {
  if (typeof id !== 'string' || !/^[\da-f-]{36}$/i.test(id)) throw new ApiError(404,'对话不存在。');
  const row = await db.prepare('SELECT * FROM chat_conversations WHERE id = ? AND user_id = ?').bind(id,userId).first();
  if (!row) throw new ApiError(404,'对话不存在。');
  return row;
}
async function release(db, userId, requestId) {
  await db.prepare('DELETE FROM chat_locks WHERE user_id = ? AND request_id = ?').bind(userId,requestId).run();
}
async function reserve(db, userId, requestId, env) {
  const now = Date.now();
  const locked = await db.prepare(`INSERT INTO chat_locks(user_id,request_id,expires_at) VALUES (?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET request_id=excluded.request_id, expires_at=excluded.expires_at
    WHERE chat_locks.expires_at <= ? RETURNING request_id`).bind(userId,requestId,now+120000,now).first();
  if (!locked) throw new ApiError(409,'你有一条回答正在生成，请稍后重试。');
  try {
    const settings = config(env);
    for (const [scope, cap] of [[`user:${userId}`,settings.daily],['site',settings.global]]) {
      const row = await db.prepare(`INSERT INTO chat_usage(scope,day,requests) VALUES (?,?,1)
        ON CONFLICT(scope,day) DO UPDATE SET requests=requests+1 WHERE requests < ? RETURNING requests`)
        .bind(scope,day(),cap).first();
      if (!row) throw new ApiError(429,scope === 'site' ? '本站今日 AI 额度已用完，请明天再来。' : '你的今日对话额度已用完，请明天再来。');
    }
  } catch (err) { await release(db,userId,requestId); throw err; }
}

// SSE frames can cross chunks, contain CRLF, or contain multiple data lines.
export async function* parseEvents(body) {
  const reader = body.getReader(); const decoder = new TextDecoder(); let buffer = '';
  try {
    for (;;) {
      const {value,done} = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value,{stream:true});
      buffer = buffer.replace(/\r\n/g,'\n');
      if (buffer.length > 262144) throw new Error('SSE frame too large');
      let end;
      while ((end=buffer.indexOf('\n\n')) >= 0) {
        const frame=buffer.slice(0,end); buffer=buffer.slice(end+2);
        const data=frame.split('\n').filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');
        if (data && data !== '[DONE]') yield JSON.parse(data);
      }
      if (done) break;
    }
  } finally { await reader.cancel().catch(()=>{}); reader.releaseLock(); }
}

async function generate(context, db, user, body) {
  const {env,request} = context;
  if (!env.OPENAI_API_KEY) throw new ApiError(503,'AI 服务尚未启用：管理员需要配置 OPENAI_API_KEY。');
  const message=typeof body.message === 'string' ? body.message.trim() : '';
  if (!message || message.length>2000) throw new ApiError(400,'请输入 1–2000 个字符的问题。');
  let conversation=body.conversationId ? await owned(db,user.id,body.conversationId) : null;
  let history=[];
  if (conversation) {
    const count=await db.prepare('SELECT COUNT(*) AS n FROM chat_messages WHERE conversation_id = ?').bind(conversation.id).first();
    if (count.n>=100) throw new ApiError(400,'这个对话已满，请新建对话。');
    const rows=await db.prepare(`SELECT role,content FROM chat_messages WHERE conversation_id = ? AND status IN ('complete','incomplete','stopped')
      ORDER BY id DESC LIMIT 12`).bind(conversation.id).all();
    let total=message.length;
    for (const item of rows.results) { if (total+item.content.length>12000) break; history.unshift({role:item.role,content:item.content}); total+=item.content.length; }
    while (history.length && history[0].role !== 'user') history.shift();
  }
  const requestId=crypto.randomUUID();
  await reserve(db,user.id,requestId,env);
  let assistantId, userMessageId;
  try {
    const now=Date.now();
    if (!conversation) conversation={id:crypto.randomUUID(),title:Array.from(message).slice(0,30).join(''),user_id:user.id,created_at:now,updated_at:now};
    const writes=[
      db.prepare('INSERT OR IGNORE INTO chat_conversations(id,user_id,title,created_at,updated_at) VALUES (?,?,?,?,?)')
        .bind(conversation.id,user.id,conversation.title,conversation.created_at,now),
      db.prepare("INSERT INTO chat_messages(conversation_id,role,content,status,created_at) VALUES (?,'user',?,'pending',?)").bind(conversation.id,message,now),
      db.prepare("INSERT INTO chat_messages(conversation_id,role,content,status,model,created_at) VALUES (?,'assistant','','generating',?,?)")
        .bind(conversation.id,config(env).model,now)
    ];
    const results=await db.batch(writes);
    assistantId=results[2].meta.last_row_id;
    userMessageId=results[1].meta.last_row_id;
    await db.prepare('UPDATE chat_conversations SET updated_at = ? WHERE id = ?').bind(now,conversation.id).run();
  } catch (err) { await release(db,user.id,requestId); throw err; }

  const aborter=new AbortController();
  let cancelled=false;
  const abort=()=>{cancelled=true; aborter.abort();};
  request.signal.addEventListener('abort',abort,{once:true});
  const timeout=setTimeout(()=>aborter.abort(),60000);
  let task;
  const stream=new ReadableStream({
    start(controller) {
      const send=(event,data)=>{if(!cancelled) controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));};
      task=(async()=>{
        let text='',status='error',failure='回答未完成，请重试。',usage=null;
        try {
          send('meta',{conversationId:conversation.id,model:config(env).model});
          const response=await fetch('https://api.openai.com/v1/responses',{
            method:'POST',signal:aborter.signal,
            headers:{Authorization:`Bearer ${env.OPENAI_API_KEY}`,'Content-Type':'application/json'},
            body:JSON.stringify({model:config(env).model,store:false,stream:true,max_output_tokens:OUTPUT_LIMIT,
              instructions:'你是模型之间网站的 AI 助手。请用用户使用的语言提供清晰、准确的回答；不确定时明确说明。',
              input:[...history,{role:'user',content:message}]})
          });
          if (!response.ok || !response.body) {
            await response.body?.cancel();
            throw new ApiError(response.status, response.status===429 ? '模型服务额度或速率受限，请稍后再试。' : '模型服务暂时不可用，请联系管理员检查 API 配置。');
          }
          let terminal=false;
          for await (const event of parseEvents(response.body)) {
            if (event.type==='response.output_text.delta' || event.type==='response.refusal.delta') {
              const delta=event.delta || '';
              if (text.length+delta.length>16000) throw new Error('Output too long');
              text+=delta; send('delta',{text:delta});
            } else if (event.type==='response.completed') {
              terminal=true; status='complete'; usage=event.response?.usage || null; break;
            } else if (event.type==='response.incomplete') {
              terminal=true; status='incomplete'; failure='回答达到长度限制或提前结束，可继续追问。'; break;
            } else if (event.type==='response.failed' || event.type==='error') throw new Error('Upstream generation failed');
          }
          if (!terminal) throw new Error('Unexpected stream end');
        } catch (err) {
          status=cancelled ? 'stopped' : 'error';
          failure=cancelled ? '已停止生成。' : aborter.signal.aborted ? '生成超时，请重试。' : err instanceof ApiError ? err.message : '回答中断，请稍后重试。';
        } finally {
          clearTimeout(timeout); request.signal.removeEventListener('abort',abort);
          try {
            await db.batch([
              db.prepare('UPDATE chat_messages SET content = ?, status = ? WHERE id = ? AND conversation_id = ?').bind(text,status,assistantId,conversation.id),
              db.prepare('UPDATE chat_messages SET status = ? WHERE id = ? AND conversation_id = ?').bind(status==='complete'?'complete':status,userMessageId,conversation.id)
            ]);
            if(status==='complete') send('done',{conversationId:conversation.id,usage});
            else send('error',{message:failure,status});
          } catch { send('error',{message:'回答记录保存失败，请稍后刷新查看。',status:'error'}); }
          finally { await release(db,user.id,requestId).catch(()=>{}); if(!cancelled)controller.close(); }
        }
      })();
      context.waitUntil?.(task);
    },
    cancel(){abort();}
  });
  return new Response(stream,{headers:{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
}

export async function handleChat(context) {
  const {request,env}=context; const path=new URL(request.url).pathname;
  try {
    if (!['GET','POST','DELETE'].includes(request.method)) throw new ApiError(405,'不支持的请求方法。');
    if(request.method!=='GET')sameOrigin(request);
    const {db,user}=await requireUser(request,env); await initialize(db);
    if(path==='/api/chat/quota' && request.method==='GET') return json(await quota(db,user.id,env));
    if(path==='/api/chat' && request.method==='POST') return await generate(context,db,user,await bodyJson(request));
    if(path==='/api/conversations' && request.method==='GET') {
      const rows=await db.prepare('SELECT id,title,updated_at FROM chat_conversations WHERE user_id = ? ORDER BY updated_at DESC LIMIT 50').bind(user.id).all();
      return json({conversations:rows.results});
    }
    const match=path.match(/^\/api\/conversations\/([\da-f-]+)$/i);
    if(match){
      const conversation=await owned(db,user.id,match[1]);
      if(request.method==='GET') {
        const rows=await db.prepare('SELECT id,role,content,status,model FROM chat_messages WHERE conversation_id = ? ORDER BY id LIMIT 100').bind(conversation.id).all();
        return json({conversation,messages:rows.results});
      }
      if(request.method==='DELETE') {
        const lock=await db.prepare('SELECT request_id FROM chat_locks WHERE user_id = ? AND expires_at > ?').bind(user.id,Date.now()).first();
        if(lock)throw new ApiError(409,'请等待当前回答结束后再删除。');
        await db.batch([db.prepare('DELETE FROM chat_messages WHERE conversation_id = ?').bind(conversation.id),
          db.prepare('DELETE FROM chat_conversations WHERE id = ? AND user_id = ?').bind(conversation.id,user.id)]);
        return json({ok:true});
      }
    }
    throw new ApiError(404,'接口不存在。');
  }catch(err){return json({error:err instanceof ApiError ? err.message : '对话服务暂时不可用，请稍后重试。'},err instanceof ApiError ? err.status : 503);}
}
