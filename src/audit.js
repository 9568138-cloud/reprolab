// 审计层：把「报告里写的结论」重新算一遍，逐条判定是否成立
//
// 定位：分析模式是「我帮你算」，审计模式是「我替你验」——
//       给你一份别人（或你上个月自己）写的报告 + 原始数据，逐条重算，
//       告诉你哪条对得上、哪条对不上、哪条根本无法复现。
//
// 依赖内核的确定性执行：同一数据 + 同一计划 → 同一产物哈希，所以「重算」是可信的。
import { executePlan } from './kernel/index.js';

// 报告里的数字通常四舍五入到 4 位，允许 0.1% 的相对误差；
// 人为改数（比如 -0.9585 写成 -0.9635）差异远大于此，仍然会被抓住。
const DEFAULT_TOL = 1e-3;

/** 从执行结果里取字段；count 视为 outliers 的长度 */
export function resolveStepField(step, field) {
  if (!step || !step.output) return undefined;
  if (field === 'count') return Array.isArray(step.output.outliers) ? step.output.outliers.length : undefined;
  return step.output[field];
}

/** 数值按相对容差比较，非数值按字符串严格比较 */
export function compareValue(expected, actual, tol = DEFAULT_TOL) {
  if (typeof expected === 'number' && typeof actual === 'number') {
    const diff = Math.abs(expected - actual);
    const scale = Math.max(1, Math.abs(expected), Math.abs(actual));
    return { ok: diff <= Math.max(tol, tol * scale), diff, kind: 'number' };
  }
  return { ok: String(expected) === String(actual), diff: null, kind: 'text' };
}

/**
 * 审计一份报告
 * @param {object} p
 * @param {object} p.dataset  toDataset() 的结果
 * @param {object} p.plan     产出这份报告的分析计划
 * @param {Array<{id?:string,text:string,stepId:string,field:string,value:any}>} p.claims 报告里的结论条目
 * @param {string} [p.expectedArtifactHash] 报告里声明的产物哈希（可选）
 */
export async function auditReport({ dataset, plan, claims, expectedArtifactHash, tol = DEFAULT_TOL }) {
  if (!dataset) throw new Error('缺少数据集');
  if (!plan) throw new Error('缺少分析计划');
  if (!Array.isArray(claims) || claims.length === 0) throw new Error('报告里没有可审计的结论条目');

  const run = await executePlan(plan, dataset);
  const byId = new Map(run.steps.map((s) => [s.id, s]));

  const results = claims.map((claim, i) => {
    const base = {
      id: claim.id || `c${i + 1}`,
      text: claim.text || '（无正文）',
      stepId: claim.stepId,
      field: claim.field,
      declared: claim.value,
    };
    const step = byId.get(claim.stepId);
    if (!step) {
      return { ...base, verdict: 'unreproducible', reason: `计划里没有步骤 ${claim.stepId}`, actual: undefined, diff: null };
    }
    const actual = resolveStepField(step, claim.field);
    if (actual === undefined || actual === null) {
      return { ...base, verdict: 'unreproducible', reason: `步骤 ${claim.stepId} 没有字段 ${claim.field}`, actual, diff: null };
    }
    const cmp = compareValue(claim.value, actual, tol);
    const textCheck = typeof claim.value === 'number' ? textMatchesValue(base.text, claim.value, tol) : { checked: false, ok: true };
    if (cmp.ok && textCheck.checked && !textCheck.ok) {
      return {
        ...base,
        actual,
        diff: cmp.diff,
        verdict: 'mismatch',
        reason: `正文里的数字与声明值不一致（正文出现 ${textCheck.numbers.join('、')}，声明 ${fmt(claim.value)}）`,
        textCheck,
      };
    }
    return {
      ...base,
      actual,
      diff: cmp.diff,
      verdict: cmp.ok ? 'ok' : 'mismatch',
      reason: cmp.ok ? '重算值与报告一致' : `重算值 ${fmt(actual)} ≠ 报告值 ${fmt(claim.value)}`,
      textCheck,
    };
  });

  const hashMatches = expectedArtifactHash ? expectedArtifactHash === run.artifactHash : null;

  const summary = {
    total: results.length,
    ok: results.filter((r) => r.verdict === 'ok').length,
    mismatch: results.filter((r) => r.verdict === 'mismatch').length,
    unreproducible: results.filter((r) => r.verdict === 'unreproducible').length,
    artifactHash: run.artifactHash,
    hashMatches,
    passed: results.every((r) => r.verdict === 'ok') && hashMatches !== false,
  };
  return { run, results, summary };
}

function fmt(v) {
  if (typeof v !== 'number') return String(v);
  return String(Number(v.toFixed(6)));
}

/** 把结论文本里的数字抓出来（含小数位数），用于「正文 vs 声明值」交叉检查 */
export function numbersInText(text) {
  const out = [];
  const re = /-?\d+(?:\.\d+)?/g;
  let m;
  while ((m = re.exec(String(text || ''))) !== null) {
    const raw = m[0];
    const decimals = raw.includes('.') ? raw.split('.')[1].length : 0;
    out.push({ value: Number(raw), decimals });
  }
  return out;
}

/**
 * 正文里的数字能不能对上声明值：
 *   正文没写数字 → 不检查（checked=false）
 *   有一个数字与声明值在容差内（或按正文精度四舍五入相等）→ 通过
 *   否则 → 判为正文与数值自相矛盾
 */
export function textMatchesValue(text, value, tol = DEFAULT_TOL) {
  const nums = numbersInText(text);
  if (!nums.length) return { checked: false, ok: true, numbers: [] };
  for (const n of nums) {
    if (Math.abs(n.value - value) <= Math.max(1e-9, Math.abs(value) * tol)) return { checked: true, ok: true, numbers: nums.map((x) => x.value) };
    if (n.decimals > 0 && Number(Number(value).toFixed(Math.min(6, n.decimals))) === n.value) {
      return { checked: true, ok: true, numbers: nums.map((x) => x.value) };
    }
  }
  return { checked: true, ok: false, numbers: nums.map((x) => x.value) };
}

/** 审计结果 → Markdown 报告（可贴进文档，或用浏览器打印成 PDF） */
export function auditToMarkdown({ title = '报告审计结果', summary, results }) {
  const badge = { ok: '通过', mismatch: '不符', unreproducible: '无法复现' };
  const lines = [
    `# ${title}`,
    '',
    `- 审计结论：${summary.passed ? '✅ 全部通过' : '❌ 存在不通过的条目'}`,
    `- 条目：${summary.total}（通过 ${summary.ok} / 不符 ${summary.mismatch} / 无法复现 ${summary.unreproducible}）`,
    `- 重算产物哈希：\`${summary.artifactHash}\``,
  ];
  if (summary.hashMatches !== null) lines.push(`- 报告声明哈希：${summary.hashMatches ? '一致' : '**不一致**'}`);
  lines.push('', '| # | 结论 | 报告值 | 重算值 | 判定 |', '| --: | :-- | --: | --: | :-- |');
  results.forEach((r, i) => {
    lines.push(`| ${i + 1} | ${r.text.replace(/\|/g, '\\|')} | ${fmt(r.declared)} | ${r.actual === undefined ? '—' : fmt(r.actual)} | ${badge[r.verdict]} |`);
  });
  return lines.join('\n') + '\n';
}

// ---------------- 批量审计：一个实验室交来 N 份报告，一次审完 ----------------

/**
 * 把多份报告的审计结果汇总成一张表（纯函数，界面与 CLI 共用）
 * @param {Array<{title?:string, summary:object}>} entries 每份报告的标题与 auditReport().summary
 * @param {{dataName?:string}} [meta]
 */
export function summarizeAudits(entries, { dataName = '' } = {}) {
  const reports = (entries || []).map((e, i) => {
    const s = e.summary || {};
    return {
      title: e.title || `报告 ${i + 1}`,
      total: Number(s.total) || 0,
      ok: Number(s.ok) || 0,
      mismatch: Number(s.mismatch) || 0,
      unreproducible: Number(s.unreproducible) || 0,
      passed: !!s.passed,
      artifactHash: s.artifactHash || '',
      hashMatches: s.hashMatches === undefined ? null : s.hashMatches,
    };
  });
  const sum = (k) => reports.reduce((a, r) => a + r[k], 0);
  const agg = {
    reports: reports.length,
    claims: sum('total'),
    ok: sum('ok'),
    mismatch: sum('mismatch'),
    unreproducible: sum('unreproducible'),
    failedReports: reports.filter((r) => !r.passed).length,
    dataName,
  };
  // 空集合不算通过：没有报告就没有可下的结论
  return { ...agg, passed: reports.length > 0 && agg.failedReports === 0, entries: reports };
}

/** 批量审计汇总 → Markdown（贴进整改通知或直接打印） */
export function auditBatchToMarkdown({ summary, title = '批量审计汇总' }) {
  const lines = [
    `# ${title}`,
    '',
    `- 报告数：${summary.reports}`,
    `- 结论数：${summary.claims}（通过 ${summary.ok} / 不符 ${summary.mismatch} / 无法复现 ${summary.unreproducible}）`,
    `- 整体判定：${summary.passed ? '✅ 全部报告可复现' : `❌ ${summary.failedReports} 份报告存在问题`}`,
  ];
  if (summary.dataName) lines.push(`- 数据集：${summary.dataName}`);
  lines.push('', '| 报告 | 结论 | 通过 | 不符 | 无法复现 | 判定 |', '| :-- | --: | --: | --: | --: | :-- |');
  for (const r of summary.entries) {
    lines.push(`| ${String(r.title).replace(/\|/g, '\\|')} | ${r.total} | ${r.ok} | ${r.mismatch} | ${r.unreproducible} | ${r.passed ? '通过' : '不通过'} |`);
  }
  return lines.join('\n') + '\n';
}
