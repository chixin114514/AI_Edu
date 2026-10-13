import React from 'react';
import {AbsoluteFill, OffthreadVideo, Sequence, staticFile, interpolate, Easing, useCurrentFrame, useVideoConfig} from 'remotion';
import {cameraAt} from './camera';

export type Chapter={开始秒:number;结束秒:number;标签:string;标题上行:string;标题下行:string;说明:string};
export type FilmProps={品牌:string;英文名:string;主题色:string;镜头幅度:number;显示操作提示:boolean;显示底部说明:boolean;副标题:string;章节:Chapter[]};
export const INTRO_SECONDS=2.4;
const ink='#163b2c',muted='#758377';
const clamp={extrapolateLeft:'clamp',extrapolateRight:'clamp'} as const;
const ease=Easing.bezier(.22,1,.36,1);
const tween=(t:number,a:number,b:number,x=0,y=1)=>interpolate(t,[a,b],[x,y],{...clamp,easing:ease});

function Mark({size,color,draw=1}:{size:number;color:string;draw?:number}) {
  return <svg width={size} height={size} viewBox="0 0 64 64"><rect width="64" height="64" rx="18" fill={color}/><path d="M14 44V26q0-15 12-7 6-9 13-1 11-5 11 9v17M26 24v20M38 24v20" fill="none" stroke="#ecf7d0" strokeWidth="5" strokeLinecap="round" pathLength="1" strokeDasharray="1" strokeDashoffset={1-draw}/></svg>;
}

function Opening({t,brand,english,color}:{t:number;brand:string;english:string;color:string}) {
  const move=tween(t,1.65,2.65);
  const ring=tween(t,0,.9);
  const ringOut=1-tween(t,1.25,1.9);
  const logoSize=172-122*move;
  return <>
    <AbsoluteFill style={{background:color,opacity:1-tween(t,1.45,2.35),pointerEvents:'none'}}/>
    <div style={{position:'absolute',left:960,top:465,width:500,height:500,border:'1.5px solid #d8eea8',borderRadius:'50%',opacity:ringOut*.65,transform:`translate(-50%,-50%) scale(${.6+ring*.7})`}}/>
    <div style={{position:'absolute',left:960,top:465,width:650,height:650,border:'1px solid #d8eea8',borderRadius:'50%',opacity:ringOut*.22,transform:`translate(-50%,-50%) scale(${.65+ring*.5})`}}/>
    <div style={{position:'absolute',left:874+(112-874)*move,top:379+(77-379)*move,transform:`scale(${.82+.18*tween(t,.12,.85)})`,opacity:tween(t,0,.25),filter:`drop-shadow(0 ${18*(1-move)}px ${35*(1-move)}px #102f2430)`}}>
      <Mark size={logoSize} color={color} draw={tween(t,.15,1.1)}/>
    </div>
    <div style={{position:'absolute',left:0,right:0,top:590,textAlign:'center',color:'#f4f8ed',opacity:tween(t,.6,1.1)*(1-tween(t,1.45,1.85)),transform:`translateY(${18*(1-tween(t,.6,1.1))}px)`}}>
      <div style={{fontSize:44,fontWeight:600,letterSpacing:16,paddingLeft:16}}>{brand}</div>
      <div style={{fontSize:17,letterSpacing:7,marginTop:20,paddingLeft:7}}>{english}</div>
    </div>
    <div style={{position:'absolute',left:179,top:84,opacity:tween(t,2.1,2.75),color:ink,fontSize:29,fontWeight:650,letterSpacing:5}}>{brand}<span style={{fontSize:15,letterSpacing:3,marginLeft:17,fontWeight:500}}>{english}</span></div>
  </>;
}

function Copy({item,t,color}:{item:Chapter;t:number;color:string}) {
  const exit=item.结束秒>=42.6?1:1-tween(t,item.结束秒-.3,item.结束秒);
  const local=t-item.开始秒;
  return <div style={{position:'absolute',left:116,top:296,width:770,opacity:exit}}>
    <div style={{overflow:'hidden',marginBottom:33}}><div style={{display:'inline-block',padding:'10px 17px',background:color,color:'#f8f9f1',fontSize:18,fontWeight:600,letterSpacing:2,transform:`translateY(${(1-tween(local,0,.55))*60}px)`}}>{item.标签}</div></div>
    {[item.标题上行,item.标题下行].map((line,i)=><div key={i} style={{overflow:'hidden',height:102}}><div style={{fontSize:73,fontWeight:650,lineHeight:'102px',letterSpacing:-2.7,color:i?color:ink,transform:`translateY(${(1-tween(local,.07+i*.09,.76+i*.09))*108}px)`}}>{line}</div></div>)}
    <div style={{marginTop:29,borderLeft:`3px solid ${color}`,paddingLeft:23,opacity:tween(local,.3,.9),transform:`translateY(${(1-tween(local,.3,.9))*14}px)`,fontSize:25,lineHeight:1.85,color:muted,whiteSpace:'pre-line'}}>{item.说明}</div>
  </div>;
}

const hints=[
  {from:1.2,to:4.8,text:'选择兴趣 · 生成行程'},
  {from:7.5,to:11.5,text:'点开详情，了解下一站'},
  {from:12,to:15.5,text:'确认后，开始漫游'},
  {from:16,to:18.5,text:'轻点「有点累」'},
  {from:18.5,to:21.6,text:'查看建议 · 保留原路线'},
  {from:23,to:27,text:'查看变化 · 接受调整'},
  {from:29,to:33.6,text:'写下感受 · 保存日记'},
  {from:35,to:38.8,text:'完成打卡 · 结束漫游'},
  {from:40,to:42.6,text:'回看这一路的记录'},
];

export const ManxingFilm:React.FC<FilmProps>=(props)=>{
  const {fps}=useVideoConfig();
  const now=useCurrentFrame()/fps,t=now-INTRO_SECONDS;
  const color=props.主题色;
  const reveal=tween(t,0,.85);
  const camera=cameraAt(t,props.镜头幅度);
  const active=t<5.8?0:t<14.7?1:t<28.8?2:3;
  const phase=tween(t,13.4,15.2)-tween(t,27.8,29.6);
  const hint=hints.find(h=>t>=h.from&&t<h.to);
  return <AbsoluteFill style={{background:'#f6f6f0',fontFamily:'"PingFang SC", "Arial Unicode MS", sans-serif',overflow:'hidden'}}>
    <AbsoluteFill style={{background:'radial-gradient(ellipse at 78% 44%, #dfead7 0%, #edf2e7 32%, #f6f6f0 70%)'}}/>
    <div style={{position:'absolute',left:1130-phase*140,top:-150,width:1080,height:1480,borderRadius:200,background:color,opacity:.055+phase*.075,transform:`rotate(${-13+phase*8}deg)`}}/>
    <div style={{position:'absolute',left:935,top:70,width:1020,height:1020,border:'1px solid #cddcc5',borderRadius:'50%',opacity:.6,transform:`scale(${1+phase*.15})`}}/>
    <div style={{position:'absolute',left:116,top:153,fontSize:17,letterSpacing:2,color:'#829080',opacity:reveal}}>{props.副标题}</div>
    {props.章节.filter(c=>t>=c.开始秒&&t<c.结束秒).map((c,i)=><Copy key={i} item={c} t={t} color={color}/>)}
    {props.显示操作提示&&hint&&<div style={{position:'absolute',left:116,top:748,display:'flex',gap:13,alignItems:'center',fontSize:19,color,opacity:tween(t,hint.from,hint.from+.3)*(1-tween(t,hint.to-.2,hint.to)),transform:`translateX(${(1-tween(t,hint.from,hint.from+.4))*-14}px)`}}><span style={{display:'inline-flex',width:25,height:25,border:`1px solid ${color}`,borderRadius:50,alignItems:'center',justifyContent:'center',fontSize:15}}>↗</span>{hint.text}</div>}
    {/* One persistent recording, shifted only by the logo opening; no chapter remounts. */}
    <div style={{position:'absolute',left:camera.x-227*camera.scale,top:camera.screenY-(24+camera.focusY)*camera.scale+(1-reveal)*75,width:454,height:908,transform:`scale(${camera.scale})`,transformOrigin:'top left',opacity:reveal}}>
      <div style={{position:'absolute',inset:'10px -3px -20px',borderRadius:62,background:'#233a262f',filter:'blur(27px)',transform:'translateY(22px)'}}/>
      <div style={{position:'absolute',inset:0,borderRadius:55,background:'linear-gradient(120deg,#577466,#10261b 28%,#305143 69%,#0b1c14)',border:'1px solid #74867b',boxShadow:'inset 0 0 0 3px #c1d0c52b, 0 4px 12px #1c342622'}}/>
      <div style={{position:'absolute',width:4,height:63,left:-3,top:171,borderRadius:4,background:'#42614f'}}/>
      <div style={{position:'absolute',width:4,height:80,right:-3,top:245,borderRadius:4,background:'#42614f'}}/>
      <div style={{position:'absolute',left:12,top:24,width:430,height:860,borderRadius:36,overflow:'hidden',background:'#f4f6f1'}}>
        <Sequence from={Math.round(INTRO_SECONDS*fps)} layout="none" name="连续操作录屏"><OffthreadVideo src={staticFile('interaction.mp4')} muted style={{width:430,height:860,display:'block'}}/></Sequence>
      </div>
      <div style={{position:'absolute',left:198,top:10,width:58,height:4,borderRadius:4,background:'#091a13'}}/>
      <div style={{position:'absolute',bottom:10,left:177,width:100,height:4,borderRadius:5,background:'#a6b7a8',opacity:.6}}/>
    </div>
    <div style={{position:'absolute',left:116,top:881,width:710,opacity:reveal}}>
      <div style={{height:1,background:'#dbe3d7'}}><div style={{height:2,background:color,width:`${Math.max(0,t)/42.6*100}%`}}/></div>
      <div style={{display:'flex',justifyContent:'space-between',paddingTop:21}}>{['规划','行程','途中','手记'].map((s,i)=><div key={s} style={{display:'flex',alignItems:'center',gap:11,color:i===active?color:'#8c968b',fontSize:19,fontWeight:i===active?600:400}}><span style={{width:6,height:6,borderRadius:'50%',background:i===active?color:'#c2cbbd'}}/>{s}</div>)}</div>
    </div>
    {props.显示底部说明&&<div style={{position:'absolute',left:116,bottom:47,color:'#859080',fontSize:16,letterSpacing:.8,opacity:reveal}}>真实界面连续操作 · 示例数据 · 手动体感反馈</div>}
    <Opening t={now} brand={props.品牌} english={props.英文名} color={color}/>
  </AbsoluteFill>;
};
