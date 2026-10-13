import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/index.js';
import { dispatch } from './harness.js';

const PLAN = { city: '杭州', date: '2026-10-20', days: 1, budget: 300, walk_limit_km: 6, interests: ['自然', '人文'], start_time: '09:00', end_time: '18:00', companion: '独自', model_consent: false };
// 演示模式（本地样本 POI），不需要任何外部服务就能验证重排逻辑。
const plan = (t, overrides = {}) => {
  const app = createApp({ database: ':memory:' });
  t.after(() => app.emit('close'));
  let cookie = '';
  const request = async (path, data) => {
    const r = await dispatch(app, '/api' + path, data, { cookie });
    cookie = r.headers['set-cookie']?.split(';')[0] || cookie;
    return r;
  };
  return request('/trip/plan', { ...PLAN, ...overrides }).then(trip => ({ request, trip: trip.body }));
};
const ids = day => day.stops.filter(stop => stop.id !== 'destination').map(stop => stop.id);
const payload = list => list.map(id => ({ id }));

test('手动重排：顺序就是用户给的顺序，且不静默丢站', async t => {
  const { request, trip } = await plan(t);
  const before = trip.days[0];
  assert.ok(before.stops.length >= 3);
  const reversed = [...ids(before)].reverse();
  const edited = await request(`/trip/${trip.id}/stops`, { day: 1, stops: payload(reversed) });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.trip.version, trip.version + 1, '编辑会提升版本号，让未确认的建议自动过期');
  assert.deepEqual(ids(edited.body.trip.days[0]), reversed);
  assert.ok(Array.isArray(edited.body.warnings));
  // 每段的步行与到达时间都按新顺序重算过。
  for (const stop of edited.body.trip.days[0].stops) {
    assert.ok(stop.arrival && stop.departure && stop.leg, `${stop.name} 应该有重算后的时间与接驳`);
    assert.equal(stop.leg.source, stop === edited.body.trip.days[0].stops[0] ? '起点' : '演示估算 · 非导航数据');
  }
  const saved = (await request('/trip/' + trip.id)).body;
  assert.deepEqual(ids(saved.days[0]), reversed, '重排结果要落库');
});

test('超约束时全部保留并给出警告，而不是把用户排的站删掉', async t => {
  const { request, trip } = await plan(t, { end_time: '12:00' });
  // 把 6 个候选塞进 3 小时的窗口，自动规划一定会丢掉一部分。
  const wanted = ids(trip.days[0]).concat(['rest-gushan', 'lunch-hubin']).filter((id, i, all) => all.indexOf(id) === i).slice(0, 6);
  assert.ok(wanted.length >= 4);
  const edited = await request(`/trip/${trip.id}/stops`, { day: 1, stops: payload(wanted) });
  assert.equal(edited.status, 200);
  assert.deepEqual(ids(edited.body.trip.days[0]), wanted, '一个都不能少');
  assert.ok(edited.body.warnings.some(text => /晚于|超过|超出/.test(text)), '超出约束要有可读的警告');
});

test('新增、删除与重复校验', async t => {
  const { request, trip } = await plan(t);
  const original = ids(trip.days[0]);
  const added = await request(`/trip/${trip.id}/stops`, { day: 1, stops: [...payload(original), { name: '我自己找的咖啡馆', lat: 30.2512, lng: 120.1498, category: '美食' }] });
  assert.equal(added.status, 200);
  const custom = added.body.trip.days[0].stops.at(-1);
  assert.equal(custom.name, '我自己找的咖啡馆');
  assert.equal(custom.category, '美食');
  assert.equal(custom.price, null, '用户新增的地点没有已知票价');
  assert.equal(custom.rating, null);
  assert.equal(custom.per_capita_cost, null);
  assert.match(custom.reservation, /自行核实/);
  assert.match(custom.id, /^custom-/);
  // 客户端不能借编辑接口把票价塞进来。
  const forged = await request(`/trip/${trip.id}/stops`, { day: 1, stops: [...payload(original), { name: '伪造票价', lat: 30.25, lng: 120.15, price: 999, rating: 5, per_capita_cost: 1 }] });
  const forgedStop = forged.body.trip.days[0].stops.at(-1);
  assert.equal(forgedStop.price, null);
  assert.equal(forgedStop.rating, null);
  assert.equal(forgedStop.per_capita_cost, null);
  // 未知 id、重复、数量越界、坐标非法都要拒绝。
  assert.equal((await request(`/trip/${trip.id}/stops`, { day: 1, stops: payload(['nope-1', 'nope-2']) })).status, 400);
  assert.equal((await request(`/trip/${trip.id}/stops`, { day: 1, stops: payload([original[0], original[0]]) })).status, 400);
  assert.equal((await request(`/trip/${trip.id}/stops`, { day: 1, stops: payload([original[0]]) })).status, 400, '每天至少保留两个地点');
  const nine = Array.from({ length: 9 }, (_, i) => ({ name: `点${i}`, lat: 30 + i / 1000, lng: 120 }));
  const tooMany = await request(`/trip/${trip.id}/stops`, { day: 1, stops: nine });
  assert.equal(tooMany.status, 400);
  assert.match(tooMany.body.error, /2—8/);
  assert.equal((await request(`/trip/${trip.id}/stops`, { day: 1, stops: payload([original[0], { name: '越界', lat: 999, lng: 0 }]) })).status, 400);
  assert.equal((await request(`/trip/${trip.id}/stops`, { day: 9, stops: payload(original) })).status, 400);
  // 真的删掉一个：剩下的仍然可用。
  const removed = await request(`/trip/${trip.id}/stops`, { day: 1, stops: payload(original.slice(1)) });
  assert.equal(removed.status, 200);
  assert.deepEqual(ids(removed.body.trip.days[0]), original.slice(1));
});

test('自己加的地点再次编辑时保留原 id，日记不会因此断键', async t => {
  const { request, trip } = await plan(t);
  const original = ids(trip.days[0]);
  const added = await request(`/trip/${trip.id}/stops`, { day: 1, stops: [...payload(original), { name: '我加的咖啡馆', lat: 30.2512, lng: 120.1498, category: '美食' }] });
  const custom = added.body.trip.days[0].stops.at(-1);
  await request('/journal', { trip_id: trip.id, day: 1, stop_id: custom.id, text: '在这里坐了半小时。' });
  // 把这一站挪到最前：前端此时只回传 id。
  const reordered = await request(`/trip/${trip.id}/stops`, { day: 1, stops: [{ id: custom.id }, ...payload(original)] });
  assert.equal(reordered.status, 200);
  const moved = reordered.body.trip.days[0].stops[0];
  assert.equal(moved.name, '我加的咖啡馆');
  assert.equal(moved.id, custom.id, '自定义地点不能每次编辑都换一个 id');
  // 回传完整对象也一样：以行程里的 id 为准，不会又新建一个。
  const again = await request(`/trip/${trip.id}/stops`, { day: 1, stops: [{ ...moved, name: '改了名字也不该换 id' }, ...payload(original)] });
  assert.equal(again.body.trip.days[0].stops[0].id, custom.id);
  assert.equal(again.body.trip.days[0].stops.filter(stop => stop.name === '我加的咖啡馆').length, 1);
  const journal = await request(`/trip/${trip.id}/journal`);
  assert.equal(journal.body.entries[0].stop_id, custom.id);
  assert.equal(journal.body.entries[0].text, '在这里坐了半小时。');
});

test('漫游进行中不能改顺序；终点始终留在最后', async t => {
  const { request, trip } = await plan(t, { end_point: { name: '回到酒店', lat: 30.259, lng: 120.1503 } });
  assert.equal(trip.days[0].stops.at(-1).id, 'destination');
  const reordered = await request(`/trip/${trip.id}/stops`, { day: 1, stops: payload([...ids(trip.days[0])].reverse()) });
  assert.equal(reordered.body.trip.days[0].stops.at(-1).id, 'destination', '终点由服务端重新接回末尾');
  // 即使客户端把 destination 发过来也当作没发。
  const withDestination = await request(`/trip/${trip.id}/stops`, { day: 1, stops: [...payload(ids(trip.days[0])), { id: 'destination' }] });
  assert.equal(withDestination.body.trip.days[0].stops.filter(stop => stop.id === 'destination').length, 1);
  const session = (await request('/session/start', { trip_id: trip.id, day: 1, model_consent: false })).body;
  const blocked = await request(`/trip/${trip.id}/stops`, { day: 1, stops: payload(ids(trip.days[0])) });
  assert.equal(blocked.status, 409);
  assert.match(blocked.body.error, /先结束当前漫游/);
  await request('/session/end', { session_id: session.id });
  assert.equal((await request(`/trip/${trip.id}/stops`, { day: 1, stops: payload(ids(trip.days[0])) })).status, 200);
});

test('结束之后可以让 DeepSeek 写一段收尾文字，并随行程保存', async t => {
  const { request, trip } = await plan(t);
  // 规划时没有授权，直接请求要明确拒绝。
  const denied = await request(`/trip/${trip.id}/summary`, {});
  assert.equal(denied.status, 400);
  assert.match(denied.body.error, /模型授权/);
  // 没有配置 DeepSeek 时明确说不可用。
  const consented = await plan(t, { model_consent: true });
  assert.equal((await consented.request(`/trip/${consented.trip.id}/summary`, {})).status, 503);
  // 配置好之后正常生成。
  const oldFetch = globalThis.fetch, oldKey = process.env.DEEPSEEK_API_KEY, oldMode = process.env.DEEPSEEK_MODEL;
  process.env.DEEPSEEK_API_KEY = 'summary-test'; process.env.DEEPSEEK_MODEL = 'summary-model';
  let sent = null;
  globalThis.fetch = async (url, init) => {
    sent = JSON.parse(init.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ summary: '风把湖面吹皱，你在桥上站了一会儿。\n\n这一天就这样留在身后。' }) } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  t.after(() => { globalThis.fetch = oldFetch; if (oldKey === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = oldKey; if (oldMode === undefined) delete process.env.DEEPSEEK_MODEL; else process.env.DEEPSEEK_MODEL = oldMode; });
  const written = await consented.request(`/trip/${consented.trip.id}/summary`, {});
  assert.equal(written.status, 200);
  assert.match(written.body.summary.text, /湖面/);
  assert.ok(!written.body.summary.text.includes('\n'), '换行被折成空格，避免段落符号破坏排版');
  assert.match(written.body.summary.source, /summary-model/);
  // 发给模型的只有行程事实：不含坐标、不含身份、不含健康特征。
  const context = JSON.parse(sent.messages[1].content);
  assert.ok(!/lat|lng|coordinate|heart|hr_|cadence|walked/.test(JSON.stringify(context)));
  assert.equal(context.city, '杭州');
  assert.ok(context.planned_days[0].places.length >= 2);
  // 报告里能直接读到，不用再生成一次。
  const report = (await consented.request(`/trip/${consented.trip.id}/report`)).body;
  assert.equal(report.summary.text, written.body.summary.text);
  assert.ok(Array.isArray(report.journal));
  // 模型返回空内容时明确失败，不编造一段。
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: '{}' } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const empty = await consented.request(`/trip/${consented.trip.id}/summary`, {});
  assert.equal(empty.status, 503);
});

// ---------------- 自动选位与跨零点 ----------------

const toMinutes = text => Number(text.slice(0, 2)) * 60 + Number(text.slice(3));

test('加餐厅时交给服务端选位置：落在午餐时间，而不是排到最后', async t => {
  const { request, trip } = await plan(t);
  const original = ids(trip.days[0]);
  assert.ok(!trip.days[0].stops.some(stop => stop.category === '美食'), '样例行程里原本没有餐厅');
  // 客户端把新地点放在列表末尾，并用 auto_place 指出它的下标。
  const added = await request(`/trip/${trip.id}/stops`, { day: 1, stops: [...payload(original), { id: 'lunch-hubin' }], auto_place: original.length });
  assert.equal(added.status, 200);
  const stops = added.body.trip.days[0].stops, at = stops.findIndex(stop => stop.id === 'lunch-hubin');
  assert.equal(added.body.placed.id, 'lunch-hubin');
  assert.equal(added.body.placed.index, at, '返回的位置就是最终位置');
  assert.equal(added.body.placed.meal, '午餐');
  assert.ok(at > 0 && at < stops.length - 1, '不在开头也不在末尾');
  const arrival = toMinutes(stops[at].arrival);
  assert.ok(arrival >= 11 * 60 && arrival <= 13 * 60 + 30, `到店时间 ${stops[at].arrival} 应在午餐时段`);
  // 其余各站的相对顺序不变。
  assert.deepEqual(stops.filter(stop => stop.id !== 'lunch-hubin').map(stop => stop.id), original);
  // 午餐已经有了，再加一家就不再挤进午餐时段。
  const second = await request(`/trip/${trip.id}/stops`, { day: 1, stops: [...payload(ids(added.body.trip.days[0])), { id: 'hefang' }], auto_place: original.length + 1 });
  assert.equal(second.status, 200);
  assert.notEqual(second.body.placed.meal, '午餐');
});

test('不带 auto_place 时顺序完全由客户端决定；下标非法要拒绝', async t => {
  const { request, trip } = await plan(t);
  const original = ids(trip.days[0]);
  const plain = await request(`/trip/${trip.id}/stops`, { day: 1, stops: [...payload(original), { id: 'lunch-hubin' }] });
  assert.equal(plain.body.trip.days[0].stops.at(-1).id, 'lunch-hubin');
  assert.equal(plain.body.placed, null);
  const bad = await request(`/trip/${trip.id}/stops`, { day: 1, stops: payload(original), auto_place: 99 });
  assert.equal(bad.status, 400);
});

test('非餐厅地点自动选位只看绕路：放在离它最近的两站之间', async t => {
  const { request, trip } = await plan(t);
  const original = ids(trip.days[0]), stops = trip.days[0].stops;
  // 取第 2、3 站的中点，最顺路的位置就是它们之间。
  const middle = { name: '两站中间的亭子', lat: (stops[1].lat + stops[2].lat) / 2, lng: (stops[1].lng + stops[2].lng) / 2, category: '人文' };
  const added = await request(`/trip/${trip.id}/stops`, { day: 1, stops: [...payload(original), middle], auto_place: original.length });
  assert.equal(added.status, 200);
  assert.equal(added.body.placed.index, 2);
  assert.equal(added.body.placed.meal, null);
  assert.equal(added.body.trip.days[0].stops[2].name, '两站中间的亭子');
});

test('排到次日的改动直接拒绝，行程保持不变，不会出现 25:10 这样的时间', async t => {
  const { request, trip } = await plan(t);
  const original = ids(trip.days[0]);
  // 往北三十多公里：步行过去要十个小时左右，排进去就过了零点。
  const far = { name: '很远的地方', lat: 30.55, lng: 120.15, category: '人文' };
  for (const body of [{ stops: [...payload(original), far] }, { stops: [...payload(original), far], auto_place: original.length }]) {
    const edited = await request(`/trip/${trip.id}/stops`, { day: 1, ...body });
    assert.equal(edited.status, 400);
    assert.match(edited.body.error, /次日 \d{2}:\d{2}/);
    assert.doesNotMatch(edited.body.error, /(2[4-9]|[3-9]\d):\d{2}/, '提示里也不能出现 24 点以后的写法');
  }
  // 远到要走好几天的，说「几天后」，同样不拼出 46:20 这种时刻。
  const absurd = await request(`/trip/${trip.id}/stops`, { day: 1, stops: [...payload(original), { name: '另一座城市', lat: 31.23, lng: 121.47 }] });
  assert.equal(absurd.status, 400);
  assert.match(absurd.body.error, /\d 天后/);
  assert.doesNotMatch(absurd.body.error, /\d{2}:\d{2}/);
  const saved = (await request('/trip/' + trip.id)).body;
  assert.deepEqual(ids(saved.days[0]), original);
  assert.equal(saved.version, trip.version);
  for (const stop of saved.days[0].stops) assert.ok(toMinutes(stop.departure) < 24 * 60);
});

test('终点太远、当天走不到时规划直接说明原因', async t => {
  const app = createApp({ database: ':memory:' });
  t.after(() => app.emit('close'));
  const planned = await dispatch(app, '/api/trip/plan', { ...PLAN, end_point: { name: '很远的酒店', lat: 30.55, lng: 120.15 } });
  assert.equal(planned.status, 422);
  assert.match(planned.body.error, /终点「很远的酒店」/);
  assert.match(planned.body.error, /次日/);
});
