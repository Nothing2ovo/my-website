(() => {
  'use strict';
  const $=selector=>document.querySelector(selector);
  let user=null,conversationId=null,busy=false,aborter=null,version=0,quota=null,lockedModel=false;
  const models=[{id:'qwen3',name:'Qwen3'},{id:'glm-flash',name:'GLM 4.7 Flash'},{id:'llama-3.3',name:'Llama 3.3'}];
  function selectModel(id){
    const found=models.find(model=>model.id===id);
    $('#model-select').value=found?found.id:'qwen3';
    $('#model-name').textContent=found?found.name:'历史模型';
  }
  const statuses={error:'回答中断',stopped:'已停止',incomplete:'回答未完成',generating:'生成中或连接已中断',pending:'未完成'};
  function notice(text,error=false,login=false){
    const box=$('#chat-notice'); box.replaceChildren(); box.classList.toggle('error',error); box.hidden=!text;
    if(text)box.append(document.createTextNode(text));
    if(login){const button=document.createElement('button');button.textContent='去登录';button.onclick=()=>$('#open-login').click();box.append(button);}
  }
  async function api(path,options={}){
    const response=await fetch(path,{credentials:'same-origin',cache:'no-store',...options});
    if(!(response.headers.get('Content-Type')||'').includes('application/json'))throw new Error('服务尚未部署，请通过 Cloudflare 网站访问。');
    const data=await response.json();
    if(!response.ok){if(response.status===401)changedUser(null);throw new Error(data.error||'请求失败，请重试。');}
    return data;
  }
  function controls(){
    $('#send-chat').disabled=busy||!!user&&(!quota?.configured||!quota?.available||quota?.remaining<=0);
    $('#send-chat').textContent=user?'发送 ↗':'登录后发送';
    $('#stop-chat').hidden=!busy; $('#chat-input').disabled=busy;
    $('#new-chat').disabled=busy;
    $('#model-select').disabled=busy||lockedModel;
    $('#model-select').title=lockedModel?'新建对话可切换模型':'选择模型';
    document.querySelectorAll('.history button').forEach(button=>button.disabled=busy);
  }
  function empty(){ $('#messages').replaceChildren();$('#chat-welcome').hidden=false;document.body.classList.remove('has-messages');conversationId=null;lockedModel=false;$('#conversation-title').textContent='';controls(); }
  function message(role,text='',status=''){
    $('#chat-welcome').hidden=true;
    document.body.classList.add('has-messages');
    const article=document.createElement('article');article.className=`message ${role}`;
    const avatar=document.createElement('span');avatar.className='message-avatar';avatar.textContent=role==='user'?'你':'✳';avatar.setAttribute('aria-hidden','true');
    const body=document.createElement('div');body.className='message-body';
    const label=document.createElement('div');label.className='message-label';label.textContent=role==='user'?'你':'AI 助手';
    const content=document.createElement('div');content.className='message-text';content.textContent=text;
    if(role==='assistant'){const copy=document.createElement('button');copy.className='copy-message';copy.textContent='复制';copy.onclick=async()=>{try{await navigator.clipboard.writeText(content.textContent);copy.textContent='已复制';}catch{copy.textContent='复制失败';}};label.append(copy);}
    const state=document.createElement('div');state.className='message-status';state.textContent=statuses[status]||'';
    body.append(label,content,state);article.append(avatar,body);$('#messages').append(article);
    return {content,state};
  }
  function scroll(){const area=$('#chat-content');area.scrollTop=area.scrollHeight;}
  async function refreshQuota(){
    if(!user)return;const current=version;
    try{
      const data=await api('/api/chat/quota');if(current!==version)return;quota=data;
      $('#quota-label').textContent=`今日剩余 ${data.remaining} 次`;
      if(!data.configured)notice('AI 服务暂未连接，请联系管理员。');
      else if(!data.available)notice('本站今日额度已用完，明天再来聊聊。');
      else if(!data.remaining)notice('你已用完今日对话额度，明天继续。');
      controls();
    }catch(err){if(current===version)notice(err.message,true);}
  }
  async function history(){
    if(!user)return;const current=version;
    try{
      const data=await api('/api/conversations');if(current!==version)return;
      const list=$('#history');list.replaceChildren();
      if(!data.conversations.length){const p=document.createElement('p');p.textContent='还没有对话，从一个问题开始。';list.append(p);}
      for(const item of data.conversations){
        const row=document.createElement('div');row.className=`history-item${item.id===conversationId?' selected':''}`;
        const open=document.createElement('button');open.className='history-open';open.textContent=item.title;open.title=item.title;
        open.onclick=async()=>{if(busy)return;const rev=++version;try{const detail=await api(`/api/conversations/${item.id}`);if(rev!==version)return;empty();conversationId=item.id;const previous=detail.conversation.model||detail.messages.find(m=>m.role==='assistant')?.model;lockedModel=true;selectModel(previous);$('#conversation-title').textContent=item.title;for(const m of detail.messages)message(m.role,m.content,m.status);if(!models.some(m=>m.id===previous))notice('这段历史使用旧模型，请新建对话。');await history();scroll();controls();}catch(err){notice(err.message,true);}};
        const remove=document.createElement('button');remove.className='history-delete';remove.textContent='×';remove.setAttribute('aria-label',`删除对话：${item.title}`);
        remove.onclick=()=>askDelete(item);
        row.append(open,remove);list.append(row);
      } controls();
    }catch(err){if(current===version)notice(err.message,true);}
  }
  let deleting=null;
  function askDelete(item){if(busy)return;deleting=item;$('#delete-title').textContent=`删除“${item.title}”？`;$('#delete-chat').showModal();}
  $('#cancel-delete').onclick=()=>$('#delete-chat').close();
  $('#confirm-delete').onclick=async()=>{
    const item=deleting;if(!item)return;$('#confirm-delete').disabled=true;
    try{await api(`/api/conversations/${item.id}`,{method:'DELETE',headers:{'Content-Type':'application/json'}});if(conversationId===item.id)empty();$('#delete-chat').close();await history();}
    catch(err){notice(err.message,true);$('#delete-chat').close();}finally{$('#confirm-delete').disabled=false;}
  };
  async function changedUser(next){
    if(user?.id===next?.id)return;
    const draft=!user&&next?$('#chat-input').value:'';
    version++;aborter?.abort();user=next;quota=null;empty();$('#history').replaceChildren();
    $('#chat-input').value=draft;$('#char-count').textContent=`${draft.length} / 2000`;selectModel($('#model-select').value);
    if($('#delete-chat').open)$('#delete-chat').close();
    if(!user){notice('登录后开始对话',false,true);$('#quota-label').textContent='';}
    else {notice('正在连接 AI 服务…');await Promise.all([history(),refreshQuota()]);if(quota?.configured&&quota.available&&quota.remaining>0)notice('');}
    controls();
  }
  window.addEventListener('atlas-auth',event=>changedUser(event.detail));
  $('#new-chat').onclick=()=>{if(!busy){empty();history();$('#chat-input').focus();}};
  document.querySelectorAll('[data-prompt]').forEach(button=>button.onclick=()=>{$('#chat-input').value=button.dataset.prompt;$('#chat-input').focus();$('#char-count').textContent=`${$('#chat-input').value.length} / 2000`;});
  $('#chat-input').addEventListener('input',()=>$('#char-count').textContent=`${$('#chat-input').value.length} / 2000`);
  $('#chat-input').addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();$('#chat-form').requestSubmit();}});
  $('#stop-chat').onclick=()=>aborter?.abort();
  $('#chat-form').addEventListener('submit',async event=>{
    event.preventDefault();const text=$('#chat-input').value.trim();
    if(busy||!text)return;
    if(!user){$('#open-login').click();return;}
    if(!quota?.configured||quota.remaining<=0||!quota.available){await refreshQuota();return;}
    const current=version;busy=true;aborter=new AbortController();controls();notice('');
    message('user',text);const reply=message('assistant','正在思考…');let output='',terminal=false;
    $('#chat-input').value='';$('#char-count').textContent='0 / 2000';scroll();
    try{
      const response=await fetch('/api/chat',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({message:text,conversationId,model:$('#model-select').value}),signal:aborter.signal});
      if(!response.ok){const data=await response.json().catch(()=>({}));if(response.status===401)changedUser(null);throw new Error(data.error||'发送失败，请稍后重试。');}
      if(!(response.headers.get('Content-Type')||'').includes('text/event-stream'))throw new Error('对话接口未部署，请联系管理员。');
      const reader=response.body.getReader();const decoder=new TextDecoder();let buffer='';
      try{
        for(;;){
          const {value,done}=await reader.read();buffer+=done?decoder.decode():decoder.decode(value,{stream:true});
          let end;while((end=buffer.indexOf('\n\n'))>=0){
            const frame=buffer.slice(0,end);buffer=buffer.slice(end+2);
            const kind=frame.split('\n').find(line=>line.startsWith('event:'))?.slice(6).trim();
            const data=JSON.parse(frame.split('\n').filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n'));
            if(current!==version)continue;
            if(kind==='meta'){conversationId=data.conversationId;lockedModel=true;selectModel(data.model);$('#conversation-title').textContent=data.title||'';}
            if(kind==='delta'){output+=data.text;reply.content.textContent=output;scroll();}
            if(kind==='done'){terminal=true;reply.content.textContent=output||'（模型未返回文字）';}
            if(kind==='error'){terminal=true;reply.content.textContent=output||'未生成回答。';reply.state.textContent=data.message;}
          }
          if(done)break;
        }
      }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
      if(!terminal)throw new Error('连接提前结束，请刷新历史记录后重试。');
    }catch(err){if(current===version){reply.content.textContent=output||'未生成回答。';reply.state.textContent=err.name==='AbortError'?'已停止生成，部分回答稍后会保存到历史记录。':err.message;}}
    finally{busy=false;aborter=null;if(current===version){await Promise.all([history(),refreshQuota()]);$('#chat-input').focus();}controls();}
  });
  $('#model-select').addEventListener('change',()=>selectModel($('#model-select').value));
  $('#show-info').onclick=()=>$('#chat-info').showModal();
  $('#close-info').onclick=()=>$('#chat-info').close();
  notice('');selectModel('qwen3');controls();
})();
