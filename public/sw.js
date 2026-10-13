const CACHE='manxing-shell-v35';
const PAGES=['/','/index.html','/plan','/trip','/journey','/report','/login','/register','/account','/ops'];
const FILES=[...PAGES,'/page-routes.js','/app.js','/route-map.js','/map-geometry.js','/stop-reasons.js','/sensors.js','/watch-link.js','/style.css','/lake.svg','/favicon.svg','/manifest.json','/icons/icon-192.png','/icons/icon-512.png','/icons/icon-maskable-512.png','/icons/apple-touch-icon.png'];
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(FILES))));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('manxing-shell-')&&k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',event=>{
  const url=new URL(event.request.url);
  const normalized=url.pathname.replace(/\/+$/,'')||'/',page=PAGES.includes(normalized);
  if(event.request.method!=='GET'||url.origin!==location.origin||!FILES.includes(page?normalized:url.pathname))return;
  event.respondWith(fetch(event.request).then(response=>{
    if(response.ok){const clone=response.clone();event.waitUntil(caches.open(CACHE).then(c=>c.put(event.request,clone)));}
    return response;
  }).catch(async()=>await caches.match(page?normalized:event.request,{ignoreSearch:page})||Response.error()));
});
