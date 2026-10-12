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
