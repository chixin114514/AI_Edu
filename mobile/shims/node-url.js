// node:url 替身。只用于把 import.meta.url 转成路径，App 内不做文件 IO。
export function fileURLToPath(url) {
  const text = String(url);
  if (!text.startsWith('file:')) return text;
  try {
    return decodeURIComponent(new URL(text).pathname);
  } catch {
    return text.replace(/^file:\/\//, '');
  }
}

export function pathToFileURL(p) {
  return new URL(`file://${String(p)}`);
}

export default { fileURLToPath, pathToFileURL };
