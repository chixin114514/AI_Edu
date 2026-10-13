import { randomBytes, createHash } from 'node:crypto';
import { ensure } from './planner.js';

const hash=value=>createHash('sha256').update(value).digest('hex');
const FRESH=20000,PAIR_TTL=300000,LINK_TTL=4*3600000;
// Process memory only. Never give this object to the database, logs or models.
export function createWatchRelay({now=Date.now}={}){
  const links=new Map(),attempts=new Map();
  function purge(){
    const t=now();
    for(const [id,l] of links){
      if(t>=l.expires_at||(!l.token_hash&&t>=l.pair_expires_at))links.delete(id);
      else if(l.sample&&t-l.sample.timestamp>FRESH)l.sample=null;
    }
    for(const [ip,a] of attempts)if(t-a.at>=PAIR_TTL)attempts.delete(ip);
  }
  const timer=setInterval(purge,1000);timer.unref?.();
  function revokeOwner(owner){for(const [id,l] of links)if(l.owner===owner)links.delete(id);}
  function device(token){
    purge();ensure(typeof token==='string'&&/^[a-f0-9]{64}$/.test(token),'配对已失效，请重新配对',401);
    const digest=hash(token),l=[...links.values()].find(l=>l.token_hash===digest);
    ensure(l,'配对已失效，请重新配对',401);return l;
  }
  return {
    create(owner,session_id){
      purge();ensure(links.size<1000||[...links.values()].some(l=>l.owner===owner),'连接人数过多，请稍后重试',503);
      revokeOwner(owner);
      let code;do{code=randomBytes(4).toString('hex').toUpperCase();}while([...links.values()].some(l=>l.code_hash===hash(code)));
      const t=now(),l={owner,session_id,code_hash:hash(code),pair_expires_at:t+PAIR_TTL,expires_at:t+LINK_TTL,sample:null,sequence:0};
      links.set(session_id,l);
      return {code,pair_expires_at:l.pair_expires_at,expires_at:l.expires_at};
    },
    pair(code,ip){
      purge();const a=attempts.get(ip)||{at:now(),count:0};
      ensure(attempts.size<10000||attempts.has(ip),'请稍后再试',429);
      attempts.set(ip,a);ensure(++a.count<=10,'配对尝试过多，请5分钟后重试',429);
      ensure(typeof code==='string'&&/^[A-Fa-f0-9]{8}$/.test(code),'配对码无效或已过期',401);
      const l=[...links.values()].find(l=>l.code_hash===hash(code.toUpperCase())&&!l.token_hash);
      ensure(l,'配对码无效或已过期',401);
      const token=randomBytes(32).toString('hex');l.token_hash=hash(token);delete l.code_hash;
      return {token,expires_at:l.expires_at,sample_interval_s:5};
    },
    sample(token,b){
      const l=device(token),t=now();
      ensure(Object.keys(b).every(k=>['bpm','timestamp','sequence'].includes(k)),'仅接受心率、时间和序号');
      ensure(typeof b.bpm==='number'&&Number.isFinite(b.bpm)&&b.bpm>=25&&b.bpm<=240,'心率数值无效');
      ensure(Number.isSafeInteger(b.timestamp)&&b.timestamp>=t-FRESH&&b.timestamp<=t+5000,'心率已过期或设备时间不正确');
      ensure(Number.isSafeInteger(b.sequence)&&b.sequence>l.sequence,'重复或乱序心率已忽略',409);
      ensure(!l.last_timestamp||b.timestamp>l.last_timestamp,'重复或乱序心率已忽略',409);
      ensure(!l.last_received||t-l.last_received>=2000,'发送过于频繁',429);
      l.sequence=b.sequence;l.last_timestamp=b.timestamp;l.last_received=t;
      l.sample={bpm:b.bpm,timestamp:b.timestamp,sequence:b.sequence};return {accepted:true};
    },
    state(owner,session_id){
      purge();const l=links.get(session_id);
      if(!l||l.owner!==owner)return {status:'disconnected',sample:null};
      return {status:!l.token_hash?'waiting':l.sample?'live':'waiting_for_sample',sample:l.sample?{...l.sample}:null,expires_at:l.expires_at};
    },
    disconnect(token){const l=device(token);links.delete(l.session_id);return {disconnected:true};},
    revoke(owner,session_id){const l=links.get(session_id);if(l?.owner===owner)links.delete(session_id);},
    revokeOwner,
    close(){clearInterval(timer);links.clear();attempts.clear();}
  };
}
