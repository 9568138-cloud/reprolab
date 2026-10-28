// 敏感性检验：把计划里的「可调参数」逐个扰动一点，重跑，看结论会不会翻盘。
//
// 「可复现」回答的是"同一计划能不能重算出同一个数"；敏感性回答的是更狠的问题：
//   "换个合理参数，结论还成立吗？"
// 审稿人/老师最常问的就是后者。这里不改数据、不改计划结构，只动一个参数。
import { executePlan } from './kernel/index.js';

/** 哪些算子的哪个参数可以调、调哪几个值 */
export const TUNABLES = {
  drop_outliers: {
    key: 'k',
    label: '剔除倍数 k',
    values: (v) => [1.0, 2.0, 3.0].filter((x) => x !== v),
  },
  filter_rows: {
    key: 'value',
    label: '筛选阈值',
    values: (v) => (typeof v === 'number' && Number.isFinite(v)
      ? [Number((v * 0.9).toPrecision(12)), Number((v * 1.1).toPrecision(12))]
      : []),
  },
  histogram: {
    key: 'bins',
    label: '分箱数',
    values: (v) => [Math.max(3, Math.round(v / 2)), v * 2],
  },
};

/**
 * 哪些字段算「结论」，哪些只是「过程量」：
 *   - 结论类（judged）：改了参数还能不能站得住 —— r / p / 斜率 / 均值差 / 是否显著…
 *   - 过程类（info）：样本量、剔除了几行、几个分组 —— 它们本来就该随参数变，
 *     拿它们判"结论翻盘"会得出荒唐结果（比如 k 调大、剔除点数从 836 掉到 232，被判 72% 漂移）。
 */
const JUDGED_FIELDS = new Set(['r', 'r2', 'slope', 'intercept', 'diff', 'per100', 'mean', 'topMean', 'p', 't', 'significant']);
const INFO_FIELDS = new Set(['removed', 'rowsUsed', 'n', 'df', 'kept', 'count', 'groupCount', 'topN']);

/** 「结论」取哪些字段：按优先级排，每个步骤最多取几个（避免表格太宽） */
const WITNESS_PRIORITY = ['r', 'significant', 'diff', 'p', 'per100', 'slope', 'groupCount', 'topMean', 'kept', 'removed', 'mean', 'n', 'r2', 'df', 't', 'topN', 'rowsUsed'];
const MAX_WITNESS_PER_STEP = 2;

const LABEL = {
  drop_outliers: '剔除异常点', filter_rows: '条件筛选', histogram: '分布直方图',
  correlate: '相关性', ttest: '两组比较', fit_linear: '线性拟合', group_summary: '分组汇总',
  trend: '时间趋势', describe: '描述统计', normalize: '标准化', transform_log: '对数变换',
  scatter: '散点图', missing_report: '缺失盘点',
};

/** 从一次执行结果里取出「结论性数字」：优先结论类，没有结论类才退而取过程量 */
export function witnessesOf(run) {
  const out = [];
  const judgedFirst = WITNESS_PRIORITY.filter((f) => JUDGED_FIELDS.has(f));
  const infoLater = WITNESS_PRIORITY.filter((f) => INFO_FIELDS.has(f));

  for (const step of run.steps) {
    const push = (field, value, bool) => out.push({
      stepId: step.id,
      op: step.op,
      field,
      label: `${LABEL[step.op] || step.op} · ${bool ? '是否显著' : field}`,
      value,
      bool: !!bool,
      judged: JUDGED_FIELDS.has(field),
    });

    let taken = 0;
    for (const field of judgedFirst) {
      if (taken >= MAX_WITNESS_PER_STEP) break;
      if (field === 'significant') {
        if (typeof step.output?.significant === 'boolean') { push(field, step.output.significant ? 1 : 0, true); taken += 1; }
        continue;
      }
      const v = step.output?.[field];
      if (typeof v === 'number' && Number.isFinite(v)) { push(field, v, false); taken += 1; }
    }
    // 这一步没有任何结论类数字（比如 describe / filter），才拿过程量凑一个用于展示
    if (taken === 0) {
      for (const field of infoLater) {
        const v = step.output?.[field];
        if (typeof v === 'number' && Number.isFinite(v)) { push(field, v, false); break; }
      }
    }
  }
  return out;
}

/** 生成扰动变体：每次只改一个步骤里的一个参数 */
export function buildVariants(plan) {
  const out = [];
  plan.steps.forEach((step, i) => {
    const t = TUNABLES[step.op];
    if (!t) return;
    const cur = step.params?.[t.key];
    for (const v of t.values(cur)) {
      if (v === cur) continue;
      const steps = plan.steps.map((s, j) => (j === i ? { ...s, params: { ...s.params, [t.key]: v } } : s));
      out.push({
        id: `v${i + 1}-${v}`,
        stepId: step.id,
        op: step.op,
        label: `${LABEL[step.op] || step.op}：${t.label} ${cur} → ${v}`,
        plan: { ...plan, steps },
      });
    }
  });
  return out;
}

/** 相对漂移：以基线为 0 作参照时用绝对差 */
export function driftOf(base, value) {
  if (!Number.isFinite(base) || !Number.isFinite(value)) return 0;
  if (base === 0) return value === 0 ? 0 : 1;
  return Math.abs(value - base) / Math.abs(base);
}

/**
 * 跑一遍敏感性：同一数据、逐个参数扰动、重跑，对比结论性数字
 * @returns {Promise<{variants:Array, witnesses:Array, verdict:string, maxDrift:number, flips:number}>}
 */
export async function runSensitivity({ dataset, plan, baseline }) {
  const witnesses = witnessesOf(baseline);
  const variants = buildVariants(plan);

  const rows = [];
  for (const v of variants) {
    try {
      const run = await executePlan(v.plan, dataset);
      const cells = witnesses.map((w) => {
        const step = run.steps.find((s) => s.id === w.stepId);
        const raw = step?.output?.[w.field];
        const value = typeof raw === 'boolean' ? (raw ? 1 : 0) : raw;
        const ok = typeof value === 'number' && Number.isFinite(value);
        return {
          label: w.label,
          field: w.field,
          value: ok ? value : null,
          drift: ok ? driftOf(w.value, value) : null,
          judged: !!w.judged,
          flip: w.field === 'significant' ? w.value !== value : (ok && w.value !== 0 && Math.sign(w.value) !== Math.sign(value)),
        };
      });
      rows.push({ ...v, cells, error: null });
    } catch (err) {
      rows.push({ ...v, cells: [], error: String(err?.message || err).split('\n')[0] });
    }
  }

  const all = rows.filter((r) => !r.error).flatMap((r) => r.cells);
  // 只拿「结论类」数字判稳健性；过程量（剔除点数、样本量）本来就该随参数变
  const judged = all.filter((c) => c.judged);
  const maxDrift = judged.reduce((m, c) => Math.max(m, c.drift ?? 0), 0);
  const flips = judged.filter((c) => c.flip).length;

  let verdict = 'none';
  if (!variants.length || judged.length === 0) verdict = 'none';
  else if (flips > 0 || maxDrift > 0.25) verdict = 'fragile';
  else if (maxDrift > 0.05) verdict = 'borderline';
  else verdict = 'robust';

  return { variants: rows, witnesses, maxDrift, flips, verdict };
}

/** 判定 → 给人看的一句话 */
export function verdictText(v) {
  return {
    none: '没有可判的结论类数字（计划里没有可调参数，或只有样本量/剔除点数这类过程量）',
    robust: '结论稳健：换参数后关键数字几乎不动（漂移 ≤5%，无翻盘）',
    borderline: '轻微敏感：关键数字随参数有 5–25% 的漂移，方向没变',
    fragile: '结论不稳：换参数后出现方向/显著性翻转，或数值漂移超过 25%',
  }[v] || '未知';
}
