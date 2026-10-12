import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../server/index.js';
import { dispatch,mergeCookies } from './harness.js';
const credentials={username:'traveler',password:'travel-pass-123'};
const plan={city:'杭州',date:'2026-10-15',days:1,budget:300,walk_limit_km:6,interests:['自然'],start_time:'09:00',end_time:'18:00',companion:'独自',model_consent:false};
function client(app){let cookie='';return {get cookie(){return cookie;},async request(path,body,headers={}){const r=await dispatch(app,'/api'+path,body,{cookie,...headers});cookie=mergeCookies(cookie,r.headers['set-cookie']);return r;}};}
function fixture(t){const app=createApp({database:':memory:'});t.after(()=>app.emit('close'));return {app,browser:client(app)};}
test('registration creates only a regular user, normalizes name, validates credentials and rejects duplicates',async t=>{
 const {browser}=fixture(t);
 assert.equal((await browser.request('/auth/me')).body.user,null);
 for(const b of [{username:'ab',password:'12345678'},{username:'../admin',password:'12345678'},{username:'valid',password:'short'},{username:'valid',password:'x'.repeat(129)}])assert.equal((await browser.request('/auth/register',b)).status,400);
 const r=await browser.request('/auth/register',{...credentials,username:' TRAVELER ',role:'admin'});assert.equal(r.status,201);assert.equal(r.body.user.role,'user');assert.equal(r.body.user.username,'traveler');assert.deepEqual(Object.keys(r.body.user).sort(),['id','role','username']);
 assert.equal((await browser.request('/auth/me')).body.user.id,r.body.user.id);
 assert.equal((await browser.request('/auth/register',credentials)).status,409);
 assert.equal((await browser.request('/auth/register',{username:'ADMIN',password:'new-password'})).status,409);
});
test('only authenticated admin can read or run operations; old bearer tokens and role fields cannot bypass',async t=>{
 const {app,browser}=fixture(t);
 assert.equal((await browser.request('/ops')).status,401);
 assert.equal((await browser.request('/ops/run',{job:'poi_audit'},{authorization:'Bearer anything'})).status,401);
 await browser.request('/auth/register',credentials);assert.equal((await browser.request('/ops')).status,403);assert.equal((await browser.request('/ops/run',{job:'feedback',role:'admin'})).status,403);
 const admin=client(app);assert.equal((await admin.request('/auth/login',{username:'admin',password:'admin'})).body.user.role,'admin');
 assert.equal((await admin.request('/ops')).status,200);assert.equal((await admin.request('/ops/run',{job:'poi_audit'})).status,200);
});
test('guest trips migrate to account, persist across devices, and stay private after logout and another login',async t=>{
 const {app,browser}=fixture(t);const trip=(await browser.request('/trip/plan',plan)).body;const oldGuest=browser.cookie;
 await browser.request('/auth/register',credentials);assert.equal((await browser.request('/trips')).body.trips.length,1);
 const second=client(app);await second.request('/auth/login',credentials);assert.equal((await second.request('/trip/'+trip.id)).status,200);
 const other=client(app);await other.request('/auth/register',{username:'other',password:'another-password'});assert.equal((await other.request('/trip/'+trip.id)).status,404);
 const oldSession=browser.cookie;await browser.request('/auth/logout',{});assert.equal((await browser.request('/auth/me')).body.user,null);assert.equal((await browser.request('/trip/'+trip.id)).status,404);
 for(const cookie of [oldGuest,oldSession])assert.equal((await dispatch(app,'/api/trip/'+trip.id,undefined,{cookie})).status,404);
 assert.equal((await second.request('/trip/'+trip.id)).status,200);
});
test('incorrect credentials have a generic error; logout and expiry invalidate server sessions',async t=>{
 const {app,browser}=fixture(t);
 for(const username of ['admin','missing']){const r=await browser.request('/auth/login',{username,password:'wrong'});assert.equal(r.status,401);assert.equal(r.body.error,'用户名或密码不正确');}
 await browser.request('/auth/login',{username:'admin',password:'admin'});const cookie=browser.cookie;
 const now=Date.now;try{Date.now=()=>now()+8*86400000;assert.equal((await browser.request('/auth/me')).body.user,null);assert.equal((await browser.request('/ops')).status,401);}finally{Date.now=now;}
 await browser.request('/auth/logout',{});assert.equal((await dispatch(app,'/api/ops',undefined,{cookie})).status,401);
});
test('cross-site login is blocked and credential attempts are rate limited',async t=>{
 const {browser}=fixture(t);assert.equal((await browser.request('/auth/login',{username:'admin',password:'admin'},{origin:'https://evil.example'})).status,403);
 for(let i=0;i<20;i++)assert.equal((await browser.request('/auth/login',{username:'admin',password:'wrong'})).status,401);
 assert.equal((await browser.request('/auth/login',{username:'admin',password:'admin'})).status,429);
});
test('passwords and login tokens are hashed at rest, sessions and seeded admin survive restart without reseeding',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'manxing-auth-')),database=join(dir,'test.sqlite');let app,db;
 try{
  app=createApp({database});const browser=client(app);await browser.request('/auth/register',credentials);const cookie=browser.cookie;
  db=new DatabaseSync(database);const users=db.prepare('SELECT * FROM users').all();assert.equal(users.length,2);
  for(const u of users){assert.match(u.password_hash,/^[a-f0-9]{32}:[a-f0-9]{128}$/);assert.ok(!u.password_hash.includes(credentials.password));}
  const session=db.prepare('SELECT token_hash FROM auth_sessions').get();assert.ok(!cookie.includes(session.token_hash));
  // Persist a deliberate change to the seed account and prove startup does not reset it.
  db.prepare('UPDATE users SET password_hash=? WHERE username=?').run(users.find(u=>u.username==='traveler').password_hash,'admin');db.close();db=null;
  app.emit('close');app=createApp({database});assert.equal((await dispatch(app,'/api/auth/me',undefined,{cookie})).body.user.username,'traveler');
  const admin=client(app);assert.equal((await admin.request('/auth/login',{username:'admin',password:'admin'})).status,401);assert.equal((await admin.request('/auth/login',{username:'admin',password:credentials.password})).status,200);
 }finally{db?.close();app?.emit('close');await rm(dir,{recursive:true,force:true});}
});
