// Amap Web Service coordinates and static basemap both use GCJ-02.
export const MAP_WIDTH=640,MAP_HEIGHT=480;
export function validPoint(p){return Array.isArray(p)&&p.length===2&&p.every(Number.isFinite)&&Math.abs(p[0])<=180&&Math.abs(p[1])<=85;}
export function project([lng,lat]){const sine=Math.sin(Math.max(-85,Math.min(85,lat))*Math.PI/180);return [(lng+180)/360,(1-Math.log((1+sine)/(1-sine))/(2*Math.PI))/2];}
export function unproject([x,y]){return [x*360-180,Math.atan(Math.sinh(Math.PI*(1-2*y)))*180/Math.PI];}
export function routePaths(stops){return stops.filter(p=>p.leg?.mode==='live').map(p=>(p.leg.polyline||[]).filter(validPoint)).filter(p=>p.length>=2);}
export function mapViewport(stops,{zoom,focus,center:requestedCenter}={}){
 const points=[...stops.map(p=>[p.lng,p.lat]).filter(validPoint),...routePaths(stops).flat()];
 if(!points.length)throw Error('NO_MAP_POINTS');
 const projected=points.map(project),xs=projected.map(p=>p[0]),ys=projected.map(p=>p[1]);
 const minX=Math.min(...xs),maxX=Math.max(...xs),minY=Math.min(...ys),maxY=Math.max(...ys);
 const fit=Math.max(3,Math.min(17,Math.floor(Math.log2(Math.min((MAP_WIDTH-100)/(256*Math.max(maxX-minX,1e-8)),(MAP_HEIGHT-100)/(256*Math.max(maxY-minY,1e-8)))))));
 const focused=Number.isInteger(focus)?stops[focus]:null;
 const center=validPoint(requestedCenter)?requestedCenter:focused?[focused.lng,focused.lat]:unproject([(minX+maxX)/2,(minY+maxY)/2]);
 return {center:center.map(n=>Number(n.toFixed(6))),zoom:zoom??(focused?16:fit),width:MAP_WIDTH,height:MAP_HEIGHT};
}
export function mapPixel(point,view){const p=project(point),c=project(view.center),scale=256*2**view.zoom;return [(p[0]-c[0])*scale+view.width/2,(p[1]-c[1])*scale+view.height/2];}
// Drag distances are in basemap pixels, independent of the displayed CSS size.
export function panMapCenter(view,dx,dy){
 const [x,y]=project(view.center),scale=256*2**view.zoom;
 const [lng,lat]=unproject([x-dx/scale,Math.max(0,Math.min(1,y-dy/scale))]);
 return [Math.max(-180,Math.min(180,lng)),Math.max(-85,Math.min(85,lat))];
}
