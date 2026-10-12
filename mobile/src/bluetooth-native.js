// 蓝牙适配层：用 @capacitor-community/bluetooth-le 实现 Web Bluetooth 的一个子集。
// 覆盖 public/sensors.js 真正用到的 7 个 API，因此心率带功能在 App 内不需要改前端代码。
// 关键点：Capacitor 的 WebView 不提供 Web Bluetooth，但原生 BLE 插件可以。
// 插件按需加载：桌面浏览器（非原生容器）不会载入它。

const UUID_ALIASES = {
  heart_rate: '0000180d-0000-1000-8000-00805f9b34fb',
  heart_rate_measurement: '00002a37-0000-1000-8000-00805f9b34fb',
  heart_rate_control_point: '00002a39-0000-1000-8000-00805f9b34fb',
  battery_service: '0000180f-0000-1000-8000-00805f9b34fb',
  battery_level: '00002a19-0000-1000-8000-00805f9b34fb',
  device_information: '0000180a-0000-1000-8000-00805f9b34fb'
};

const toUuid = value => UUID_ALIASES[value] || String(value || '').toLowerCase();

class Emitter {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, listener, options) {
    if (typeof listener !== 'function') return;
    const set = this.listeners.get(type) || new Set();
    if (options && options.once === true) {
      const wrapped = event => { set.delete(wrapped); listener(event); };
      set.add(wrapped);
    } else {
      set.add(listener);
    }
    this.listeners.set(type, set);
  }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
  emit(type, event) {
    for (const listener of [...(this.listeners.get(type) || [])]) {
      try { listener(event); } catch (error) { console.error('[bluetooth] 监听回调异常', error); }
    }
  }
}

class NativeCharacteristic extends Emitter {
  constructor(ble, deviceId, service, characteristic) {
    super();
    this.ble = ble;
    this.deviceId = deviceId;
    this.service = service;
    this.characteristic = characteristic;
    this.value = null;
  }
  async startNotifications() {
    await this.ble.startNotifications(this.deviceId, this.service, this.characteristic, value => {
      // 插件这一层已经把手持端返回的字符串转成了 DataView，与 Web Bluetooth 一致
      this.value = value;
      this.emit('characteristicvaluechanged', { target: this });
    });
    return this;
  }
  async stopNotifications() {
    await this.ble.stopNotifications(this.deviceId, this.service, this.characteristic);
    return this;
  }
  async readValue() {
    const result = await this.ble.read(this.deviceId, this.service, this.characteristic);
    if (result?.value) this.value = result.value;
    return this.value;
  }
}

class NativeService {
  constructor(ble, deviceId, service) {
    this.ble = ble;
    this.deviceId = deviceId;
    this.service = service;
  }
  async getCharacteristic(name) {
    const characteristic = toUuid(name);
    // 能拿到服务结构时先校验，避免之后在错误的特征值上等数据
    try {
      const discovered = await this.ble.getServices(this.deviceId);
      const found = discovered?.services?.find(s => String(s.uuid).toLowerCase() === this.service);
      if (found && Array.isArray(found.characteristics)
        && !found.characteristics.some(c => String(c.uuid).toLowerCase() === characteristic)) {
        throw new Error(`设备上没有该特征值：${name}`);
      }
    } catch (error) {
      if (error?.message?.startsWith('设备上没有')) throw error;
    }
    return new NativeCharacteristic(this.ble, this.deviceId, this.service, characteristic);
  }
}

class NativeGattServer {
  constructor(device, ble) { this.device = device; this.ble = ble; this.linked = false; }
  get connected() { return this.linked; }
  async connect() {
    await this.ble.initialize();
    await this.ble.connect(this.device.id, () => {
      this.linked = false;
      this.device.emit('gattserverdisconnected', { target: this.device });
    });
    this.linked = true;
    return this;
  }
  async disconnect() {
    try { await this.ble.disconnect(this.device.id); } finally { this.linked = false; }
  }
  async getPrimaryService(name) {
    return new NativeService(this.ble, this.device.id, toUuid(name));
  }
}

class NativeDevice extends Emitter {
  constructor(info, ble) {
    super();
    this.id = info.deviceId;
    this.name = info.name;
    this.gatt = new NativeGattServer(this, ble);
  }
}

export async function installBluetooth(ble) {
  const client = ble || (await import('@capacitor-community/bluetooth-le')).BleClient;
  if (!globalThis.navigator || typeof client?.requestDevice !== 'function') return false;
  const bluetooth = {
    async getAvailability() {
      try { await client.initialize(); return Boolean(await client.isEnabled()); } catch { return false; }
    },
    async requestDevice(options = {}) {
      await client.initialize();
      const services = [];
      for (const filter of options.filters || []) {
        for (const service of filter.services || []) services.push(toUuid(service));
      }
      // 不传 deviceId 时，安卓端会弹出系统设备选择列表
      const device = await client.requestDevice({
        services,
        optionalServices: (options.optionalServices || []).map(toUuid)
      });
      if (!device?.deviceId) throw new Error('未选择蓝牙设备');
      return new NativeDevice(device, client);
    }
  };
  Object.defineProperty(globalThis.navigator, 'bluetooth', { configurable: true, value: bluetooth });
  return true;
}

export default { installBluetooth };
