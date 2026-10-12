// 漫游日记与照片的校验和整形。
//
// 照片直接以 data URL 存在记录里：网页端落在 SQLite，App 端落在 localStorage，
// 两端共用同一条代码路径——不需要文件系统，也不需要单独的二进制下载接口
// （App 内的后端是通过 JSON 桥接调用的，返回二进制流那条路走不通）。
export const JOURNAL_LIMITS = { textMax: 1200, photoBytesMax: 2 * 1024 * 1024, photosMaxPerEntry: 6 };

// 只接受这三种格式：前端压缩后的输出是 JPEG，PNG／WebP 覆盖浏览器直接保存的截图。
const IMAGE_TYPES = [
  { mime: 'image/jpeg', test: b => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/png', test: b => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { mime: 'image/webp', test: b => b.length > 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50 }
];

// 用 atob 而不是 Buffer.from(x,'base64')：App 内的后端跑在 WebView 里，
// 那里的 Buffer 是本项目自己的替身，只支持 utf8，会把 base64 原样当作字符串。
// atob 在 Node 16+ 与浏览器里都是全局函数。
function base64Bytes(base64) {
  let binary;
  try { binary = atob(base64); } catch { throw new Error('照片不是有效的 base64 数据'); }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function parsePhotoDataUrl(value) {
  if (typeof value !== 'string') throw new Error('照片格式无效');
  const matched = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value.trim());
  if (!matched) throw new Error('只支持 JPEG、PNG 或 WebP 图片');
  const base64 = matched[2];
  // 先按 base64 长度粗筛，避免为超大输入做无用的解码。
  if (base64.length > Math.ceil(JOURNAL_LIMITS.photoBytesMax / 3) * 4) throw tooLarge();
  const bytes = base64Bytes(base64);
  if (!bytes.length) throw new Error('照片内容为空');
  if (bytes.length > JOURNAL_LIMITS.photoBytesMax) throw tooLarge();
  // 声明的类型必须和文件头一致，否则会把任意内容当图片存下来再当成图片发给浏览器。
  const detected = IMAGE_TYPES.find(type => type.test(bytes));
  if (!detected || detected.mime !== matched[1]) throw new Error('照片内容与你标注的格式不一致');
  return { mime: detected.mime, base64, size: bytes.length };
}

const tooLarge = () => new Error(`单张照片不能超过 ${Math.round(JOURNAL_LIMITS.photoBytesMax / 1024 / 1024)} MB`);

export const photoUrl = photo => `data:${photo.mime};base64,${photo.data}`;

export function cleanJournalText(value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new Error('日记内容格式无效');
  const text = value.replace(/\r\n/g, '\n').trim();
  if (text.length > JOURNAL_LIMITS.textMax) throw new Error(`日记最多 ${JOURNAL_LIMITS.textMax} 字`);
  return text;
}

// 一个地点一条日记，键固定为 行程:天:站点，因此编辑与照片都挂在同一条记录上。
export const entryKey = (tripId, day, stopId) => `${tripId}:${day}:${stopId}`;
