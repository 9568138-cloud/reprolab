// 算子白名单：AI 只能从这些里挑，代码由本地实现渲染（不由模型生成）
import { describe, pearson, linearFit, correlationPValue, detectOutliers, round, meanStd, welchTTest, histogram } from './stats.js';
import { columnValues, numericValues } from './csv.js';

/** 破坏性算子：涉及删数据，必须人工确认 */
export const DESTRUCTIVE = new Set(['drop_outliers']);

/** 取某一列的值 + 行号（沿用 CSV 行号：下标 + 2） */
function pairsOf(dataset, column) {
  const col = dataset.columns.find((c) => c.name === column);
  if (!col) throw new Error(`找不到列：${column}`);
  return dataset.rows.map((r, i) => ({ row: i + 2, raw: r[col.index] }));
}

function groupValues(dataset, groupBy, column) {
  const gcol = dataset.columns.find((c) => c.name === groupBy);
  const vcol = dataset.columns.find((c) => c.name === column);
  if (!gcol) throw new Error(`找不到分组列：${groupBy}`);
  if (!vcol) throw new Error(`找不到数值列：${column}`);
  const map = new Map();
  for (const r of dataset.rows) {
    const g = String(r[gcol.index] ?? '').trim();
    const raw = String(r[vcol.index] ?? '').trim();
    // 空单元格是「缺失」，不是 0 —— 这条曾经把一组均值算错 600
    if (!g || raw === '') continue;
    const v = Number(raw);
    if (!Number.isFinite(v)) continue;
    if (!map.has(g)) map.set(g, []);
    map.get(g).push(v);
  }
  return map;
}

export const OPERATORS = {
  describe: {
    label: '描述统计',
    params: { column: 'string' },
    run({ dataset, droppedRows }, { column }) {
      // 若前面删过行，描述统计看到的是删除后的数据（与后续步骤口径一致）
      const rows = maskRows(dataset, droppedRows);
      const stats = describe(numericValues({ ...dataset, rows }, column));
      return { kind: 'stats', column, stats, rowsUsed: rows.length };
    },
  },

  drop_outliers: {
    label: '剔除异常点（IQR）',
    params: { column: 'string', k: 'number' },
    run({ dataset, droppedRows }, { column, k = 1.5 }) {
      const values = numericValues(dataset, column);
      const { outliers, bounds } = detectOutliers(values, k);
      const rows = new Set(outliers.map((o) => o.row));
      const nextDropped = [...(droppedRows || []), ...rows];
      return {
        kind: 'outliers',
        column, k, bounds,
        outliers,
        removed: rows.size,
        droppedRows: nextDropped,
        preview: outliers.slice(0, 10),
      };
    },
  },

  transform_log: {
    label: '对数变换 ln(x)',
    params: { column: 'string' },
    run({ dataset }, { column }) {
      const values = numericValues(dataset, column);
      const positive = values.filter((v) => Number.isFinite(v) && v > 0).length;
      if (positive < 3) throw new Error(`${column} 正数不足 3 个，log 变换无意义`);
      return { kind: 'transform', column, transform: 'ln', positiveCount: positive };
    },
  },

  correlate: {
    label: '相关性检验（r / p / n）',
    params: { x: 'string', y: 'string', transformY: 'string?' },
    run({ dataset, droppedRows, transforms }, { x, y, transformY }) {
      const rows = maskRows(dataset, droppedRows);
      const xs = numericValues({ ...dataset, rows }, x);
      const ysRaw = numericValues({ ...dataset, rows }, y);
      const ys = transformY === 'ln' ? ysRaw.map((v) => (Number.isFinite(v) && v > 0 ? Math.log(v) : NaN)) : ysRaw;
      const { r, n } = pearson(xs, ys);
      const p = correlationPValue(r, n);
      return {
        kind: 'correlation', x, y, transformY: transformY || null,
        r: round(r, 6), r2: round(r * r, 6), n, p: round(p, 8),
        significant: p < 0.05,
        direction: r > 0 ? '正相关' : r < 0 ? '负相关' : '无关',
        strength: Math.abs(r) >= 0.8 ? '强' : Math.abs(r) >= 0.5 ? '中等' : '弱',
      };
    },
  },

  fit_linear: {
    label: '线性拟合（斜率/截距/R²）',
    params: { x: 'string', y: 'string', transformY: 'string?' },
    run({ dataset, droppedRows }, { x, y, transformY }) {
      const rows = maskRows(dataset, droppedRows);
      const xs = numericValues({ ...dataset, rows }, x);
      const ysRaw = numericValues({ ...dataset, rows }, y);
      const ys = transformY === 'ln' ? ysRaw.map((v) => (Number.isFinite(v) && v > 0 ? Math.log(v) : NaN)) : ysRaw;
      const fit = linearFit(xs, ys);
      return {
        kind: 'fit', x, y, transformY: transformY || null,
        slope: round(fit.slope, 6), intercept: round(fit.intercept, 6),
        r2: round(fit.r2, 6), n: fit.n,
      };
    },
  },

  scatter: {
    label: '散点图（+拟合线）',
    params: { x: 'string', y: 'string', transformY: 'string?' },
    run({ dataset, droppedRows }, { x, y, transformY }) {
      const rows = maskRows(dataset, droppedRows);
      const xs = numericValues({ ...dataset, rows }, x);
      const ysRaw = numericValues({ ...dataset, rows }, y);
      const ys = transformY === 'ln' ? ysRaw.map((v) => (Number.isFinite(v) && v > 0 ? Math.log(v) : NaN)) : ysRaw;
      const points = xs.map((x2, i) => ({ x: x2, y: ys[i], row: i + 2 }))
        .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
      let line = null;
      if (points.length >= 3) {
        const fit = linearFit(points.map((p) => p.x), points.map((p) => p.y));
        line = { slope: round(fit.slope, 6), intercept: round(fit.intercept, 6) };
      }
      return {
        kind: 'scatter', x, y, transformY: transformY || null,
        points: points.slice(0, 2000), line, count: points.length,
      };
    },
  },

  // ---------- 第二批算子（iter 11） ----------
  group_summary: {
    label: '分组汇总（按类别算均值/中位数）',
    params: { groupBy: 'string', column: 'string' },
    run({ dataset, droppedRows }, { groupBy, column }) {
      const rows = maskRows(dataset, droppedRows);
      const map = groupValues({ ...dataset, rows }, groupBy, column);
      const groups = [...map.entries()].map(([group, vals]) => {
        const d = describe(vals);
        return { group, n: d.n, mean: d.mean, median: d.median, min: d.min, max: d.max };
      }).sort((a, b) => b.mean - a.mean);
      return { kind: 'group', groupBy, column, groups, groupCount: groups.length, top: groups[0] || null };
    },
  },

  ttest: {
    label: '两组均值检验（Welch t）',
    params: { groupBy: 'string', column: 'string', groupA: 'string?', groupB: 'string?' },
    run({ dataset, droppedRows }, { groupBy, column, groupA, groupB }) {
      const rows = maskRows(dataset, droppedRows);
      const map = groupValues({ ...dataset, rows }, groupBy, column);
      const names = [...map.keys()];
      if (names.length < 2) throw new Error(`分组列 ${groupBy} 只有 ${names.length} 组，做不了两组比较`);
      const bySize = names.sort((a, b) => map.get(b).length - map.get(a).length);
      const a = groupA || bySize[0];
      const b = groupB && groupB !== a ? groupB : bySize.find((n) => n !== a);
      if (!map.has(a) || !map.has(b)) throw new Error(`分组 ${a} 或 ${b} 不存在`);
      const res = welchTTest(map.get(a), map.get(b));
      return {
        kind: 'ttest', groupBy, column, groupA: a, groupB: b,
        t: round(res.t, 6), df: round(res.df, 4), p: round(res.p, 8),
        meanA: round(res.meanA, 6), meanB: round(res.meanB, 6), diff: round(res.diff, 6),
        nA: res.nA, nB: res.nB, significant: res.p < 0.05,
      };
    },
  },

  normalize: {
    label: '标准化 z-score',
    params: { column: 'string' },
    run({ dataset, droppedRows }, { column }) {
      const rows = maskRows(dataset, droppedRows);
      const s = meanStd(numericValues({ ...dataset, rows }, column));
      if (!s.n) throw new Error(`${column} 没有有效数值`);
      if (!s.std) throw new Error(`${column} 标准差为 0，标准化没有意义`);
      return { kind: 'transform', column, transform: 'zscore', mean: round(s.mean, 6), std: round(s.std, 6), n: s.n };
    },
  },

  trend: {
    label: '时间趋势（按行序拟合）',
    params: { column: 'string' },
    run({ dataset, droppedRows }, { column }) {
      const rows = maskRows(dataset, droppedRows);
      const ys = numericValues({ ...dataset, rows }, column);
      const xs = ys.map((_, i) => i + 1);
      const fit = linearFit(xs, ys);
      return {
        kind: 'trend', column,
        slope: round(fit.slope, 6), intercept: round(fit.intercept, 6),
        r2: round(fit.r2, 6), n: fit.n,
        per100: round(fit.slope * 100, 4),
      };
    },
  },

  histogram: {
    label: '分布直方图',
    params: { column: 'string', bins: 'number?' },
    run({ dataset, droppedRows }, { column, bins = 8 }) {
      const rows = maskRows(dataset, droppedRows);
      const h = histogram(numericValues({ ...dataset, rows }, column), Math.max(2, Math.min(20, Number(bins) || 8)));
      const peak = h.bins.reduce((best, b) => (b.count > best.count ? b : best), h.bins[0]);
      return {
        kind: 'histogram', column, bins: h.bins, min: round(h.min, 6), max: round(h.max, 6),
        n: h.n, peak: peak ? { from: peak.from, to: peak.to, count: peak.count } : null,
      };
    },
  },

  missing_report: {
    label: '缺失值盘点',
    params: { column: 'string' },
    run({ dataset, droppedRows }, { column }) {
      const rows = maskRows(dataset, droppedRows);
      const items = pairsOf({ ...dataset, rows }, column);
      const missing = items.filter((it) => {
        const s = String(it.raw ?? '').trim();
        return s === '' || s.toLowerCase() === 'nan' || s.toLowerCase() === 'null';
      });
      return {
        kind: 'missing', column, total: items.length, missing: missing.length,
        missingRows: missing.map((m) => m.row).slice(0, 50),
        rate: round(items.length ? missing.length / items.length : 0, 6),
      };
    },
  },
};

/** 把被剔除的行屏蔽掉（按 CSV 行号；行号 = 数据行下标 + 2） */
function maskRows(dataset, droppedRows) {
  if (!droppedRows || droppedRows.length === 0) return dataset.rows;
  const drop = new Set(droppedRows);
  return dataset.rows.filter((_, i) => !drop.has(i + 2));
}
