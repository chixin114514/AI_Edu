// node:fs/promises 替身。
// App 内的静态资源由 Capacitor（或本地静态服务）提供，不经过这个后端，
// 所以这里只需要让 readFile 以 ENOENT 失败，让 index.js 走它原本的 404 分支。
export async function readFile() {
  const error = new Error('ENOENT: 本地后端不提供静态文件');
  error.code = 'ENOENT';
  throw error;
}

export async function writeFile() { throw new Error('ENOENT'); }
export async function mkdir() { return undefined; }

export default { readFile, writeFile, mkdir };
