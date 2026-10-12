// 适配层单测：用假的原生插件验证状态机，不需要真机。
// 覆盖：蓝牙（心率服务）、定位、设备端服务配置注入。
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHeartRate } from '../../public/sensors.js';
import {
  readConfig, saveConfig, clearConfig, applyEnv, isLive
} from '../src/env-config.js';
import { installBluetooth } from '../src/bluetooth-native.js';
import { installGeolocation } from '../src/geolocation-native.js';

const memory = new Map();
globalThis.localStorage = {
  get length() { return memory.size; },
  key: i => [...memory.keys()][i] ?? null,
  getItem: k => (memory.has(k) ? memory.get(k) : null),
  setItem: (k, v) => memory.set(k, String(v)),
  removeItem: k => memory.delete(k),
  clear: () => memory.clear()
};

const HR_SERVICE = '0000180d-0000-1000-8000-00805f9b34fb';
const HR_MEASUREMENT = '00002a37-0000-1000-8000-00805f9b34fb';

function mockBle() {
  return {
    requested: null,
    notify: null,
    stopped: false,
    onDisconnect: null,
    async initialize() {},
    async isEnabled() { return true; },
    async requestDevice(options) { this.requested = options; return { deviceId: 'AA:BB:CC:DD:EE:FF', name: 'Polar H10' }; },
    async connect(deviceId, onDisconnect) { this.onDisconnect = onDisconnect; },
    async disconnect() {},
    async getServices() {
      return { services: [{ uuid: HR_SERVICE, characteristics: [{ uuid: HR_MEASUREMENT }] }] };
    },
    async startNotifications(deviceId, service, characteristic, callback) {
      this.notify = { deviceId, service, characteristic, callback };
    },
    async stopNotifications() { this.stopped = true; },
    async read() { return { value: new DataView(new Uint8Array([0, 72]).buffer) }; }
  };
}

// ---------------- 设备端服务配置 ----------------

test('没有密钥时保持演示模式', () => {
  clearConfig();
  const env = applyEnv();
  assert.equal(env.live, false);
  assert.equal(globalThis.process.env.DATA_MODE, 'demo');
});

test('填了高德 Key 就自动进入实况模式，并写进 process.env', () => {
  saveConfig({ AMAP_MAPS_API_KEY: 'amap-key-1', QWEATHER_API_KEY: 'q1', QWEATHER_API_BASE: 'https://x.re.qweatherapi.com' });
  const env = applyEnv();
  assert.equal(env.live, true);
  assert.equal(globalThis.process.env.DATA_MODE, 'live');
  assert.equal(globalThis.process.env.AMAP_MAPS_API_KEY, 'amap-key-1');
  assert.equal(globalThis.process.env.QWEATHER_API_KEY, 'q1');
});

test('显式指定演示模式时，即使有 Key 也不进实况', () => {
  saveConfig({ AMAP_MAPS_API_KEY: 'amap-key-1', DATA_MODE: 'demo' });
  assert.equal(isLive(readConfig()), false);
  assert.equal(applyEnv().live, false);
});

test('空值被剔除，清除后不再残留到进程环境', () => {
  saveConfig({ AMAP_MAPS_API_KEY: 'amap-key-1', DEEPSEEK_API_KEY: '   ' });
  assert.equal(readConfig().DEEPSEEK_API_KEY, undefined);
  clearConfig();
  applyEnv();
  assert.equal(globalThis.process.env.DATA_MODE, 'demo');
  assert.equal(globalThis.process.env.AMAP_MAPS_API_KEY, undefined);
});

// ---------------- 蓝牙 / 心率 ----------------

test('蓝牙适配层把 Web Bluetooth 调用翻译成原生 BLE 调用', async () => {
  const ble = mockBle();
  assert.equal(await installBluetooth(ble), true);
  assert.ok(globalThis.navigator.bluetooth, 'navigator.bluetooth 应已就位');

  const device = await globalThis.navigator.bluetooth.requestDevice({ filters: [{ services: ['heart_rate'] }] });
  assert.equal(device.name, 'Polar H10');
  assert.equal(device.id, 'AA:BB:CC:DD:EE:FF');
  assert.deepEqual(ble.requested.services, [HR_SERVICE], '简写服务名应被展开成 128 位 UUID');
  assert.equal(device.gatt.connected, false);

  const server = await device.gatt.connect();
  assert.equal(device.gatt.connected, true);

  const service = await server.getPrimaryService('heart_rate');
  const characteristic = await service.getCharacteristic('heart_rate_measurement');

  const heartRates = [];
  characteristic.addEventListener('characteristicvaluechanged', event => {
    heartRates.push(parseHeartRate(event.target.value));
  });
  await characteristic.startNotifications();

  assert.equal(ble.notify.service, HR_SERVICE);
  assert.equal(ble.notify.characteristic, HR_MEASUREMENT);
  assert.equal(ble.notify.deviceId, 'AA:BB:CC:DD:EE:FF');

  // 原生层回调 DataView，sensors.js 的 parseHeartRate 应能直接解析
  ble.notify.callback(new DataView(new Uint8Array([0, 72]).buffer));
  // 16 位心率：flags=0x01 表示值是 16 位小端，取值 150
  ble.notify.callback(new DataView(new Uint8Array([0x01, 0x96, 0x00]).buffer));
  assert.deepEqual(heartRates, [72, 150]);

  await characteristic.stopNotifications();
  assert.equal(ble.stopped, true);

  await device.gatt.disconnect();
  assert.equal(device.gatt.connected, false);
});

test('设备断开时触发 gattserverdisconnected，且 once 只触发一次', async () => {
  const ble = mockBle();
  await installBluetooth(ble);
  const device = await globalThis.navigator.bluetooth.requestDevice({ filters: [{ services: ['heart_rate'] }] });
  await device.gatt.connect();

  let count = 0;
  device.addEventListener('gattserverdisconnected', () => { count += 1; }, { once: true });

  ble.onDisconnect('AA:BB:CC:DD:EE:FF');
  assert.equal(count, 1);
  assert.equal(device.gatt.connected, false, '断开后 connected 应为 false');

  ble.onDisconnect('AA:BB:CC:DD:EE:FF');
  assert.equal(count, 1, 'once 监听不应重复触发');
});

test('设备上没有目标特征值时给出可读错误', async () => {
  const ble = mockBle();
  ble.getServices = async () => ({ services: [{ uuid: HR_SERVICE, characteristics: [] }] });
  await installBluetooth(ble);
  const device = await globalThis.navigator.bluetooth.requestDevice({ filters: [{ services: ['heart_rate'] }] });
  const server = await device.gatt.connect();
  const service = await server.getPrimaryService('heart_rate');
  await assert.rejects(() => service.getCharacteristic('heart_rate_measurement'), /没有该特征值/);
});

test('未选择设备时抛错，不会静默返回空设备', async () => {
  const ble = mockBle();
  ble.requestDevice = async () => ({ deviceId: '' });
  await installBluetooth(ble);
  await assert.rejects(() => globalThis.navigator.bluetooth.requestDevice({ filters: [{ services: ['heart_rate'] }] }), /未选择蓝牙设备/);
});

// ---------------- 定位 ----------------

function mockGeo() {
  return {
    granted: true,
    lastOptions: null,
    error: null,
    async checkPermissions() { return { location: this.granted ? 'granted' : 'denied' }; },
    async requestPermissions() { return { location: this.granted ? 'granted' : 'denied' }; },
    async getCurrentPosition(options) {
      this.lastOptions = options;
      if (this.error) throw new Error(this.error);
      return { timestamp: 1730000000000, coords: { latitude: 30.259, longitude: 120.15, accuracy: 12 } };
    },
    async watchPosition() { return 'watch-1'; },
    async clearWatch() {}
  };
}

const getPosition = () => new Promise((resolve, reject) => globalThis.navigator.geolocation.getCurrentPosition(resolve, reject));

test('定位适配层返回浏览器形状的结果，并透传精度选项', async () => {
  const geo = mockGeo();
  assert.equal(await installGeolocation(geo), true);
  const position = await getPosition();
  assert.equal(position.coords.latitude, 30.259);
  assert.equal(position.coords.longitude, 120.15);
  assert.equal(position.coords.accuracy, 12);
  assert.equal(geo.lastOptions.enableHighAccuracy, true);
  assert.equal(geo.lastOptions.timeout, 12000);
});

test('定位错误按 sensors.js 期望的 1/2/3 错误码返回', async () => {
  const geo = mockGeo();
  await installGeolocation(geo);

  geo.granted = false;
  assert.equal((await getPosition().catch(e => e)).code, 1, '权限被拒 → 1');

  geo.granted = true;
  geo.error = 'Location services are disabled';
  assert.equal((await getPosition().catch(e => e)).code, 2, '定位服务不可用 → 2');

  geo.error = 'timeout';
  assert.equal((await getPosition().catch(e => e)).code, 3, '其他失败 → 3');
});
