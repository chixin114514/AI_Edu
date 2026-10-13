import { WatchLink } from './watch-link.js';
export function parseHeartRate(view){
  if(view.byteLength<2)throw new Error('心率数据长度不足');
  const flags=view.getUint8(0);if((flags&1)&&view.byteLength<3)throw new Error('心率数据长度不足');
  if((flags&4)&&!(flags&2))return null; // Sensor contact supported but not detected.
  const value=flags&1?view.getUint16(1,true):view.getUint8(1);
  return value>=25&&value<=240?value:null;
}
// 是否应把"页面不可见"视为数据断档。
// 网页端：切后台后浏览器会冻结页面，数据确实断档，需要清空趋势窗口。
// 原生容器：由前台服务保活（mobile/src/keepalive-native.js），数据不断档，
// 交给过期判断处理即可，否则锁屏走路时心率趋势会被白白丢掉。
const backgroundIsPaused=()=>document.hidden&&!globalThis.__manxingKeepBackgroundTrends;
export function sensorFeatures({hr,baseline,cadence,cadenceBaseline,highSince,totalSteps=0},now=Date.now()){
  const result={walked_km_today:Math.round(totalSteps*.00065*100)/100};
  if(hr&&baseline&&cadence!=null&&cadenceBaseline){
    result.hr_vs_baseline_pct=Math.round((hr/baseline-1)*100);
    result.duration_s=highSince!=null?Math.max(0,Math.floor((now-highSince)/1000)):0;
    result.cadence_change_pct=Math.round((cadence/cadenceBaseline-1)*100);
  }
  return result;
}
export class Sensors extends EventTarget{
  constructor(){super();this.connectionRevision=0;this.source=null;this.watchStatus=null;this.watchSequence=0;this.watch=new WatchLink(v=>this.receiveWatch(v));this.hr=null;this.baseline=null;this.samples=[];this.steps=[];this.cadence=null;this.totalSteps=0;this.calibrating=false;this.highSince=null;this.lastPeak=0;this.motionActive=false;this.lastMotion=0;this.position=null;this.onMotion=this.onMotion.bind(this);this.hidden=()=>{if(!document.hidden)return;if(this.source==='watch'){this.watchStatus='background';this.watchSampleAfter=Date.now();}if(globalThis.__manxingKeepBackgroundTrends)return;this.hr=null;this.baseline=null;this.lastHr=null;this.highSince=null;this.steps=[];this.cadence=null;this.samples=[];this.calibrating=false;this.emit(this.source||this.motionActive?'页面切到后台，心率和步频会重新统计':undefined);};document.addEventListener('visibilitychange',this.hidden);this.timer=setInterval(()=>{const now=Date.now();if(this.lastHr&&now-this.lastHr>(this.source==='watch'?20000:10000)){this.hr=null;this.highSince=null;this.samples=[];if(this.source==='watch'&&this.watchStatus==='live')this.watchStatus='waiting_for_sample';}if(this.lastMotion&&now-this.lastMotion>5000)this.cadence=null;this.steps=this.steps.filter(t=>t>now-60000);this.emit();},2000);}
  emit(message){this.dispatchEvent(new CustomEvent('change',{detail:{hr:this.hr,baseline:this.baseline,cadence:this.cadence,steps:this.totalSteps,motionActive:this.motionActive,connected:this.source==='watch'?this.watchStatus==='live':!!this.device?.gatt?.connected,source:this.source,watchStatus:this.watchStatus,calibrating:this.calibrating,position:this.position,message}}));}
  async connect(){
    if(!window.isSecureContext)throw Error('蓝牙需要HTTPS或本机localhost安全环境。');
    if(!navigator.bluetooth)throw Error('当前浏览器不支持网页蓝牙。iPhone上的Chrome也不支持；可继续使用无设备模式。');
    this.disconnect();this.source='bluetooth';const revision=this.connectionRevision;
    const device=await navigator.bluetooth.requestDevice({filters:[{services:['heart_rate']}]});
    const ensureCurrent=()=>{if(revision!==this.connectionRevision){if(this.device!==device)device.gatt.disconnect();throw Error('连接已取消');}};
    ensureCurrent();this.device=device;
    device.addEventListener('gattserverdisconnected',()=>{if(revision!==this.connectionRevision||this.source!=='bluetooth')return;this.hr=null;this.baseline=null;this.samples=[];this.highSince=null;this.calibrating=false;this.emit('设备已断开');},{once:true});
    const server=await device.gatt.connect();ensureCurrent();
    const service=await server.getPrimaryService('heart_rate');ensureCurrent();
    const characteristic=await service.getCharacteristic('heart_rate_measurement');ensureCurrent();
    await characteristic.startNotifications();ensureCurrent();
    characteristic.addEventListener('characteristicvaluechanged',event=>{
      if(revision!==this.connectionRevision||this.source!=='bluetooth')return;
      let value;try{value=parseHeartRate(event.target.value);}catch{return;}
      this.receiveHeartRate(value,Date.now());
    });this.emit('设备已连接。坐下歇一会儿，再点「采集静息心率」。');
  }

  receiveHeartRate(value,now){
      if(!value||backgroundIsPaused()){this.hr=null;this.highSince=null;return;}
      if(this.lastHr&&now-this.lastHr>(this.source==='watch'?20000:5000)){this.highSince=null;if(this.calibrating){this.samples=[];this.calibrationStart=now;}}
      this.hr=value;this.lastHr=now;this.samples.push({at:now,value});this.samples=this.samples.filter(s=>s.at>now-180000);
      if(this.calibrating&&now-this.calibrationStart>=30000&&this.samples.length>=(this.source==='watch'?6:20)){const v=this.samples.filter(s=>s.at>=this.calibrationStart).map(s=>s.value).sort((a,b)=>a-b);this.baseline=v[Math.floor(v.length/2)];this.calibrating=false;this.emit('静息心率采集好了');}
      if(this.baseline&&value>=this.baseline*1.25)this.highSince??=now;else this.highSince=null;
      this.emit();
  }
  async connectWatch(session_id){
    this.disconnect();const revision=this.connectionRevision;this.source='watch';this.watchSequence=0;this.watchStatus='waiting';
    try{return await this.watch.start(session_id);}catch(error){if(revision===this.connectionRevision){this.source=null;this.watchStatus=null;this.emit();}throw error;}
  }
  receiveWatch(result){
    if(this.source!=='watch'||(backgroundIsPaused()&&result.status!=='disconnected'))return;
    const previous=this.watchStatus;this.watchStatus=result.status;
    if(result.status==='live'&&result.sample&&result.sample.sequence>this.watchSequence&&(!this.watchSampleAfter||result.sample.timestamp>this.watchSampleAfter)){
      this.watchSequence=result.sample.sequence;this.receiveHeartRate(result.sample.bpm,result.sample.timestamp);
    }else if(result.status!=='live'){this.hr=null;this.highSince=null;this.samples=[];if(this.calibrating){this.calibrationStart=Date.now();}}
    if(result.status==='live'&&!this.hr)this.watchStatus='waiting_for_sample';
    if(result.status==='disconnected'){this.baseline=null;this.calibrating=false;}
    this.emit(previous!==result.status&&result.status==='disconnected'?'Apple Watch连接已结束，请重新配对。':undefined);
  }
  calibrate(){if(!(this.source==='watch'?this.watchStatus==='live':this.device?.gatt?.connected))throw Error('请先连接心率设备并等待实时读数。');this.calibrating=true;this.calibrationStart=Date.now();this.samples=[];this.baseline=null;this.highSince=null;this.emit('请静坐30秒，保持页面在前台。');}
  disconnect(){this.connectionRevision=(this.connectionRevision||0)+1;this.source=null;this.watchStatus=null;this.watchSequence=0;this.watchSampleAfter=null;this.watch.stop().catch(()=>this.emit('未能通知服务端断开手表，请在手表上停止采集或联网后结束行程。'));const device=this.device;this.device=null;device?.gatt?.disconnect();this.hr=null;this.baseline=null;this.samples=[];this.highSince=null;this.calibrating=false;this.lastHr=null;this.emit();}
  async startMotion(){
    if(!window.DeviceMotionEvent)throw Error('当前浏览器不支持运动传感器。');
    if(typeof DeviceMotionEvent.requestPermission==='function'&&await DeviceMotionEvent.requestPermission()!=='granted')throw Error('未获得运动权限，可使用手动反馈。');
    if(!this.motionActive){window.addEventListener('devicemotion',this.onMotion);this.motionActive=true;this.motionStart=Date.now();}
    this.emit('步频已开启');
  }
  onMotion(event){
    if(backgroundIsPaused())return;const a=event.accelerationIncludingGravity;if(!a||a.x==null)return;
    const now=Date.now(),magnitude=Math.hypot(a.x,a.y,a.z);this.lastMotion=now;
    if(magnitude>12.2&&now-this.lastPeak>300){this.steps.push(now);this.totalSteps++;this.lastPeak=now;}
    this.steps=this.steps.filter(t=>t>now-60000);
    this.cadence=Math.round(this.steps.length*60000/Math.min(60000,Math.max(10000,now-this.motionStart)));
    if(this.cadence>=60&&this.cadenceBaseline==null&&now-this.motionStart>60000)this.cadenceBaseline=this.cadence;
  }
  async locate(){
    if(!window.isSecureContext)throw Error('定位需要HTTPS连接或本机localhost；手机访问普通HTTP地址时无法定位。');
    if(!navigator.geolocation)throw Error('当前浏览器无法定位。');
    const position=await new Promise((resolve,reject)=>navigator.geolocation.getCurrentPosition(resolve,e=>reject(Error({1:'定位权限已被拒绝，可在浏览器网站设置中允许位置权限，或手动选择目的地。',2:'暂时无法获取位置，请检查系统定位服务后重试。',3:'定位超时，请在信号较好的位置重试。'}[e.code]||'定位失败，请重试。')),{enableHighAccuracy:true,timeout:12000,maximumAge:0}));
    this.position={lat:position.coords.latitude,lng:position.coords.longitude,accuracy:position.coords.accuracy,coordinate_system:'WGS84'};this.emit();return this.position;
  }
  features(){
    return sensorFeatures(this);
  }
  stop(){this.disconnect();window.removeEventListener('devicemotion',this.onMotion);this.motionActive=false;this.hr=null;this.cadence=null;this.position=null;this.steps=[];this.totalSteps=0;this.cadenceBaseline=null;this.emit();}
}
