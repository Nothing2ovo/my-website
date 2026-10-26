import {onRequest as auth} from './functions/api/auth/[[path]].js';
import {handleChat} from './server/chat.js';

export default {
  async fetch(request, env, execution) {
    const path=new URL(request.url).pathname;
    const context={request,env,waitUntil:promise=>execution.waitUntil(promise)};
    if(path.startsWith('/api/auth/'))return auth(context);
    if(path==='/api/chat'||path.startsWith('/api/chat/')||path==='/api/conversations'||path.startsWith('/api/conversations/'))return handleChat(context);
    if(path.startsWith('/api/'))return new Response(JSON.stringify({error:'接口不存在。'}),{status:404,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
    return env.ASSETS.fetch(request);
  }
};
