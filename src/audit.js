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
    return {
      ...base,
      actual,
      diff: cmp.diff,
      verdict: cmp.ok ? 'ok' : 'mismatch',
      reason: cmp.ok ? '重算值与报告一致' : `重算值 ${fmt(actual)} ≠ 报告值 ${fmt(claim.value)}`,
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
