import { randomBytes, randomUUID, scrypt, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { ensure } from './planner.js';
const derive=promisify(scrypt),sessionSeconds=7*24*60*60;
const digest=value=>createHash('sha256').update(value).digest('hex');
const publicUser=user=>({id:user.id,username:user.username,role:user.role});
const encode=(salt,key)=>salt+':'+key.toString('hex');
const dummySalt='00000000000000000000000000000000';
const dummyHash=encode(dummySalt,scryptSync('invalid-password',dummySalt,64));
export function createAuth(store){
  // Seed exactly once. Restarting never resets an existing account or its role.
  if(!store.userByName('admin')){
    const salt=randomBytes(16).toString('hex');
    store.createUser({id:randomUUID(),username:'admin',password_hash:encode(salt,scryptSync('admin',salt,64)),role:'admin',created_at:new Date().toISOString()});
  }
  const attempts=new Map();
  const token=cookies=>cookies.match(/(?:^|;\s*)mx_auth=([a-f0-9]{64})(?:;|$)/)?.[1];
  function limit(ip){
    const now=Date.now();for(const [key,item] of attempts)if(item.expires<=now)attempts.delete(key);
    let entry=attempts.get(ip);
    if(!entry){ensure(attempts.size<10000,'登录服务繁忙，请稍后重试',429);entry={count:0,expires:now+15*60*1000};attempts.set(ip,entry);}
    ensure(++entry.count<=20,'登录或注册尝试过多，请15分钟后重试',429);
  }
  function credentials(body,register){
    const username=typeof body.username==='string'?body.username.trim().toLowerCase():'';
    ensure(/^[a-z0-9_]{3,32}$/.test(username),'用户名须为3—32位英文字母、数字或下划线');
    ensure(typeof body.password==='string'&&body.password.length>=(register?8:1)&&body.password.length<=128,register?'密码须为8—128位字符':'请输入密码（最多128位）');
    return {username,password:body.password};
  }
  function cookie(value,secure,age=sessionSeconds){return `mx_auth=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${age}${secure?'; Secure':''}`;}
  return {
    current(cookies){const value=token(cookies);return value?store.loginUser(digest(value))||null:null;},
    async authenticate(body,{register=false,ip,cookies,guest,secure}){
      limit(ip);const {username,password}=credentials(body,register);let user=store.userByName(username);
      if(register){
        ensure(!user,'该用户名已被使用',409);
        const salt=randomBytes(16).toString('hex'),password_hash=encode(salt,await derive(password,salt,64));
        // Password hashing yields: recheck uniqueness after other registrations finish.
        ensure(!store.userByName(username),'该用户名已被使用',409);
        user=store.createUser({id:randomUUID(),username,password_hash,role:'user',created_at:new Date().toISOString()});
      }else{
        const [salt,expected]=(user?.password_hash||dummyHash).split(':');
        const actual=await derive(password,salt,64);
        ensure(timingSafeEqual(actual,Buffer.from(expected,'hex'))&&user,'用户名或密码不正确',401);
      }
      const previous=token(cookies);if(previous)store.deleteLogin(digest(previous));
      const value=randomBytes(32).toString('hex');store.saveLogin(digest(value),user.id,Date.now()+sessionSeconds*1000);
      store.claimGuest(guest,user.id);
      return {user:publicUser(user),cookie:cookie(value,secure)};
    },
    logout(cookies,secure){const value=token(cookies);if(value)store.deleteLogin(digest(value));return cookie('',secure,0);}
  };
}
