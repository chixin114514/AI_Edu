// 底部标签栏的液态玻璃折射。
// 只有 Blink 内核（安卓 App 的 WebView、桌面端外壳、Chrome）会把 backdrop-filter 里的 SVG 滤镜
// 作用到元素背后的内容上；其它内核保持 style.css 里的普通毛玻璃，这里什么都不做。
const nav=document.querySelector('.main-nav'),image=document.querySelector('#glass-nav-map');
const refracts=/Chrome\/\d+/.test(navigator.userAgent)&&globalThis.CSS?.supports?.('backdrop-filter','url(#glass-nav)');

function roundedRect(ctx,x,y,width,height,radius){
  const r=Math.max(0,Math.min(radius,width/2,height/2));
  ctx.beginPath();ctx.moveTo(x+r,y);ctx.arcTo(x+width,y,x+width,y+height,r);ctx.arcTo(x+width,y+height,x,y+height,r);ctx.arcTo(x,y+height,x,y,r);ctx.arcTo(x,y,x+width,y,r);ctx.closePath();
}
// 位移图：R 通道管水平偏移、G 通道管垂直偏移，中性灰（0.5）表示不偏移。
// 整块先铺上从 0 到 1 的渐变，再用一块虚化的中性灰盖住中间，只留一圈边缘在折射——像一块凸起的玻璃。
// 画成位图而不是 SVG：滤镜每一帧都要用到它，位图只解码一次，矢量图每帧都得重画（里面还带一道模糊）。
function displacementMap(width,height,rim=12){
  const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
  const ctx=canvas.getContext('2d');if(!ctx)return '';
  const radius=Math.min(height/2,32);
  ctx.fillStyle='#808080';ctx.fillRect(0,0,width,height);
  const x=ctx.createLinearGradient(0,0,width,0);x.addColorStop(0,'#000');x.addColorStop(1,'#f00');
  const y=ctx.createLinearGradient(0,0,0,height);y.addColorStop(0,'#000');y.addColorStop(1,'#0f0');
  ctx.save();roundedRect(ctx,0,0,width,height,radius);ctx.clip();
  ctx.fillStyle=x;ctx.fillRect(0,0,width,height);
  ctx.globalCompositeOperation='lighter';ctx.fillStyle=y;ctx.fillRect(0,0,width,height);
  ctx.restore();
  ctx.filter=`blur(${rim/2}px)`;ctx.fillStyle='#808080';
  roundedRect(ctx,rim,rim,width-rim*2,height-rim*2,radius-rim);ctx.fill();
  return canvas.toDataURL('image/png');
}
function fit(){
  const {width,height}=nav.getBoundingClientRect();
  const w=Math.round(width),h=Math.round(height);
  if(w<40||h<40||(image.getAttribute('width')===String(w)&&image.getAttribute('height')===String(h)))return;
  const map=displacementMap(w,h);if(!map)return;
  image.setAttribute('width',w);image.setAttribute('height',h);
  image.setAttribute('href',map);
}
if(nav&&image&&refracts){
  fit();
  // 横竖屏切换、窗口尺寸变化后标签栏会变宽，位移图要跟着重画，否则折射的圆角对不上。
  if(typeof ResizeObserver==='function')new ResizeObserver(fit).observe(nav);else addEventListener('resize',fit);
  document.documentElement.classList.add('glass-refract');
}
