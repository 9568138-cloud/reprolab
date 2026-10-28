// 数据体检：上传后先看清每一列长什么样（缺失、唯一值、范围、最常见值）

/** 把一列文本尽量解析成数字（去掉单位、千分位、百分号；万/亿/千 会换算） */
export function forceNumericColumn(dataset, name) {
  const col = dataset.columns.find((c) => c.name === name);
  if (!col) throw new Error(`找不到列：${name}`);
  if (col.kind === 'number') return { dataset, parsed: 0, failed: 0, scaled: 0, already: true };
  const SCALE = [['百万', 1e6], ['亿', 1e8], ['万', 1e4], ['千', 1e3]];
  let parsed = 0;
  let failed = 0;
  let scaled = 0;
  const rows = dataset.rows.map((row) => {
    const raw = String(row[col.index] ?? '').trim();
    if (raw === '') return row;
    const cleaned = raw.replace(/[,，\s]/g, '').replace(/[%％]$/, '');
    const m = cleaned.match(/-?\d+(?:\.\d+)?/);
    if (!m) {
      failed += 1;
      const copy = [...row];
      copy[col.index] = '';
      return copy;
    }
    let v = Number(m[0]);
    // 中文数量级：12.5 万 → 125000（先查「百万」再查「万」）
    const unit = SCALE.find(([u]) => cleaned.includes(u));
    if (unit) { v *= unit[1]; scaled += 1; }
    parsed += 1;
    const copy = [...row];
    copy[col.index] = String(v);
    return copy;
  });
  const columns = dataset.columns.map((c) => (c.name === name ? { ...c, kind: 'number', forced: true } : c));
  return { dataset: { ...dataset, columns, rows }, parsed, failed, scaled, already: false };
}

/** 单列画像 */
export function columnProfile(dataset, column) {
  const values = dataset.rows.map((r) => r[column.index]);
  const n = values.length;
  let missing = 0;
  let withDigit = 0;
  const seen = new Map();
  const nums = [];
  for (const raw of values) {
    const s = raw === undefined || raw === null ? '' : String(raw).trim();
    if (s === '') { missing += 1; continue; }
    if (/\d/.test(s)) withDigit += 1;
    seen.set(s, (seen.get(s) || 0) + 1);
    if (column.kind === 'number') {
      const v = Number(s);
      if (Number.isFinite(v)) nums.push(v);
    }
  }
  const profile = {
    name: column.name,
    kind: column.kind,
    n,
    missing,
    missingRate: n ? missing / n : 0,
    unique: seen.size,
    constant: seen.size === 1,
    digitRatio: n ? withDigit / n : 0,
  };
  if (column.kind === 'number' && nums.length) {
    profile.min = Math.min(...nums);
    profile.max = Math.max(...nums);
    profile.mean = nums.reduce((a, b) => a + b, 0) / nums.length;
  }
  if (seen.size) {
    let topKey = null;
    let topCount = -1;
    for (const [k, c] of seen) if (c > topCount) { topKey = k; topCount = c; }
    profile.top = topKey;
    profile.topCount = topCount;
  }
  return profile;
}

/** 整张表画像：默认最多看 16 列 */
export function columnProfiles(dataset, limit = 16) {
  return dataset.columns.slice(0, limit).map((c) => columnProfile(dataset, c));
}

/** 需要提醒的数据质量问题 */
export function profileWarnings(profiles) {
  const out = [];
  for (const p of profiles) {
    if (p.missingRate >= 0.2) out.push(`${p.name} 缺失 ${(p.missingRate * 100).toFixed(1)}%`);
    if (p.constant) out.push(`${p.name} 只有一个取值（常量列）`);
  }
  return out;
}
