// node:util 替身。项目里只用到 promisify（auth.js 把 scrypt 转成 Promise）。
export function promisify(fn) {
  if (typeof fn !== 'function') throw new TypeError('promisify 需要一个函数');
  return (...args) => new Promise((resolve, reject) => {
    fn(...args, (error, value) => (error ? reject(error) : resolve(value)));
  });
}

export default { promisify };
