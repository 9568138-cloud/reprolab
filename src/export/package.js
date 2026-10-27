// 复现包：原始数据（含哈希）+ 计划 + 结果 + 报告 + 自带校验脚本
// 设计原则：解压后不依赖网络、不依赖 ReproLab 界面，`node verify.mjs` 就能验真伪。
import { sha256, stableStringify } from '../kernel/hash.js';
import { canonicalArtifact } from '../kernel/index.js';
import { OPERATORS } from '../kernel/ops.js';
import { renderClaim } from '../planner.js';

export async function buildReproducePackage({ rawCsv, dataset, plan, run, claims, meta = {} }) {
  const dataHash = await sha256(rawCsv);
  const rendered = claims.map((c) => ({ ...c, text: renderClaim(c, run.steps) }));
  const artifact = canonicalArtifact(plan, run.steps, run.droppedRows);
  const generatedAt = new Date().toISOString();

  const report = [
    '# 分析报告（可溯源）',
    '',
    `- 问题：${plan.question || '（未填写）'}`,
    `- 生成时间：${generatedAt}`,
    `- 原始数据 SHA-256：\`${dataHash}\``,
    `- 数据规模：${dataset.rowCount} 行 × ${dataset.columns.length} 列（${dataset.columns.map((c) => c.name).join(', ')}）`,
    `- 计划编译方式：${plan.engine === 'llm' ? 'LLM（已通过白名单校验）' : '规则编译（离线、确定性）'}`,
    `- 产物总哈希：\`${run.artifactHash}\``,
    '',
    '## 结论（每条都能回溯到计算步骤）',
    '',
    ...rendered.map((c, i) => `${i + 1}. ${c.text}\n   - 出处：${c.refs.map((r) => `${r.stepId}.${r.field}`).join('、')}　判定：${c.verdict}`),
    '',
    '## 步骤时间轴',
    '',
    '| # | 算子 | 参数 | 输入哈希 | 输出哈希 | 耗时(ms) |',
    '| --: | :-- | :-- | :-- | :-- | --: |',
    ...run.steps.map((s, i) => `| ${i + 1} | ${s.label} | \`${stableStringify(s.params)}\` | \`${s.inputHash.slice(0, 12)}\` | \`${s.outputHash.slice(0, 12)}\` | ${s.ms} |`),
    '',
    run.droppedRows?.length ? `> 本计划删除了 ${run.droppedRows.length} 行原始数据（CSV 行号：${run.droppedRows.join(', ')}），删了什么可在这里核对。` : '> 本计划未删除任何原始数据行。',
    '',
    '## 如何复现（两种，任选其一）',
    '',
    '**A. 离线自校验（不需要装任何东西，只要有 Node.js）**',
    '',
    '```bash',
    'node verify.mjs',
    '# 期望输出：全部 PASS，退出码 0',
    '```',
    '',
    '`verify.mjs` 会做三件事：① 重算 `data.csv` 的 SHA-256 与包内记录比对；② 用 `plan.json` + `run.json` 重建产物指纹并重算哈希；③ 校验计划是否越出算子白名单。',
    '',
    '**B. 在界面里重跑（看交互与可视化）**',
    '',
    '1. 打开 ReproLab，导入本包里的 `data.csv`；',
    '2. 把 `plan.json` 里的 `steps` 直接执行（或按原问题重新编译后对比）；',
    '3. 点「重跑一致性校验」，产物总哈希应与上面一致 —— 一致即逐位复现。',
    '',
    '## 文件清单',
    '',
    '| 文件 | 说明 |',
    '| :-- | :-- |',
    '| `data.csv` | 原始数据（只读拷贝，哈希记录在 `meta.json`） |',
    '| `plan.json` | 分析计划 DSL（白名单算子 + 参数） |',
    '| `run.json` | 执行记录：每步输入/输出哈希、耗时、完整输出、产物总哈希 |',
    '| `meta.json` | 数据哈希、产物哈希、生成时间、编译器 |',
    '| `report.md` | 本报告 |',
    '| `verify.mjs` | 零依赖自校验脚本 |',
    '',
  ].join('\n');

  const files = [
    { name: 'data.csv', text: rawCsv },
    { name: 'plan.json', text: JSON.stringify(plan, null, 2) },
    {
      name: 'run.json',
      text: JSON.stringify({
        artifactHash: run.artifactHash,
        droppedRows: run.droppedRows || [],
        steps: run.steps.map(publicStep),
      }, null, 2),
    },
    {
      name: 'meta.json',
      text: JSON.stringify({
        ...meta,
        dataHash,
        artifactHash: run.artifactHash,
        generatedAt,
        reprolab: '1.1.0',
        planEngine: plan.engine,
      }, null, 2),
    },
    { name: 'report.md', text: report },
    { name: 'verify.mjs', text: verifyScript() },
  ];
  return { files, report, dataHash, artifactHash: run.artifactHash, artifact, claims: rendered };
}

function publicStep(s) {
  return { id: s.id, op: s.op, params: s.params, inputHash: s.inputHash, outputHash: s.outputHash, ms: s.ms, output: s.output };
}

/** 生成零依赖校验脚本：只用 node 内置模块，逻辑与 src/kernel/index.js 的指纹口径一致 */
export function verifyScript() {
  return `// ReproLab 复现包自校验：node verify.mjs
// 不联网、不装依赖，只做三件事：
//   1) 重算 data.csv 的 SHA-256，与 meta.json 记录比对；
//   2) 用 plan.json + run.json 重建产物指纹，重算哈希，与 run.json 记录比对；
//   3) 检查计划里的算子是否越出白名单。
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const readText = (f) => readFileSync(new URL('./' + f, import.meta.url), 'utf8');
const readJson = (f) => JSON.parse(readText(f));

// 与 src/kernel/hash.js 完全一致的稳定序列化（键排序，保证换机器换语言也同结果）
function stable(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
}
const sha = (s) => createHash('sha256').update(s).digest('hex');

const WHITELIST = ${JSON.stringify(Object.keys(OPERATORS))};
const results = [];
const check = (name, pass, detail) => results.push({ name, pass, detail });

const data = readFileSync(new URL('./data.csv', import.meta.url));
const plan = readJson('plan.json');
const run = readJson('run.json');
const meta = readJson('meta.json');

// 1) 数据未被改动
const dataHash = createHash('sha256').update(data).digest('hex');
check('数据 SHA-256 与包内记录一致', dataHash === meta.dataHash, dataHash.slice(0, 16) + '…');

// 2) 产物指纹可重算（这一步能抓出“改了 run.json 里的数字”）
const artifact = {
  plan: {
    version: plan.version,
    question: plan.question || '',
    steps: plan.steps.map((s) => ({ id: s.id, op: s.op, params: s.params || {} })),
  },
  outputs: run.steps.map((s) => ({ id: s.id, op: s.op, output: s.output })),
  droppedRows: run.droppedRows || [],
};
const recomputed = sha(stable(artifact));
check('产物哈希可重算（执行记录未被篡改）', recomputed === run.artifactHash, recomputed.slice(0, 16) + '…');
check('meta.json 与 run.json 的产物哈希一致', meta.artifactHash === run.artifactHash, run.artifactHash.slice(0, 12) + '…');

// 3) 计划没有越出白名单
const badOps = plan.steps.filter((s) => !WHITELIST.includes(s.op)).map((s) => s.op);
check('计划只使用白名单算子', badOps.length === 0, badOps.length ? '越界：' + badOps.join(',') : WHITELIST.length + ' 个算子内');
const noConfirm = plan.steps.filter((s) => s.op === 'drop_outliers' && s.params?.confirm !== true);
check('破坏性算子已人工确认', noConfirm.length === 0, noConfirm.length ? '缺少 confirm' : '通过');

const failed = results.filter((r) => !r.pass);
for (const r of results) console.log((r.pass ? 'PASS  ' : 'FAIL  ') + r.name + '  [' + r.detail + ']');
console.log('');
console.log('产物总哈希：' + run.artifactHash);
if (failed.length) {
  console.log('');
  console.log('✗ ' + failed.length + ' 项未通过：包内容与记录不一致，请勿直接采信。');
  process.exit(1);
}
console.log('✓ 全部通过：数据未改动、执行记录可重算、计划在白名单内。');
`;
}
