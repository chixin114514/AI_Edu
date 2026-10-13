// 底部标签栏的液态玻璃折射。
// 只有 Blink 内核（安卓 App 的 WebView、桌面端外壳、Chrome）会把 backdrop-filter 里的 SVG 滤镜
// 作用到元素背后的内容上；其它内核保持 style.css 里的普通毛玻璃，这里什么都不做。
const nav=document.querySelector('.main-nav'),image=document.querySelector('#glass-nav-map');
const refracts=/Chrome\/\d+/.test(navigator.userAgent)&&globalThis.CSS?.supports?.('backdrop-filter','url(#glass-nav)');

// 位移图：R 通道管水平偏移、G 通道管垂直偏移，0.5 表示不偏移。
// 整块先铺上从 0 到 1 的渐变，再用一块虚化的中性灰盖住中间，只留一圈边缘在折射——像一块凸起的玻璃。
function displacementMap(width,height,rim=14){
  const radius=Math.min(height/2,32),inner=Math.max(0,radius-rim);
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`
    +'<defs><linearGradient id="x"><stop offset="0" stop-color="#000"/><stop offset="1" stop-color="#f00"/></linearGradient>'
    +'<linearGradient id="y" x2="0" y2="1"><stop offset="0" stop-color="#000"/><stop offset="1" stop-color="#0f0"/></linearGradient>'
    +`<filter id="b" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="${rim/2}"/></filter></defs>`
    +`<rect width="${width}" height="${height}" fill="#808080"/>`
    +`<rect width="${width}" height="${height}" rx="${radius}" fill="url(#x)"/>`
    +`<rect width="${width}" height="${height}" rx="${radius}" fill="url(#y)" style="mix-blend-mode:screen"/>`
    +`<rect x="${rim}" y="${rim}" width="${Math.max(0,width-rim*2)}" height="${Math.max(0,height-rim*2)}" rx="${inner}" fill="#808080" filter="url(#b)"/></svg>`;
  return 'data:image/svg+xml,'+encodeURIComponent(svg);
}
function fit(){
  const {width,height}=nav.getBoundingClientRect();
  if(!width||!height)return;
  const w=Math.round(width),h=Math.round(height);
  if(image.getAttribute('width')===String(w)&&image.getAttribute('height')===String(h))return;
  image.setAttribute('width',w);image.setAttribute('height',h);
  image.setAttribute('href',displacementMap(w,h));
}
if(nav&&image&&refracts){
  fit();
  // 横竖屏切换、窗口尺寸变化后标签栏会变宽，位移图要跟着重画，否则折射的圆角对不上。
  if(typeof ResizeObserver==='function')new ResizeObserver(fit).observe(nav);else addEventListener('resize',fit);
  document.documentElement.classList.add('glass-refract');
}
