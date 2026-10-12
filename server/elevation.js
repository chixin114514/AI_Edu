// 海拔与坡度的纯计算部分（不发网络请求，便于单测）。
//
// 坐标约定：项目内部所有地点、路径和定位结果都是 GCJ-02（高德坐标系），
// 而公开高程数据集（SRTM）使用 WGS-84。相差最多数百米，在陡坡路段会明显
// 影响高程取样，因此查询高程前先做 GCJ-02 → WGS-84 反解。
//
// 精度声明：SRTM 90m 的水平分辨率意味着这里得到的是「路段的平均趋势」，
// 不是实测坡度。泥路、台阶、桥隧都不会体现在 90 米网格里。

const A = 6378245; // 克拉索夫斯基椭球长半轴
const EE = 0.00669342162296594323; // 第一偏心率平方

const outOfChina = (lat, lng) => lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;

function transformLat(x, y) {
  let ret = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += (20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2 / 3;
  ret += (20 * Math.sin(y * Math.PI) + 40 * Math.sin(y / 3 * Math.PI)) * 2 / 3;
  ret += (160 * Math.sin(y / 12 * Math.PI) + 320 * Math.sin(y * Math.PI / 30)) * 2 / 3;
  return ret;
}

function transformLng(x, y) {
  let ret = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += (20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2 / 3;
  ret += (20 * Math.sin(x * Math.PI) + 40 * Math.sin(x / 3 * Math.PI)) * 2 / 3;
  ret += (150 * Math.sin(x / 12 * Math.PI) + 300 * Math.sin(x / 30 * Math.PI)) * 2 / 3;
  return ret;
}

function offset(lat, lng) {
  const dLat = transformLat(lng - 105, lat - 35);
  const dLng = transformLng(lng - 105, lat - 35);
  const radLat = lat / 180 * Math.PI;
  let magic = Math.sin(radLat);
  magic = 1 - EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  return {lat: dLat * 180 / ((A * (1 - EE)) / (magic * sqrtMagic) * Math.PI), lng: dLng * 180 / (A / sqrtMagic * Math.cos(radLat) * Math.PI)};
}

// GCJ-02 → WGS-84。偏移量本身依赖结果坐标，用不动点迭代反解，4 次内收敛到厘米级。
export function gcj02ToWgs84(lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new TypeError('坐标必须是有限数值');
  if (outOfChina(lat, lng)) return {lat, lng};
  let wLat = lat, wLng = lng;
  for (let i = 0; i < 4; i++) {
    const d = offset(wLat, wLng);
    wLat = lat - d.lat;
    wLng = lng - d.lng;
  }
  return {lat: wLat, lng: wLng};
}

// 球面距离，用于按真实长度给坡段加权（近似直线距离在项目里用不到）。
export function haversineM(a, b) {
  const R = 6371008.8, rad = value => value * Math.PI / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

// 坡度分级。步行场景下 3% 基本无感，10% 以上连续上坡对体力影响明显。
export const SLOPE_LEVELS = [
  {max: 3, key: 'flat', label: '平缓'},
  {max: 6, key: 'gentle', label: '缓坡'},
  {max: 10, key: 'noticeable', label: '明显爬升'},
  {max: Infinity, key: 'steep', label: '陡坡'}
];

export function slopeLevel(gradePct) {
  const grade = Math.abs(gradePct);
  return SLOPE_LEVELS.find(level => grade < level.max) || SLOPE_LEVELS.at(-1);
}

// 把当天路线铺成高程采样点：站点用自身名称标注，两站之间的高德步行折线标注为途中。
// 采样点上限按 Open Topo Data 单次 100 点上限内取保守值，避免一次多请求。
export function routePoints(stops, {max = 48} = {}) {
  const raw = [];
  const push = (lat, lng, label) => {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
    const last = raw.at(-1);
    if (last && Math.abs(last.lat - lat) < 1e-6 && Math.abs(last.lng - lng) < 1e-6) { if (label) last.label = label; return; }
    raw.push({lat, lng, label: label || null});
  };
  for (const stop of Array.isArray(stops) ? stops : []) {
    for (const point of stop?.leg?.polyline || []) push(Number(point[1]), Number(point[0]), null);
    push(Number(stop?.lat), Number(stop?.lng), typeof stop?.name === 'string' ? stop.name : null);
  }
  if (raw.length <= max) return raw;
  // 等间隔抽样，首尾必留，避免整条路线的爬升被截掉。
  const step = (raw.length - 1) / (max - 1), out = [];
  for (let i = 0; i < max; i++) {
    const point = raw[Math.round(i * step)];
    if (point !== out.at(-1)) out.push(point);
  }
  return out;
}

// 每个采样点向前 / 向后找最近的有名点，让坡段能报出「某站到某站之间」。
function labelsFor(points) {
  const labels = [], total = points.length;
  let last = null;
  for (let i = 0; i < total; i++) { if (points[i].label) last = points[i].label; labels.push(last); }
  last = null;
  for (let i = total - 1; i >= 0; i--) {
    if (points[i].label) last = points[i].label;
    if (!labels[i]) labels[i] = last;
  }
  return labels;
}

// 逐段计算距离、爬升和坡度。高程为 null（海上或数据缺口）的段直接跳过，
// 不插值、不按 0 米处理，否则会凭空造出几十米的假爬升。
export function buildElevationProfile(points, elevations) {
  const samples = points.map((point, index) => ({
    lat: point.lat, lng: point.lng, label: point.label || null,
    elevation: Number.isFinite(elevations?.[index]) ? elevations[index] : null
  }));
  const names = labelsFor(points), segments = [];
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1], b = samples[i];
    if (a.elevation === null || b.elevation === null) continue;
    const distance = haversineM(a, b);
    if (distance < 1) continue;
    const rise = b.elevation - a.elevation;
    const grade = rise / distance * 100;
    segments.push({
      from: a, to: b, from_label: names[i - 1], to_label: names[i],
      distance_m: Math.round(distance), rise_m: Math.round(rise * 10) / 10,
      grade_pct: Math.round(grade * 10) / 10, level: slopeLevel(grade).key, level_label: slopeLevel(grade).label
    });
  }
  const graded = segments.map(segment => segment.grade_pct);
  const up = graded.filter(value => value > 0), down = graded.filter(value => value < 0);
  const measured = samples.filter(sample => sample.elevation !== null).map(sample => sample.elevation);
  const gain = segments.reduce((total, segment) => total + Math.max(0, segment.rise_m), 0);
  const loss = segments.reduce((total, segment) => total + Math.max(0, -segment.rise_m), 0);
  return {
    samples, segments,
    summary: {
      point_count: samples.length,
      measured_count: measured.length,
      length_m: segments.reduce((total, segment) => total + segment.distance_m, 0),
      gain_m: Math.round(gain), loss_m: Math.round(loss),
      min_m: measured.length ? Math.round(Math.min(...measured)) : null,
      max_m: measured.length ? Math.round(Math.max(...measured)) : null,
      max_up_grade_pct: up.length ? Math.max(...up) : null,
      max_down_grade_pct: down.length ? Math.min(...down) : null,
      steep_count: segments.filter(segment => segment.level === 'steep').length,
      missing_count: samples.length - measured.length
    }
  };
}
