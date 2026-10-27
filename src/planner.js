// 自然语言 → 分析计划。两条路：
// 1) 规则编译（离线、确定、无 Key 也能演示）
// 2) LLM 编译（DeepSeek API，输出仍要被 validatePlan 卡住；失败自动降级到规则）
import { validatePlan } from './kernel/index.js';

const KEYWORDS = [
  { op: 'drop_outliers', words: ['异常', '离群', '野值', '剔除', '去掉'] },
  { op: 'transform_log', words: ['对数', 'log', 'ln', '指数'] },
  { op: 'correlate', words: ['相关', '关系', '关联', '趋势', '负相关', '正相关'] },
  { op: 'fit_linear', words: ['拟合', '回归', '斜率', '方程', '线性'] },
  { op: 'scatter', words: ['图', '画', '可视化', '散点', '绘图', '放进报告'] },
];

export function pickColumns(dataset, question) {
  const numeric = dataset.columns.filter((c) => c.kind === 'number');
  const mentioned = numeric.filter((c) => question.includes(c.name));
  const x = mentioned[0]?.name || numeric[0]?.name;
  const y = mentioned[1]?.name || mentioned[0]?.name === x ? (mentioned[1]?.name || numeric[1]?.name || numeric[0]?.name) : (mentioned[1]?.name || numeric[1]?.name);
  return { x, y: y || x };
}

export function compileByRules(dataset, question) {
  const hits = new Set();
  for (const { op, words } of KEYWORDS) if (words.some((w) => question.toLowerCase().includes(w))) hits.add(op);

  const nums = dataset.columns.filter((c) => c.kind === 'number');
  if (nums.length < 2) throw new Error('至少需要两列数值才能做趋势分析');
  const mentioned = nums.filter((c) => question.includes(c.name));
  const x = mentioned[0]?.name || nums[0].name;
  const y = mentioned[1]?.name || nums[1].name;

  const wantLog = hits.has('transform_log');
  const steps = [];

  steps.push({ id: 's1', op: 'describe', params: { column: y } });

  if (hits.has('drop_outliers')) {
    steps.push({ id: `s${steps.length + 1}`, op: 'drop_outliers', params: { column: y, k: 1.5, confirm: true } });
  }
  if (wantLog) {
    steps.push({ id: `s${steps.length + 1}`, op: 'transform_log', params: { column: y } });
  }
  if (hits.has('correlate') || wantLog) {
    steps.push({ id: `s${steps.length + 1}`, op: 'correlate', params: { x, y, ...(wantLog ? { transformY: 'ln' } : {}) } });
  }
  if (hits.has('fit_linear') || wantLog) {
    steps.push({ id: `s${steps.length + 1}`, op: 'fit_linear', params: { x, y, ...(wantLog ? { transformY: 'ln' } : {}) } });
  }
  if (hits.has('scatter') || hits.size === 0) {
    steps.push({ id: `s${steps.length + 1}`, op: 'scatter', params: { x, y, ...(wantLog ? { transformY: 'ln' } : {}) } });
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
      text: `${c.x} 与 ${c.transformY === 'ln' ? 'ln ' : ''}${c.y} 呈${c.strength}${c.direction}（r = {{r}}，n = {{n}}，p = {{p}}）`,
      refs: [
        { stepId: corr.id, field: 'r', value: c.r },
        { stepId: corr.id, field: 'n', value: c.n },
        { stepId: corr.id, field: 'p', value: c.p },
      ],
      verdict: c.significant ? '显著（p < 0.05）' : '不显著（p ≥ 0.05）',
    });
  }
  if (fit) {
    const f = fit.output;
    claims.push({
      id: 'c2',
      text: `拟合结果：${f.transformY === 'ln' ? 'ln ' : ''}${f.y} = {{intercept}} + {{slope}} × ${f.x}，R² = {{r2}}`,
      refs: [
        { stepId: fit.id, field: 'slope', value: f.slope },
        { stepId: fit.id, field: 'intercept', value: f.intercept },
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
    return formatNumber(actual);
  });
}

function resolveField(output, field) {
  if (field === 'count') return output.outliers ? output.outliers.length : undefined;
  return output[field];
}

function formatNumber(v) {
  if (typeof v !== 'number') return String(v);
  if (Math.abs(v) !== 0 && (Math.abs(v) < 1e-4 || Math.abs(v) >= 1e6)) return v.toExponential(3);
  return String(Number(v.toFixed(4)));
}

/** LLM 编译：给模型强约束的 schema，返回后仍要过 validatePlan */
export async function compileByLLM({ dataset, question, endpoint, apiKey, model = 'deepseek-chat' }) {
  const columns = dataset.columns.map((c) => `${c.name}(${c.kind})`).join(', ');
  const prompt = `你是数据分析计划编译器。只输出 JSON，不要解释。
可用算子（白名单，禁止其他）：
describe{column} / drop_outliers{column,k,confirm} / transform_log{column} / correlate{x,y,transformY?} / fit_linear{x,y,transformY?} / scatter{x,y,transformY?}
字段说明：column/x/y 必须是下面列名之一；transformY 只能是 "ln" 或省略；drop_outliers 必须带 "confirm": true。
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
