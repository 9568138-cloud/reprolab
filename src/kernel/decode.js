// 文本解码：中文 CSV 一个绕不开的坑是编码。
// Excel「另存为 CSV」在中文 Windows 下默认输出 GBK，直接按 UTF-8 读就是一屏乱码。
// 这里先按 UTF-8 严格解码（非 UTF-8 会抛错），失败再按 GB18030（向下兼容 GBK/GB2312）。

const GB_LABEL = 'GB18030';

/** @param {Uint8Array|ArrayBuffer} input 原始字节 */
export function decodeTextBuffer(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);

  // UTF-8 BOM：Excel 有时会写，解码前必须去掉，否则第一列名会带个不可见字符
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: new TextDecoder('utf-8').decode(bytes.subarray(3)), encoding: 'UTF-8', bom: true };
  }

  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'UTF-8', bom: false };
  } catch {
    // 不是合法 UTF-8：按 GB18030 解（GBK/GB2312 的超集）
    const text = new TextDecoder(GB_LABEL).decode(bytes);
    return { text, encoding: GB_LABEL, bom: false };
  }
}

/** 编码 → 给人看的一句话 */
export function encodingNote(encoding) {
  return encoding === 'UTF-8' ? '' : `检测到 ${encoding} 编码（Excel 导出的中文 CSV 常见），已自动转换`;
}
