// 读 zip：复现包是「store（不压缩）」写的，但别人可能用资源管理器重新打包成 deflate，
// 所以两种都支持——store 直接切片，deflate 走浏览器/Node 自带的 DecompressionStream（零依赖）。
// 只解析中央目录（权威尺寸），不依赖本地头里的字段。

const EOCD = 0x06054b50;
const CEN = 0x02014b50;

/** @param {Uint8Array|ArrayBuffer} input @returns {Promise<Map<string, Uint8Array>>} 文件名 → 字节 */
export async function readZip(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let eocd = -1;
  const min = Math.max(0, bytes.length - 65557);
  for (let i = bytes.length - 22; i >= min; i -= 1) {
    if (view.getUint32(i, true) === EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是 zip 文件（找不到目录尾部）');

  const count = view.getUint16(eocd + 10, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  const files = new Map();

  let p = cdOffset;
  for (let i = 0; i < count; i += 1) {
    if (p + 46 > bytes.length || view.getUint32(p, true) !== CEN) throw new Error('zip 目录结构异常');
    const method = view.getUint16(p + 10, true);
    const compSize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    const name = new TextDecoder('utf-8').decode(bytes.subarray(p + 46, p + 46 + nameLen));

    if (!name.endsWith('/')) {
      if (localOffset + 30 > bytes.length) throw new Error(`zip 条目越界：${name}`);
      const lNameLen = view.getUint16(localOffset + 26, true);
      const lExtraLen = view.getUint16(localOffset + 28, true);
      const start = localOffset + 30 + lNameLen + lExtraLen;
      const raw = bytes.subarray(start, start + compSize);
      if (method === 0) files.set(name, raw);
      else if (method === 8) files.set(name, await inflateRaw(raw));
      else throw new Error(`不支持的压缩方式 ${method}（${name}）`);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

async function inflateRaw(raw) {
  if (typeof DecompressionStream === 'undefined') throw new Error('当前环境不支持解压 deflate，请用 ReproLab 导出的原始包');
  const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** 按后缀找文件（兼容包被解压/重打包后多一层目录） */
export function findEntry(files, suffix) {
  const want = suffix.toLowerCase();
  for (const [name, data] of files) {
    if (name.toLowerCase().endsWith(want)) return data;
  }
  return null;
}
