export const pageRoutes = Object.freeze({
  plan: { path:'/plan', page:'plan', title:'规划旅程', description:'选择目的地、日期与偏好，规划你的城市旅程。' },
  trip: { path:'/trip', page:'trip', title:'我的行程', description:'查看路线地图、地点清单与每日行程。' },
  journey: { path:'/journey', page:'journey', title:'途中伴行', description:'继续漫游，查看身体状态并调整路线。' },
  report: { path:'/report', page:'report', title:'旅行手记', description:'回顾到访地点、路线调整和旅途日记。' },
  login: { path:'/login', page:'auth', authMode:'login', title:'登录', description:'登录慢行，继续你的城市旅程。' },
  register: { path:'/register', page:'auth', authMode:'register', title:'注册', description:'创建慢行账号，保存行程和旅行手记。' },
  account: { path:'/account', page:'auth', authMode:'login', title:'我的账号', description:'查看账号和已保存的行程。' },
  ops: { path:'/ops', page:'ops', title:'运营工作台', description:'查看服务连接状态和运行情况。' }
});

export function resolvePageRoute(pathname='/',hash=''){
  const legacy=hash.replace(/^#\/?/,'');
  if(Object.hasOwn(pageRoutes,legacy))return pageRoutes[legacy];
  if(legacy==='auth')return pageRoutes.login;
  const path=pathname.replace(/\/+$/,'')||'/';
  if(path==='/'||path==='/index.html')return pageRoutes.plan;
  if(path==='/auth')return pageRoutes.login;
  const entry=/^\/pages\/([a-z]+)\.html$/.exec(path);
  if(entry&&Object.hasOwn(pageRoutes,entry[1]))return pageRoutes[entry[1]];
  return Object.values(pageRoutes).find(route=>route.path===path)||null;
}
