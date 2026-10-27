// 算子白名单：AI 只能从这 6 个里挑，代码由本地实现渲染（不由模型生成）
import { describe, pearson, linearFit, correlationPValue, detectOutliers, round } from './stats.js';
import { columnValues, numericValues } from './csv.js';

/** 破坏性算子：涉及删数据，必须人工确认 */
export const DESTRUCTIVE = new Set(['drop_outliers']);

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
};

/** 把被剔除的行屏蔽掉（按 CSV 行号；行号 = 数据行下标 + 2） */
function maskRows(dataset, droppedRows) {
  if (!droppedRows || droppedRows.length === 0) return dataset.rows;
  const drop = new Set(droppedRows);
  return dataset.rows.filter((_, i) => !drop.has(i + 2));
}
