import { probeProvider, qweatherNow, decision, explain, providerStatus } from '../server/providers.js';

// Deliberately uses only public sample coordinates and synthetic, non-personal model input.
process.env.DATA_MODE='live';
const probes={
  maps:()=>probeProvider('maps'),
  weather:()=>qweatherNow(),
  jev:()=>decision({hr_vs_baseline_pct:0,duration_s:0,cadence_change_pct:0,walked_km_today:0},true),
  deepseek:()=>explain({purpose:'Synthetic connection check',stops:['杭州西湖'],instruction:'这是合成测试，不是真实用户行程。'},true)
};
const names=process.argv.slice(2).length?process.argv.slice(2):Object.keys(probes);
if(names.some(n=>!probes[n])){console.error('Allowed providers: maps weather jev deepseek');process.exitCode=2;}
else {
  await Promise.all(names.map(async name=>{
    const start=Date.now();let ok=false,details={};
    try{
      const result=await probes[name]();
      ok=name==='maps'?result.ok:Boolean(result);
      if(name==='maps')details={checks:result.checks,message:result.message};
    }catch{}
    const status=providerStatus()[name];
    console.log(JSON.stringify({provider:name,ok,elapsed_ms:Date.now()-start,...status,...details}));
    if(!ok)process.exitCode=1;
  }));
}
