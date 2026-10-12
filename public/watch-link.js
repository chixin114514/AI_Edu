// Safari reads only the current travel session's short-lived relay. No local storage.
export class WatchLink {
  constructor(onState){this.onState=onState;this.revision=0;this.lifecycle=Promise.resolve();}
  async request(path,data){
    const response=await fetch('/api/watch/'+path,{method:data===undefined?'GET':'POST',headers:data===undefined?{}:{'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data),cache:'no-store',keepalive:data!==undefined});
    const result=await response.json();if(!response.ok)throw Error(result.error||'手表连接失败');return result;
  }
  start(session_id){
    const previous=this.session_id,revision=++this.revision;
    clearTimeout(this.timer);this.session_id=session_id;
    const operation=this.lifecycle.catch(()=>{}).then(async()=>{
      if(previous)await this.request('unlink',{session_id:previous});
      if(revision!==this.revision)throw Error('连接已取消');
      const pairing=await this.request('link',{session_id,relay_consent:true});
      if(revision!==this.revision){await this.request('unlink',{session_id});throw Error('连接已取消');}
      this.onState({status:'waiting',sample:null});this.poll(revision);return pairing;
    });
    this.lifecycle=operation;
    return operation.catch(error=>{if(revision===this.revision)this.session_id=null;throw error;});
  }
  async poll(revision){
    if(revision!==this.revision)return;
    try{
      if(!document.hidden){
        const result=await this.request('state?session_id='+encodeURIComponent(this.session_id));
        if(revision!==this.revision)return;
        this.onState(result);
        if(result.status==='disconnected'){this.session_id=null;return;}
      }
    }catch(error){if(revision!==this.revision)return;this.onState({status:'unavailable',sample:null,message:error.message});}
    if(revision===this.revision)this.timer=setTimeout(()=>this.poll(revision),2500);
  }
  stop(){
    this.revision++;clearTimeout(this.timer);const session_id=this.session_id;this.session_id=null;
    const operation=this.lifecycle.catch(()=>{}).then(async()=>{
      if(session_id)await this.request('unlink',{session_id});
    });
    this.lifecycle=operation;return operation;
  }
}
