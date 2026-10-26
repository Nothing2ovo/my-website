import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {onRequest} from '../functions/api/auth/[[path]].js';
import {handleChat} from '../server/chat.js';

export function fixture(extra = {}) {
  const sql=new DatabaseSync(':memory:');
  sql.exec('PRAGMA foreign_keys=ON;');
  sql.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));
  const wrap=(query,values=[])=>({
    bind(...next){return wrap(query,next);},
    async first(){return sql.prepare(query).get(...values)||null;},
    async all(){return {results:sql.prepare(query).all(...values)};},
    async run(){const r=sql.prepare(query).run(...values);return {meta:{last_row_id:Number(r.lastInsertRowid),changes:r.changes}};},
    execute(){const r=sql.prepare(query).run(...values);return {meta:{last_row_id:Number(r.lastInsertRowid),changes:r.changes}};}
  });
  const db={prepare:wrap,async batch(statements){sql.exec('BEGIN');try{const r=statements.map(s=>s.execute());sql.exec('COMMIT');return r;}catch(err){sql.exec('ROLLBACK');throw err;}}};
  const env={DB:db,OPENAI_API_KEY:'test-secret-not-real',...extra};const pending=[];
  async function call(path,{body,method,cookie,origin='https://atlas.example'}={}){
    const headers={Origin:origin,'Content-Type':'application/json','CF-Connecting-IP':'192.0.2.3'};
    if(cookie)headers.Cookie=cookie;
    const request=new Request(`https://atlas.example${path}`,{method:method||(body?'POST':'GET'),headers,body:body?JSON.stringify(body):undefined});
    const context={request,env,waitUntil:p=>pending.push(p)};
    return path.startsWith('/api/auth/')?onRequest(context):handleChat(context);
  }
  async function register(account='test_user'){
    const r=await call('/api/auth/register',{body:{account,name:'测试用户',email:`${account}@example.com`,password:'TestPassword_1026'}});
    if(r.status!==201)throw new Error(await r.text());
    return r.headers.get('Set-Cookie').split(';')[0];
  }
  return {sql,env,call,register,async finish(){await Promise.all(pending.splice(0));},close(){sql.close();}};
}

export function upstream(events){
  // Deliberately split UTF-8 and SSE frames across arbitrary byte boundaries.
  const bytes=new TextEncoder().encode(events.map(e=>`event: ${e.type}\r\ndata: ${JSON.stringify(e)}\r\n\r\n`).join(''));
  let offset=0;
  return new Response(new ReadableStream({pull(controller){if(offset>=bytes.length){controller.close();return;}controller.enqueue(bytes.slice(offset,offset+7));offset+=7;}}),{headers:{'Content-Type':'text/event-stream'}});
}
