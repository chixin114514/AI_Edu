import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePhotoDataUrl, cleanJournalText, entryKey, photoUrl, JOURNAL_LIMITS } from '../server/journal.js';
import { createApp } from '../server/index.js';
import { dispatch } from './harness.js';

// 1×1 透明 PNG，文件头就是真实的 PNG 签名，用来验证魔数校验。
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AF+8v0lAAAAAElFTkSuQmCC';

test('照片只接受真实图片：校验 data URL、大小与文件头', () => {
  const parsed = parsePhotoDataUrl(PNG);
  assert.equal(parsed.mime, 'image/png');
  assert.ok(parsed.size > 0);
  // 声明是 JPEG 但内容是 PNG：不能只信前端标注的类型。
  assert.throws(() => parsePhotoDataUrl(PNG.replace('image/png', 'image/jpeg')), /不一致/);
  // 不是图片的内容，即使前缀写成 PNG 也要拒绝。
  assert.throws(() => parsePhotoDataUrl('data:image/png;base64,aGVsbG8gd29ybGQ='), /不一致/);
  // 只支持这三种格式与 base64 编码。
  assert.throws(() => parsePhotoDataUrl('data:image/gif;base64,R0lGODlhAQABAAAAACw='), /只支持/);
  assert.throws(() => parsePhotoDataUrl('data:image/png,abc'), /只支持/);
  assert.throws(() => parsePhotoDataUrl('https://example.com/photo.png'), /只支持/);
  assert.throws(() => parsePhotoDataUrl(null), /格式无效/);
  assert.throws(() => parsePhotoDataUrl('data:image/png;base64,!!!!'), /只支持/);
  // base64 长度先粗筛，超大照片在解码前就被拒。
  assert.throws(() => parsePhotoDataUrl(`data:image/png;base64,${'A'.repeat(4_000_000)}`), /不能超过/);
});

test('日记正文清洗：去首尾空白、统一换行、限制长度', () => {
  assert.equal(cleanJournalText(undefined), '');
  assert.equal(cleanJournalText(null), '');
  assert.equal(cleanJournalText('  风很大  '), '风很大');
  assert.equal(cleanJournalText('第一行\r\n第二行'), '第一行\n第二行');
  assert.throws(() => cleanJournalText({}), /格式无效/);
  assert.throws(() => cleanJournalText('字'.repeat(JOURNAL_LIMITS.textMax + 1)), /最多/);
});

test('照片地址与记录键由模块统一生成', () => {
  assert.equal(photoUrl({ mime: 'image/jpeg', data: 'AAA' }), 'data:image/jpeg;base64,AAA');
  assert.equal(entryKey('trip-1', 2, 'stop-3'), 'trip-1:2:stop-3');
});

const PLAN = { city: '杭州', date: '2026-10-20', days: 1, budget: 300, walk_limit_km: 6, interests: ['自然', '人文'], start_time: '09:00', end_time: '18:00', companion: '独自', model_consent: true };

async function setup(t) {
  const app = createApp({ database: ':memory:' });
  t.after(() => app.emit('close'));
  let cookie = '';
  const request = async (path, data, extra = {}) => {
    const r = await dispatch(app, '/api' + path, data, { cookie, ...extra });
    cookie = r.headers['set-cookie']?.split(';')[0] || cookie;
    return r;
  };
  const trip = (await request('/trip/plan', PLAN)).body;
  return { app, request, trip, stop: trip.days[0].stops[0] };
}

test('日记按地点保存：文字可增可改，清空即删除记录', async t => {
  const { request, trip, stop } = await setup(t);
  const target = { trip_id: trip.id, day: 1, stop_id: stop.id };
  const created = await request('/journal', { ...target, text: '  在这里坐了很久。  ' });
  assert.equal(created.status, 201);
  assert.equal(created.body.entry.text, '在这里坐了很久。');
  assert.equal(created.body.entry.stop_name, stop.name);
  const updated = await request('/journal', { ...target, text: '改了想法。' });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.entry.text, '改了想法。');
  assert.equal(updated.body.entry.created_at, created.body.entry.created_at, '创建时间不因编辑而改变');
  const list = await request(`/trip/${trip.id}/journal`);
  assert.equal(list.body.entries.length, 1);
  assert.equal(list.body.limits.textMax, JOURNAL_LIMITS.textMax);
  // 清空正文且没有照片时整条记录消失，不留空壳。
  const cleared = await request('/journal', { ...target, text: '   ' });
  assert.equal(cleared.body.deleted, true);
  assert.equal((await request(`/trip/${trip.id}/journal`)).body.entries.length, 0);
});

test('照片可以加上再删掉，条数与体积都受限', async t => {
  const { request, trip, stop } = await setup(t);
  const target = { trip_id: trip.id, day: 1, stop_id: stop.id };
  const first = await request('/journal/photo', { ...target, data: PNG });
  assert.equal(first.status, 201);
  assert.equal(first.body.photo.mime, 'image/png');
  assert.match(first.body.photo.url, /^data:image\/png;base64,/);
  assert.equal(first.body.entry.photo_ids.length, 1);
  const list = await request(`/trip/${trip.id}/journal`);
  assert.equal(list.body.entries[0].photos.length, 1);
  assert.match(list.body.entries[0].photos[0].url, /^data:image\/png;base64,/);
  // 只带照片、没有文字，也算一条有效日记。
  const removed = await request('/journal/photo/delete', { photo_id: first.body.photo.id });
  assert.equal(removed.body.deleted, true);
  assert.equal((await request(`/trip/${trip.id}/journal`)).body.entries.length, 0, '删掉最后一张照片后记录一并清掉');
  // 非法照片无法进入存储。
  const bad = await request('/journal/photo', { ...target, data: 'data:image/png;base64,aGVsbG8=' });
  assert.equal(bad.status, 400);
  assert.ok(!JSON.stringify(bad.body).includes('aGVsbG8'));
  for (let i = 0; i < JOURNAL_LIMITS.photosMaxPerEntry; i++) assert.equal((await request('/journal/photo', { ...target, data: PNG })).status, 201);
  const overflow = await request('/journal/photo', { ...target, data: PNG });
  assert.equal(overflow.status, 400);
  assert.match(overflow.body.error, /最多/);
});

test('日记只能挂在当天行程里的地点，也只属于当前身份', async t => {
  const { app, request, trip, stop } = await setup(t);
  assert.equal((await request('/journal', { trip_id: trip.id, day: 1, stop_id: 'not-in-day', text: 'x' })).status, 400);
  assert.equal((await request('/journal', { day: 1, stop_id: stop.id, text: 'x' })).status, 400, '缺少行程标识');
  assert.equal((await request('/journal', { trip_id: trip.id, day: 9, stop_id: stop.id, text: 'x' })).status, 400);
  assert.equal((await request('/journal', { trip_id: 'someone-else', day: 1, stop_id: stop.id, text: 'x' })).status, 404);
  await request('/journal', { trip_id: trip.id, day: 1, stop_id: stop.id, text: '只有我能看到' });
  const stranger = await dispatch(app, `/api/trip/${trip.id}/journal`);
  assert.equal(stranger.status, 404, '别的身份连行程都读不到，自然也读不到日记');
  const strangerRead = await dispatch(app, '/api/journal', { trip_id: trip.id, day: 1, stop_id: stop.id, text: '偷写' });
  assert.equal(strangerRead.status, 404);
});

test('删除账号记录会一并清掉日记与照片', async t => {
  const { request, trip, stop } = await setup(t);
  await request('/journal', { trip_id: trip.id, day: 1, stop_id: stop.id, text: '留一句' });
  await request('/journal/photo', { trip_id: trip.id, day: 1, stop_id: stop.id, data: PNG });
  assert.equal((await request(`/trip/${trip.id}/journal`)).body.entries[0].photos.length, 1);
  await request('/privacy/delete', { confirm: true });
  const after = await request(`/trip/${trip.id}/journal`);
  assert.equal(after.status, 404, '行程已被删除');
});

test('普通接口仍然是 32KB 上限，只有照片上传放宽', async t => {
  const { request, trip, stop } = await setup(t);
  const huge = { trip_id: trip.id, day: 1, stop_id: stop.id, text: '字'.repeat(40000) };
  const rejected = await request('/journal', huge);
  assert.equal(rejected.status, 413);
  // 照片上限是 3MB 的请求体，一张真实的小图能通过。
  assert.equal((await request('/journal/photo', { trip_id: trip.id, day: 1, stop_id: stop.id, data: PNG })).status, 201);
});
