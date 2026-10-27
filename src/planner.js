// 自然语言 → 分析计划。两条路：
// 1) 规则编译（离线、确定、无 Key 也能演示）
// 2) LLM 编译（DeepSeek API，输出仍要被 validatePlan 卡住；失败自动降级到规则）
import { validatePlan } from './kernel/index.js';

const KEYWORDS = [
  { op: 'missing_report', words: ['缺失', '空值', '缺数据', 'nan', 'null', '漏填'] },
  { op: 'normalize', words: ['标准化', 'z-score', 'zscore', '归一化'] },
  { op: 'ttest', words: ['两组', 't 检验', 't检验', '均值差', '差异显著', '显著差异'] },
  { op: 'group_summary', words: ['分组', '各组', '按类别', '每类', '各类', '不同班', '对比各组'] },
  { op: 'histogram', words: ['分布', '直方图', '频数', '区间分布'] },
  { op: 'trend', words: ['随时间', '时间序列', '变化趋势', '逐日', '逐行'] },
  { op: 'drop_outliers', words: ['异常', '离群', '野值', '剔除', '去掉', '删掉', '噪'] },
  { op: 'transform_log', words: ['对数', 'log', 'ln', '指数关系', '幂', '倍数'] },
  { op: 'correlate', words: ['相关', '关系', '关联', '趋势', '负相关', '正相关', '影响', '下降', '降低', '上升', '升高', '越', '跟着'] },
  { op: 'fit_linear', words: ['拟合', '回归', '斜率', '方程', '线性', '模型', '预测', '拟一条', '拟个', '直线'] },
  { op: 'scatter', words: ['图', '画', '可视化', '散点', '绘图', '放进报告', '曲线'] },
];

/** 文本列按「不同取值个数」从少到多排序：城市(70) 比 日期(192) 更适合当分组列 */
export function groupCandidates(dataset) {
  return dataset.columns
    .filter((c) => c.kind === 'string')
    .map((c) => {
      const seen = new Set();
      for (const row of dataset.rows) {
        const v = String(row[c.index] ?? '').trim();
        if (v) seen.add(v);
      }
      return { name: c.name, card: seen.size, values: [...seen] };
    })
    .filter((c) => c.card >= 2)
    .sort((a, b) => a.card - b.card);
}

function pickGroupColumn(dataset, excludeName) {
  return groupCandidates(dataset).filter((c) => c.name !== excludeName)[0] || null;
}

export function compileByRules(dataset, question) {
  const hits = new Set();
  for (const { op, words } of KEYWORDS) if (words.some((w) => question.toLowerCase().includes(w))) hits.add(op);

  const nums = dataset.columns.filter((c) => c.kind === 'number');
  if (nums.length < 2) throw new Error('至少需要两列数值才能做趋势分析');
  const mentioned = nums.filter((c) => question.includes(c.name));
  const x = mentioned[0]?.name || nums[0].name;
  const y = mentioned[1]?.name || nums[1].name;
  // 分组类算子需要一个类别列（文本列）；没有就自动跳过，不报错。
  // 选「不同取值最少」的那一列：城市(70) 比 日期(192) 更适合当分组。
  const groupCol = pickGroupColumn(dataset, y);
  const groupValues = groupCol ? groupCol.values : [];

  const wantLog = hits.has('transform_log');
  const steps = [];
  const push = (op, params) => steps.push({ id: `s${steps.length + 1}`, op, params });

  steps.push({ id: 's1', op: 'describe', params: { column: y } });

  if (hits.has('missing_report')) push('missing_report', { column: y });
  if (hits.has('normalize')) push('normalize', { column: y });
  if (hits.has('drop_outliers')) push('drop_outliers', { column: y, k: 1.5, confirm: true });
  if (wantLog) push('transform_log', { column: y });
  if (groupCol && hits.has('group_summary')) push('group_summary', { groupBy: groupCol.name, column: y });
  if (groupCol && hits.has('ttest')) {
    // 问题里点了两个具体类别（如「北京和上海」）就直接用它们做两组比较
    const named = groupValues.filter((v) => question.includes(v)).slice(0, 2);
    push('ttest', {
      groupBy: groupCol.name, column: y,
      ...(named.length === 2 ? { groupA: named[0], groupB: named[1] } : {}),
    });
  }
  if (hits.has('correlate') || wantLog) push('correlate', { x, y, ...(wantLog ? { transformY: 'ln' } : {}) });
  if (hits.has('fit_linear') || wantLog) push('fit_linear', { x, y, ...(wantLog ? { transformY: 'ln' } : {}) });
  if (hits.has('trend')) push('trend', { column: y });
  if (hits.has('histogram')) push('histogram', { column: y, bins: 8 });
  if (hits.has('scatter') || hits.size === 0) {
    push('scatter', { x, y, ...(wantLog ? { transformY: 'ln' } : {}) });
  }

  const plan = { version: 1, question, engine: 'rules', steps };
  validatePlan(plan, dataset);
  return plan;
}

/** 由执行结果生成结论卡；每个数字都绑定 stepId + 字段，前端据此校验 */
export function buildClaims(plan, steps) {
  const claims = [];
  const byOp = (op) => steps.filter((s) => s.op === op);
  const corr = byOp('correlate')[0];
  const fit = byOp('fit_linear')[0];
  const out = byOp('drop_outliers')[0];

  if (corr) {
    const c = corr.output;
    claims.push({
      id: 'c1',
      text: `${c.x} 与 ${c.transformY === 'ln' ? 'ln ' : ''}${c.y} 呈${c.strength}${c.direction}（r = {{r}}，n = {{n}}，{{pPhrase}}）`,
      refs: [
        { stepId: corr.id, field: 'r', value: c.r },
        { stepId: corr.id, field: 'n', value: c.n },
        { stepId: corr.id, field: 'pPhrase', value: c.p < 1e-4 ? 'p < 0.0001' : `p = ${Number(c.p.toFixed(4))}` },
      ],
      verdict: c.significant ? '显著（p < 0.05）' : '不显著（p ≥ 0.05）',
    });
  }
  if (fit) {
    const f = fit.output;
    claims.push({
      id: 'c2',
      text: `拟合结果：${f.transformY === 'ln' ? 'ln ' : ''}${f.y} = {{intercept}} {{slopeSign}} {{absSlope}} × ${f.x}，R² = {{r2}}`,
      refs: [
        { stepId: fit.id, field: 'intercept', value: f.intercept },
        { stepId: fit.id, field: 'slopeSign', value: f.slope < 0 ? '−' : '+' },
        { stepId: fit.id, field: 'absSlope', value: Math.abs(f.slope) },
        { stepId: fit.id, field: 'r2', value: f.r2 },
      ],
      verdict: f.r2 >= 0.8 ? '拟合优度高' : f.r2 >= 0.5 ? '拟合中等' : '拟合较弱',
    });
  }
  if (out) {
    const o = out.output;
    claims.push({
      id: 'c3',
      text: `按 IQR（k = ${o.k}）检出 {{count}} 个异常点，已剔除 ${o.removed} 行（可撤回）`,
      refs: [{ stepId: out.id, field: 'removed', value: o.removed }, { stepId: out.id, field: 'count', value: o.outliers.length }],
      verdict: o.removed > 0 ? '需人工确认' : '无需处理',
    });
  }
  const tt = byOp('ttest')[0];
  if (tt) {
    const o = tt.output;
    claims.push({
      id: 'c4',
      text: `${o.groupA} 与 ${o.groupB} 两组的 ${o.column} 均值差 = {{diffText}}（t = {{t}}，df = {{df}}，{{pPhrase}}）`,
      refs: [
        { stepId: tt.id, field: 'diffText', value: `${Number(o.diff.toFixed(4))}` },
        { stepId: tt.id, field: 't', value: o.t },
        { stepId: tt.id, field: 'df', value: o.df },
        { stepId: tt.id, field: 'pPhrase', value: o.p < 1e-4 ? 'p < 0.0001' : `p = ${Number(o.p.toFixed(4))}` },
      ],
      verdict: o.significant ? '两组差异显著（p < 0.05）' : '两组差异不显著（p ≥ 0.05）',
    });
  }

  const gp = byOp('group_summary')[0];
  if (gp && gp.output.top) {
    const o = gp.output;
    claims.push({
      id: 'c5',
      text: `按 ${o.groupBy} 分组得到 {{groupCount}} 组，${o.column} 均值最高的是「${o.top.group}」（{{topMean}}，n = {{topN}}）`,
      refs: [
        { stepId: gp.id, field: 'groupCount', value: o.groupCount },
        { stepId: gp.id, field: 'topMean', value: o.top.mean },
        { stepId: gp.id, field: 'topN', value: o.top.n },
      ],
      verdict: `共 ${o.groups.length} 个类别，按均值降序`,
    });
  }

  const tr = byOp('trend')[0];
  if (tr) {
    const o = tr.output;
    claims.push({
      id: 'c6',
      text: `按记录顺序，${o.column} 每 100 行变化 {{per100}}（斜率 {{slope}}，R² = {{r2}}）`,
      refs: [
        { stepId: tr.id, field: 'per100', value: o.per100 },
        { stepId: tr.id, field: 'slope', value: o.slope },
        { stepId: tr.id, field: 'r2', value: o.r2 },
      ],
      verdict: Math.abs(o.r2) >= 0.5 ? '顺序趋势明显' : '顺序趋势较弱',
    });
  }

  const hs = byOp('histogram')[0];
  if (hs && hs.output.peak) {
    const o = hs.output;
    claims.push({
      id: 'c7',
      text: `${o.column} 的分布峰值落在 ${o.peak.from}–${o.peak.to} 区间（{{peakCount}} 条，占 {{peakPct}}%）`,
      refs: [
        { stepId: hs.id, field: 'peakCount', value: o.peak.count },
        { stepId: hs.id, field: 'peakPct', value: Number(((o.peak.count / o.n) * 100).toFixed(1)) },
      ],
      verdict: `${o.n} 个样本，范围 ${o.min}–${o.max}`,
    });
  }

  const ms = byOp('missing_report')[0];
  if (ms) {
    const o = ms.output;
    claims.push({
      id: 'c8',
      text: `${o.column} 共 {{missing}} 个缺失值（占总行数 {{ratePct}}%）`,
      refs: [
        { stepId: ms.id, field: 'missing', value: o.missing },
        { stepId: ms.id, field: 'ratePct', value: Number((o.rate * 100).toFixed(2)) },
      ],
      verdict: o.missing > 0 ? '存在缺失，后续统计已自动跳过' : '无缺失',
    });
  }

  return claims;
}

/** 渲染结论：{{field}} 必须能在 steps 里找到真实值，否则抛错（杜绝编数字） */
export function renderClaim(claim, steps) {
  return claim.text.replace(/\{\{(\w+)\}\}/g, (_, field) => {
    const ref = claim.refs.find((r) => r.field === field);
    if (!ref) throw new Error(`结论缺少引用字段：${field}`);
    const step = steps.find((s) => s.id === ref.stepId);
    if (!step) throw new Error(`引用的步骤不存在：${ref.stepId}`);
    const actual = resolveField(step.output, field);
    if (actual === undefined || actual === null) throw new Error(`步骤 ${ref.stepId} 没有字段 ${field}`);
    return formatNumber(actual, field);
  });
}

function resolveField(output, field) {
  if (field === 'count') return output.outliers ? output.outliers.length : undefined;
  // 派生字段：仍从真实结果算，不允许凭空写
  if (field === 'slopeSign') return output.slope < 0 ? '−' : '+';
  if (field === 'absSlope') return Math.abs(output.slope);
  if (field === 'pPhrase') return output.p < 1e-4 ? 'p < 0.0001' : `p = ${Number(output.p.toFixed(4))}`;
  if (field === 'diffText') return Number(Number(output.diff).toFixed(4));
  if (field === 'topMean') return output.top?.mean;
  if (field === 'topN') return output.top?.n;
  if (field === 'peakCount') return output.peak?.count;
  if (field === 'peakPct') return output.peak ? Number(((output.peak.count / output.n) * 100).toFixed(1)) : undefined;
  if (field === 'ratePct') return Number((output.rate * 100).toFixed(2));
  return output[field];
}

function formatNumber(v, field) {
  if (typeof v !== 'number') return String(v);
  // p 值：小于 1e-4 一律写成 < 0.0001，避免显示成 “p = 0”
  if (field === 'p' && v < 1e-4) return '< 0.0001';
  if (Math.abs(v) !== 0 && (Math.abs(v) < 1e-4 || Math.abs(v) >= 1e6)) return v.toExponential(3);
  return String(Number(v.toFixed(4)));
}

/** LLM 编译：给模型强约束的 schema，返回后仍要过 validatePlan */
export async function compileByLLM({ dataset, question, endpoint, apiKey, model = 'deepseek-chat' }) {
  const columns = dataset.columns.map((c) => `${c.name}(${c.kind})`).join(', ');
  const prompt = `你是数据分析计划编译器。只输出 JSON，不要解释。
可用算子（白名单，禁止其他）：
describe{column} / drop_outliers{column,k,confirm} / transform_log{column} / correlate{x,y,transformY?} / fit_linear{x,y,transformY?} / scatter{x,y,transformY?}
group_summary{groupBy,column} / ttest{groupBy,column,groupA?,groupB?} / normalize{column} / trend{column} / histogram{column,bins?} / missing_report{column}
字段说明：column/x/y/groupBy 必须是下面列名之一；groupBy 必须是文本列；transformY 只能是 "ln" 或省略；drop_outliers 必须带 "confirm": true。
输出结构：{"version":1,"question":"...","steps":[{"id":"s1","op":"...","params":{...}}]}
数据列：${columns}
样本行数：${dataset.rowCount}
用户问题：${question}`;

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: '只输出合法 JSON。' }, { role: 'user', content: prompt }],
      temperature: 0,
      response_format: { type: 'json_object' },
    }),
  });
  if (!res.ok) throw new Error(`LLM 编译失败：HTTP ${res.status}`);
  const data = await res.json();
  const raw = data.choices?.[0]?.message?.content || '{}';
  const plan = JSON.parse(raw);
  plan.engine = 'llm';
  validatePlan(plan, dataset);
  return plan;
}
