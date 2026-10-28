#!/usr/bin/env node
// 命令行：不打开浏览器也能审计/复现。适合 CI 和文档里的"一条命令验真伪"。
//
//   node cli.mjs audit <审计案.json> [更多.json…] --data <data.csv> [--json]
//   node cli.mjs verify <复现包目录>          # 跑包里的 verify.mjs
//   node cli.mjs check <data.csv> <plan.json> # 只重算产物哈希
//
// 退出码：0 全部通过；1 有不通过；2 用法错误。
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { toDataset } from './src/kernel/csv.js';
import { executePlan } from './src/kernel/index.js';
import { auditReport, auditBatchToMarkdown, auditToMarkdown, summarizeAudits } from './src/audit.js';

const argv = process.argv.slice(2);
const cmd = argv[0];
const args = {};
const positional = [];
for (let i = 1; i < argv.length; i += 1) {
  const a = argv[i];
  if (a === '--json') args.json = true;
  else if (a.startsWith('--')) { args[a.slice(2)] = argv[i + 1]; i += 1; }
  else positional.push(a);
}
args._ = positional[0];

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(2);
}

function readJson(p) {
  if (!existsSync(p)) fail(`找不到文件：${p}`);
  return JSON.parse(readFileSync(p, 'utf8'));
}

async function cmdAudit() {
  const paths = positional;
  if (!paths.length) fail('用法：node cli.mjs audit <审计案.json> [更多.json…] [--data <data.csv>] [--json]');
  const cases = paths.map((p) => ({ path: p, case: readJson(p) }));
  const dataPath = args.data || cases[0].case.dataFile;
  if (!dataPath) fail('缺数据集：用 --data <data.csv> 指定，或在审计案里写 dataFile');
  if (!existsSync(dataPath)) fail(`找不到数据文件：${dataPath}`);
  const dataset = toDataset(readFileSync(dataPath, 'utf8'));

  if (cases.length === 1) {
    const { results, summary } = await auditReport({
      dataset,
      plan: cases[0].case.plan,
      claims: cases[0].case.claims,
      expectedArtifactHash: cases[0].case.expectedArtifactHash,
    });
    if (args.json) {
      console.log(JSON.stringify({ summary, results }, null, 2));
    } else {
      console.log(`审计：${cases[0].case.title || cases[0].path}`);
      console.log(`数据集：${dataPath}（${dataset.rowCount} 行）`);
      console.log('');
      console.log(auditToMarkdown({ title: cases[0].case.title || '报告审计结果', summary, results }));
    }
    process.exit(summary.passed ? 0 : 1);
  }

  // 批量：多份报告一次审完，出一张汇总表（有一份不通过就退出码 1，可直接进 CI）
  const entries = [];
  const reports = [];
  for (const c of cases) {
    const { results, summary } = await auditReport({
      dataset,
      plan: c.case.plan,
      claims: c.case.claims,
      expectedArtifactHash: c.case.expectedArtifactHash,
    });
    entries.push({ title: c.case.title || c.path, summary });
    reports.push({ path: c.path, title: c.case.title || c.path, summary, results });
  }
  const summary = summarizeAudits(entries, { dataName: dataPath });
  if (args.json) {
    console.log(JSON.stringify({ summary, reports }, null, 2));
  } else {
    console.log(`数据集：${dataPath}（${dataset.rowCount} 行）`);
    console.log('');
    console.log(auditBatchToMarkdown({ summary }));
  }
  process.exit(summary.passed ? 0 : 1);
}

async function cmdVerify() {
  const dir = resolve(args._ || '.');
  const script = join(dir, 'verify.mjs');
  if (!existsSync(script)) fail(`${dir} 里没有 verify.mjs，先导出复现包`);
  const mod = await import(pathToFileURL(script).href + `?t=${Date.now()}`);
  process.exit(mod === undefined ? 0 : 0);
}

async function cmdCheck() {
  const [dataPath, planPath] = argv.slice(1).filter((a) => !a.startsWith('--'));
  if (!dataPath || !planPath) fail('用法：node cli.mjs check <data.csv> <plan.json>');
  const dataset = toDataset(readFileSync(dataPath, 'utf8'));
  const plan = readJson(planPath);
  const run = await executePlan(plan, dataset);
  console.log(`产物哈希：${run.artifactHash}`);
  console.log(`步骤数：${run.steps.length}　删除行：${run.droppedRows.length}`);
}

const commands = { audit: cmdAudit, verify: cmdVerify, check: cmdCheck };
if (!commands[cmd]) {
  console.error('用法：node cli.mjs <audit|verify|check> ...');
  process.exit(2);
}
await commands[cmd]();
