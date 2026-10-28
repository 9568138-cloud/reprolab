// 数据体检：上传后先看清每一列长什么样（缺失、唯一值、范围、最常见值）

/** 单列画像 */
export function columnProfile(dataset, column) {
  const values = dataset.rows.map((r) => r[column.index]);
  const n = values.length;
  let missing = 0;
  const seen = new Map();
  const nums = [];
  for (const raw of values) {
    const s = raw === undefined || raw === null ? '' : String(raw).trim();
    if (s === '') { missing += 1; continue; }
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
