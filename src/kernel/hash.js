// 稳定序列化 + SHA-256：同一数据/同一计划必须得到逐位一致的哈希
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

const enc = new TextEncoder();

/** 浏览器用 WebCrypto；Node 用 node:crypto —— 两边结果必须一致 */
export async function sha256(text) {
  const bytes = enc.encode(text);
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(bytes).digest('hex');
}

export function shortHash(h, n = 8) {
  return (h || '').slice(0, n);
}
