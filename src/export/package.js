// 复现包：原始数据（含哈希）+ 计划 + 结果 + 报告 + 一致性校验脚本
import { sha256 } from '../kernel/hash.js';
import { renderClaim } from '../planner.js';

export async function buildReproducePackage({ rawCsv, dataset, plan, run, claims, meta = {} }) {
  const dataHash = await sha256(rawCsv);
  const rendered = claims.map((c) => ({ ...c, text: renderClaim(c, run.steps) }));

  const report = [
    '# 分析报告（可溯源）',
    '',
    `- 问题：${plan.question || '（未填写）'}`,
    `- 生成时间：${new Date().toISOString()}`,
    `- 原始数据 SHA-256：\`${dataHash}\``,
    `- 行数：${dataset.rowCount}　列：${dataset.columns.map((c) => c.name).join(', ')}`,
    `- 计划编译方式：${plan.engine === 'llm' ? 'LLM（已通过白名单校验）' : '规则编译（离线）'}`,
    '',
    '## 结论（每条都能回溯到计算步骤）',
    '',
    ...rendered.map((c, i) => `${i + 1}. ${c.text}`),
    '',
    '## 步骤时间轴',
    '',
    '| # | 算子 | 输入哈希 | 输出哈希 | 耗时(ms) |',
    '| --: | :-- | :-- | :-- | --: |',
    ...run.steps.map((s, i) => `| ${i + 1} | ${s.label} | \`${s.inputHash.slice(0, 12)}\` | \`${s.outputHash.slice(0, 12)}\` | ${s.ms} |`),
    '',
    `- 产物总哈希：\`${run.artifactHash}\``,
    '',
    '## 如何复现',
    '',
    '1. 打开 ReproLab，导入本包里的 `data.csv`；',
    '2. 粘贴 `plan.json` 里的计划直接执行（或按原问题重新编译后对比）；',
    '3. 对比"产物总哈希"是否与上面一致 —— 一致即逐位复现。',
    '',
  ].join('\n');

  const files = [
    { name: 'data.csv', text: rawCsv },
    { name: 'plan.json', text: JSON.stringify(plan, null, 2) },
    { name: 'run.json', text: JSON.stringify({ steps: run.steps.map(publicStep), artifactHash: run.artifactHash }, null, 2) },
    { name: 'report.md', text: report },
    { name: 'verify.mjs', text: verifyScript() },
    { name: 'meta.json', text: JSON.stringify({ ...meta, dataHash, artifactHash: run.artifactHash, generatedAt: new Date().toISOString(), reprolab: '1.0.0' }, null, 2) },
  ];
  return { files, report, dataHash, artifactHash: run.artifactHash, claims: rendered };
}

function publicStep(s) {
  return { id: s.id, op: s.op, params: s.params, inputHash: s.inputHash, outputHash: s.outputHash, ms: s.ms, output: s.output };
}

function verifyScript() {
  return `// 用 Node 直接校验：node verify.mjs
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { stableStringify } from './stable-json.mjs';

const run = JSON.parse(readFileSync(new URL('./run.json', import.meta.url), 'utf8'));
const plan = JSON.parse(readFileSync(new URL('./plan.json', import.meta.url), 'utf8'));
const data = readFileSync(new URL('./data.csv', import.meta.url));
console.log('数据哈希:', createHash('sha256').update(data).digest('hex'));
const rebuilt = JSON.stringify({ plan: run.steps.map((s) => ({ id: s.id, op: s.op, params: s.params })), outputs: run.steps.map((s) => ({ id: s.id, op: s.op, output: s.output })), droppedRows: [] });
console.log('产物哈希(简化校验):', createHash('sha256').update(stableStringify({ plan, outputs: run.steps.map((s) => ({ id: s.id, op: s.op, output: s.output })) })).digest('hex'));
console.log('包内记录:', run.artifactHash);
console.log('提示：完整一致性请用 ReproLab 重跑后对比"产物总哈希"。');
`;
}
