import React from 'react';
import {AbsoluteFill, OffthreadVideo, staticFile, interpolate, Easing, useCurrentFrame} from 'remotion';

const ink='#163b2c', muted='#758377', green='#1f7a55';
const clamp={extrapolateLeft:'clamp',extrapolateRight:'clamp'} as const;
const ease=Easing.bezier(.22,1,.36,1);
const chapters=[
  {from:0,to:5.8,kicker:'01 / 为自己规划',title:['一段旅程，','从你开始。'],desc:['选好兴趣与时间，','安排适合自己的城市漫游。']},
  {from:5.8,to:14.7,kicker:'02 / 看清行程',title:['把想去的地方，','排进今天。'],desc:['查看每一站的安排，','点开详情，再从容出发。']},
  {from:14.7,to:22.5,kicker:'03 / 说出你的感受',title:['此刻的感受，','值得被听见。'],desc:['累了，或是想吃饭，','随时告诉慢行。']},
  {from:22.5,to:28.8,kicker:'04 / 由你决定',title:['每一次调整，','都由你确认。'],desc:['看清时间与路程的变化，','接受建议，也可以保留原路线。']},
  {from:28.8,to:39.2,kicker:'05 / 记录沿途',title:['把这一刻，','留给自己。'],desc:['写下观察，记录到访，','让沿途的感受有迹可寻。']},
  {from:39.2,to:45,kicker:'慢行 MANXING',title:['按你的节奏，','认识一座城。'],desc:['规划 · 伴行 · 调整 · 手记','一段完整的城市探索体验。']},
];

function Copy({item,t}:{item:typeof chapters[number];t:number}){
  const enter=interpolate(t,[item.from,item.from+.65],[0,1],{...clamp,easing:ease});
  const out=item.to===45?1:interpolate(t,[item.to-.22,item.to+.12],[1,0],clamp);
  return <div style={{position:'absolute',left:116,top:295,width:790,opacity:enter*out,transform:`translateY(${(1-enter)*22}px)`}}>
    <div style={{fontSize:20,letterSpacing:3,color:green,fontWeight:600,marginBottom:37}}>{item.kicker}</div>
    <div style={{fontSize:76,fontWeight:650,lineHeight:1.28,letterSpacing:-2.8,color:ink}}>{item.title.map((line,i)=><div key={line} style={{color:i===1?green:ink}}>{line}</div>)}</div>
    <div style={{width:52,height:3,background:green,marginTop:38,marginBottom:29,transformOrigin:'left',transform:`scaleX(${enter})`}}/>
    <div style={{fontSize:27,lineHeight:1.8,color:muted,fontWeight:400}}>{item.desc.map(line=><div key={line}>{line}</div>)}</div>
  </div>;
}

export const ManxingFilm:React.FC=()=>{
  const frame=useCurrentFrame(),t=frame/60;
  const reveal=interpolate(t,[0,.9],[0,1],{...clamp,easing:ease});
  // One persistent video: its timeline never resets when captions change.
  const scale=interpolate(t,[0,1.6,6,9,12,16,20,24,28,32,37,41,45],[.97,1.03,1.03,1.075,1.03,1.03,1.075,1.075,1.035,1.075,1.03,1.05,1.03],{...clamp,easing:Easing.inOut(Easing.cubic)});
  const drift=interpolate(t,[0,7,17,28,38,45],[24,0,-15,5,-7,0],{...clamp,easing:Easing.inOut(Easing.cubic)});
  const active=t<5.8?0:t<14.7?1:t<28.8?2:3;
  return <AbsoluteFill style={{background:'#f6f6f0',fontFamily:'"PingFang SC", "Arial Unicode MS", sans-serif',overflow:'hidden'}}>
    <AbsoluteFill style={{background:'radial-gradient(ellipse at 72% 43%, #e2edda 0%, #edf2e7 30%, #f6f6f0 65%)'}}/>
    <div style={{position:'absolute',width:1120,height:1120,border:'1px solid #dbe4d5',borderRadius:'50%',left:910,top:-15,opacity:.62,transform:`scale(${1+t*.0008})`}}/>
    <div style={{position:'absolute',width:1390,height:1390,border:'1px solid #e3e8dd',borderRadius:'50%',left:775,top:-150,opacity:.5}}/>
    <div style={{position:'absolute',left:112,top:77,display:'flex',alignItems:'center',gap:17,opacity:reveal}}>
      <svg width="50" height="50" viewBox="0 0 64 64"><rect width="64" height="64" rx="18" fill={green}/><path d="M14 44V26q0-15 12-7 6-9 13-1 11-5 11 9v17M26 24v20M38 24v20" fill="none" stroke="#ecf7d0" strokeWidth="5" strokeLinecap="round"/></svg>
      <div style={{fontSize:29,fontWeight:650,letterSpacing:5,color:ink}}>慢行 <span style={{fontSize:15,letterSpacing:3,marginLeft:9,fontWeight:500}}>MANXING</span></div>
    </div>
    <div style={{position:'absolute',left:116,top:153,fontSize:17,letterSpacing:2,color:'#829080'}}>体感自适应城市旅行智能体</div>
    {chapters.filter(c=>t>=c.from-.05&&t<c.to+.15).map(c=><Copy key={c.from} item={c} t={t}/>)}
    <div style={{position:'absolute',left:1132+drift,top:86+(1-reveal)*40,width:454,height:908,transform:`scale(${scale})`,transformOrigin:'center',opacity:reveal}}>
      <div style={{position:'absolute',inset:'10px -3px -20px',borderRadius:62,background:'#233a2635',filter:'blur(32px)',transform:'translateY(24px)'}}/>
      <div style={{position:'absolute',inset:0,borderRadius:55,background:'linear-gradient(120deg,#577466,#10261b 28%,#305143 69%,#0b1c14)',border:'1px solid #74867b',boxShadow:'inset 0 0 0 3px #c1d0c52b, 0 4px 12px #1c342622'}}/>
      <div style={{position:'absolute',width:4,height:63,left:-3,top:171,borderRadius:4,background:'#42614f'}}/>
      <div style={{position:'absolute',width:4,height:80,right:-3,top:245,borderRadius:4,background:'#42614f'}}/>
      <div style={{position:'absolute',left:12,top:24,width:430,height:860,borderRadius:36,overflow:'hidden',background:'#f4f6f1'}}>
        <OffthreadVideo src={staticFile('interaction.mp4')} muted style={{width:430,height:860,display:'block'}}/>
      </div>
      <div style={{position:'absolute',left:198,top:10,width:58,height:4,borderRadius:4,background:'#091a13',opacity:.9}}/>
      <div style={{position:'absolute',bottom:10,left:177,width:100,height:4,borderRadius:5,background:'#a6b7a8',opacity:.6}}/>
    </div>
    <div style={{position:'absolute',left:116,top:870,width:710}}>
      <div style={{height:1,background:'#dbe3d7',position:'relative'}}><div style={{height:2,background:green,width:`${t/45*100}%`,transform:'translateY(-.5px)'}}/></div>
      <div style={{display:'flex',justifyContent:'space-between',paddingTop:21}}>{['规划','行程','途中','手记'].map((s,i)=><div key={s} style={{display:'flex',alignItems:'center',gap:11,color:i===active?green:'#8c968b',fontSize:19,fontWeight:i===active?600:400}}><span style={{width:6,height:6,borderRadius:'50%',background:i===active?green:'#c2cbbd'}}/>{s}</div>)}</div>
    </div>
    <div style={{position:'absolute',left:116,bottom:47,color:'#859080',fontSize:16,letterSpacing:.8}}>真实界面连续操作 · 示例数据 · 手动体感反馈</div>
    <div style={{position:'absolute',right:112,bottom:47,color:'#859080',fontSize:15,letterSpacing:2,fontVariantNumeric:'tabular-nums'}}>{String(Math.min(45,Math.floor(t))).padStart(2,'0')} / 45</div>
  </AbsoluteFill>;
};
