import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gcj02ToWgs84, haversineM, slopeLevel, routePoints, buildElevationProfile } from '../server/elevation.js';
import { createApp } from '../server/index.js';
import { dispatch } from './harness.js';

test('GCJ-02 反解回 WGS-84，境内外分别处理', () => {
  // 杭州湖滨：GCJ-02 相对 WGS-84 大约偏西偏南几百米，反解后经度应变小、纬度应略变。
  const wgs = gcj02ToWgs84(30.2590, 120.1503);
  assert.ok(wgs.lng < 120.1503, '反解后经度应更小');
  assert.ok(Math.abs(wgs.lat - 30.2590) < 0.01);
  const metres = haversineM({ lat: wgs.lat, lng: wgs.lng }, { lat: 30.2590, lng: 120.1503 });
  assert.ok(metres > 100 && metres < 900, `偏移量应在数百米量级，实际 ${metres}`);
  // 境外没有偏移。
  const outside = gcj02ToWgs84(48.8584, 2.2945);
  assert.deepEqual(outside, { lat: 48.8584, lng: 2.2945 });
  // 非法输入不静默通过。
  assert.throws(() => gcj02ToWgs84(NaN, 120));
  assert.throws(() => gcj02ToWgs84('30', 120));
});

test('球面距离与坡度分级', () => {
  // 沿同一纬度 0.001 度约 96 米（30°N）。
  const d = haversineM({ lat: 30, lng: 120 }, { lat: 30, lng: 120.001 });
  assert.ok(d > 95 && d < 98, `实际 ${d}`);
  assert.equal(slopeLevel(0).key, 'flat');
  assert.equal(slopeLevel(2.9).key, 'flat');
  assert.equal(slopeLevel(3).key, 'gentle');
  assert.equal(slopeLevel(-6).key, 'noticeable');
  assert.equal(slopeLevel(25).key, 'steep');
});

test('路线采样点合并步行折线与站点，并等间隔压缩', () => {
  const stops = [
    { name: '甲', lat: 30.0, lng: 120.0, leg: { polyline: [] } },
    { name: '乙', lat: 30.002, lng: 120.002, leg: { polyline: [[120.001, 30.001], [120.0015, 30.0015]] } },
    { name: '丙', lat: 30.004, lng: 120.004, leg: { polyline: [] } }
  ];
  const points = routePoints(stops);
  assert.equal(points.length, 5, '3 个站点 + 2 个折线点');
  assert.equal(points.at(-1).label, '丙');
  assert.equal(points.filter(p => p.label).length, 3);
  // 重复点只保留一个，且后到的名称会补上标签。
  assert.equal(routePoints([{ name: '同点', lat: 30, lng: 120, leg: { polyline: [[120, 30]] } }]).length, 1);
  // 超过上限时首尾必须保留。
  const many = Array.from({ length: 200 }, (_, i) => ({ name: `点${i}`, lat: 30 + i / 1000, lng: 120, leg: { polyline: [] } }));
  const sampled = routePoints(many, { max: 48 });
  assert.equal(sampled.length, 48);
  assert.equal(sampled[0].label, '点0');
  assert.equal(sampled.at(-1).label, '点199');
});

test('坡段只统计有高程的相邻点，缺口不按 0 米补齐', () => {
  const points = [
    { lat: 30.0, lng: 120.0, label: '起点' },
    { lat: 30.001, lng: 120.0, label: null },
    { lat: 30.002, lng: 120.0, label: '中途' },
    { lat: 30.003, lng: 120.0, label: '终点' }
  ];
  const profile = buildElevationProfile(points, [10, 20, null, 5]);
  assert.equal(profile.samples.length, 4);
  assert.equal(profile.samples[2].elevation, null);
  // 缺口两侧的两段都无法测量，因此只剩第一段，不能跨缺口凭空连出一条坡。
  assert.equal(profile.segments.length, 1);
  assert.equal(profile.segments[0].rise_m, 10);
  assert.equal(profile.segments[0].level, 'noticeable', '111 米内爬升 10 米约 9%，属于明显爬升');
  assert.equal(profile.summary.gain_m, 10);
  assert.equal(profile.summary.loss_m, 0);
  assert.equal(profile.summary.min_m, 5);
  assert.equal(profile.summary.max_m, 20);
  assert.equal(profile.summary.missing_count, 1);
  // 无名点向前继承最近的有名点，便于报出「某站到某站之间」。
  assert.equal(profile.segments[0].to_label, '起点');
  // 负海拔是有效数据（吐鲁番盆地），不能被当成缺数据。
  const below = buildElevationProfile([{ lat: 30, lng: 120 }, { lat: 30.001, lng: 120 }], [-154, -150]);
  assert.equal(below.summary.min_m, -154);
  assert.equal(below.summary.gain_m, 4);
});

function topoSetup(t, handler) {
  const oldFetch = globalThis.fetch, oldEnv = { ...process.env };
  Object.assign(process.env, { OPEN_TOPO_API_BASE: 'https://topo.test', OPEN_TOPO_MIN_INTERVAL_MS: '0' });
  globalThis.fetch = handler;
  t.after(() => { globalThis.fetch = oldFetch; for (const key of Object.keys(process.env)) if (!(key in oldEnv)) delete process.env[key]; Object.assign(process.env, oldEnv); });
  const app = createApp({ database: ':memory:' });
  t.after(() => app.emit('close'));
  let cookie = '';
  return async (path, data) => { const r = await dispatch(app, '/api' + path, data, { cookie }); cookie = r.headers['set-cookie']?.split(';')[0] || cookie; return r; };
}

test('按行程查询高程：走 WGS-84 查询、返回爬升与坡段', async t => {
  const calls = [];
  const request = topoSetup(t, async (url, init) => {
    const u = new URL(url);
    assert.equal(u.origin, 'https://topo.test');
    assert.equal(u.pathname, '/v1/srtm90m');
    const locations = u.searchParams.get('locations').split('|');
    calls.push(locations);
    return new Response(JSON.stringify({ status: 'OK', results: locations.map((_, i) => ({ elevation: 10 + i * 10, location: {} })) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  const trip = (await request('/trip/plan', { city: '杭州', date: '2026-10-20', days: 1, budget: 300, walk_limit_km: 6, interests: ['自然', '人文'], start_time: '09:00', end_time: '18:00', companion: '独自', model_consent: false })).body;
  const stops = trip.days[0].stops;
  const r = await request('/elevation', { trip_id: trip.id, day: 1 });
  assert.equal(r.status, 200);
  // 查询用的是 WGS-84，不是行程里的 GCJ-02 坐标。
  assert.equal(calls[0].length, stops.length);
  const first = calls[0][0].split(',').map(Number);
  const expected = gcj02ToWgs84(stops[0].lat, stops[0].lng);
  assert.ok(Math.abs(first[0] - expected.lat) < 1e-4 && Math.abs(first[1] - expected.lng) < 1e-4, '首个点应为反解后的 WGS-84 坐标');
  assert.ok(haversineM({ lat: first[0], lng: first[1] }, { lat: stops[0].lat, lng: stops[0].lng }) > 100, '不能直接把 GCJ-02 发出去');
  assert.equal(r.body.summary.gain_m, 10 * (stops.length - 1));
  assert.equal(r.body.summary.loss_m, 0);
  assert.equal(r.body.summary.min_m, 10);
  assert.equal(r.body.summary.max_m, 10 * (stops.length - 1) + 10);
  assert.equal(r.body.dataset, 'srtm90m');
  assert.match(r.body.accuracy_note, /不是实测坡度/);
  assert.match(r.body.coordinate_note, /WGS-84/);
  assert.match(r.body.context, /第 1 天/);
  assert.equal(r.body.segments.length, stops.length - 1);
});

test('按坐标查询高程：单点、上限与非法输入', async t => {
  const request = topoSetup(t, async url => {
    const locations = new URL(url).searchParams.get('locations').split('|');
    return new Response(JSON.stringify({ status: 'OK', results: locations.map(() => ({ elevation: 13 })) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  const single = await request('/elevation', { points: [{ name: '当前位置', lat: 30.259, lng: 120.1503 }] });
  assert.equal(single.status, 200);
  assert.equal(single.body.samples.length, 1);
  assert.equal(single.body.samples[0].elevation, 13);
  assert.equal(single.body.segments.length, 0);
  assert.equal(single.body.summary.gain_m, 0);
  assert.equal((await request('/elevation', { points: [] })).status, 400);
  assert.equal((await request('/elevation', { points: Array.from({ length: 49 }, () => ({ lat: 30, lng: 120 })) })).status, 400);
  const bad = await request('/elevation', { points: [{ name: '越界', lat: 999, lng: 0 }] });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /坐标无效/);
});

test('高程服务异常与非法行程给出可读错误，不伪造海拔', async t => {
  const request = topoSetup(t, async () => new Response(JSON.stringify({ status: 'INVALID_REQUEST' }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  const failed = await request('/elevation', { points: [{ lat: 30, lng: 120 }] });
  assert.equal(failed.status, 503);
  assert.match(failed.body.error, /高程服务/);

  const offline = topoSetup(t, async () => { throw new TypeError('offline'); });
  const trip = (await offline('/trip/plan', { city: '杭州', date: '2026-10-20', days: 1, budget: 300, walk_limit_km: 6, interests: ['自然'], start_time: '09:00', end_time: '18:00', companion: '独自', model_consent: false })).body;
  assert.equal((await offline('/elevation', { trip_id: trip.id, day: 9 })).status, 400);
  assert.equal((await offline('/elevation', { trip_id: 'not-mine', day: 1 })).status, 404);
  const outage = await offline('/elevation', { points: [{ lat: 30, lng: 120 }] });
  assert.equal(outage.status, 503);
  assert.ok(!JSON.stringify(outage.body).includes('secret'));
});

test('高程缺口按 null 返回，不参与爬升统计', async t => {
  const request = topoSetup(t, async url => {
    const locations = new URL(url).searchParams.get('locations').split('|');
    return new Response(JSON.stringify({ status: 'OK', results: locations.map((_, i) => ({ elevation: i === 1 ? null : 20 })) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  const r = await request('/elevation', { points: [{ lat: 30, lng: 120 }, { lat: 30.001, lng: 120 }, { lat: 30.002, lng: 120 }] });
  assert.equal(r.status, 200);
  assert.equal(r.body.samples[1].elevation, null);
  assert.equal(r.body.summary.missing_count, 1);
  assert.equal(r.body.segments.length, 0, '两端都缺数据时没有可用坡段');
  assert.equal(r.body.summary.gain_m, 0);
  assert.equal(r.body.summary.min_m, 20);
});
