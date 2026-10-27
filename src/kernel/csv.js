// 最小 CSV 解析器（RFC4180 子集：引号、逗号、CRLF、双引号转义）
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const src = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');

  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 1; } else { inQuotes = false; }
      } else field += ch;
      continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === ',') { row.push(field); field = ''; continue; }
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += ch;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((r) => !(r.length === 1 && r[0].trim() === ''));
}

/** CSV → { columns: [{name, index, kind}], rows: [[...raw]] }，全部保留原始字符串 */
export function toDataset(text) {
  // 允许注释行（# 开头），方便在示例数据里写说明
  const cleaned = text
    .replace(/^\uFEFF/, '')
    .split(/\r\n?|\n/)
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
  const rows = parseCsv(cleaned);
  if (rows.length < 2) throw new Error('CSV 至少需要表头和一行数据');
  const header = rows[0].map((h, i) => (h.trim() || `col_${i + 1}`));
  const body = rows.slice(1);
  const columns = header.map((name, index) => {
    const sample = body.slice(0, 50).map((r) => r[index]).filter((v) => v !== undefined && v !== '');
    const numeric = sample.length > 0 && sample.every((v) => Number.isFinite(Number(v)));
    return { name, index, kind: numeric ? 'number' : 'string' };
  });
  return { columns, rows: body, rowCount: body.length };
}

export function columnValues(dataset, name) {
  const col = dataset.columns.find((c) => c.name === name);
  if (!col) throw new Error(`找不到列：${name}（可用：${dataset.columns.map((c) => c.name).join(', ')}）`);
  return dataset.rows.map((r) => (r[col.index] === '' ? null : r[col.index]));
}

export function numericValues(dataset, name) {
  return columnValues(dataset, name).map((v) => (v === null ? NaN : Number(v)));
}
