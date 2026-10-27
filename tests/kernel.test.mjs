import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { toDataset } from '../src/kernel/csv.js';
import { executePlan, validatePlan, PlanError, canonicalArtifact } from '../src/kernel/index.js';
import { compileByRules, buildClaims, renderClaim } from '../src/planner.js';
import { sha256, stableStringify } from '../src/kernel/hash.js';
import { buildReproducePackage } from '../src/export/package.js';

const csv = readFileSync(new URL('../sample-data/thermal.csv', import.meta.url), 'utf8');

test('CSV 解析：列类型识别', () => {
  const ds = toDataset(csv);
  assert.equal(ds.columns.length, 3);
  assert.equal(ds.columns[0].name, 'temp_c');
  assert.equal(ds.columns[0].kind, 'number');
  assert.ok(ds.rowCount > 40);
});

test('规则编译：能识别异常点 / 趋势 / 出图意图', () => {
  const ds = toDataset(csv);
  const plan = compileByRules(ds, '温度升高是不是让阻值下降？两者相关性如何？有没有要去掉的异常点？帮我出一张图');
  const ops = plan.steps.map((s) => s.op);
  assert.ok(ops.includes('drop_outliers'));
  assert.ok(ops.includes('correlate'));
  assert.ok(ops.includes('scatter'));
  assert.equal(plan.steps.find((s) => s.op === 'drop_outliers').params.confirm, true);
});

test('白名单：未知算子被拒绝', () => {
  const ds = toDataset(csv);
  assert.throws(() => validatePlan({ version: 1, steps: [{ id: 's1', op: 'exec_python', params: {} }] }, ds), PlanError);
});

test('破坏性算子必须 confirm', () => {
  const ds = toDataset(csv);
  assert.throws(() => validatePlan({ version: 1, steps: [{ id: 's1', op: 'drop_outliers', params: { column: 'resistance_kohm' } }] }, ds), /confirm/);
});

test('执行：可复现（同一计划两次产物哈希一致）', async () => {
  const ds = toDataset(csv);
  const plan = compileByRules(ds, '温度和阻值的关系？剔除异常点并出图');
  const a = await executePlan(plan, ds);
  const b = await executePlan(plan, ds);
  assert.equal(a.artifactHash, b.artifactHash);
  assert.equal(a.steps.length, plan.steps.length);
});

test('异常点剔除：示例数据应检出并剔除离群行', async () => {
  const ds = toDataset(csv);
  const plan = compileByRules(ds, '有没有要去掉的异常点');
  const run = await executePlan(plan, ds);
  const step = run.steps.find((s) => s.op === 'drop_outliers');
  assert.ok(step, '计划里应有 drop_outliers');
  assert.ok(step.output.outliers.length >= 1, '示例数据至少 1 个异常点');
  assert.ok(step.output.removed >= 1);
});

test('相关性：先剔异常点、再对数变换，应显著负相关', async () => {
  const ds = toDataset(csv);
  const plan = compileByRules(ds, '温度升高阻值下降，有异常点要剔除，做对数变换看相关性');
  const run = await executePlan(plan, ds);
  const corr = run.steps.find((s) => s.op === 'correlate');
  assert.ok(corr);
  assert.ok(corr.output.r < -0.95, `剔除异常点后 r 应接近 -1，实际 ${corr.output.r}`);
  assert.ok(corr.output.p < 0.001);
});

test('相关性：不剔除异常点会拉低 r（证明异常处理是必要的）', async () => {
  const ds = toDataset(csv);
  const plan = compileByRules(ds, '温度与阻值的相关性');
  const run = await executePlan(plan, ds);
  const corr = run.steps.find((s) => s.op === 'correlate');
  assert.ok(corr);
  assert.ok(corr.output.r > -0.95, `不剔除时 r 应明显偏离 -1，实际 ${corr.output.r}`);
});

test('结论溯源：引用缺失字段必须报错', () => {
  const claims = [{ id: 'c1', text: 'r = {{r}}', refs: [{ stepId: 's9', field: 'r', value: 1 }] }];
  assert.throws(() => renderClaim(claims[0], []), /步骤不存在/);
});

test('结论绑定真实数字', async () => {
  const ds = toDataset(csv);
  const plan = compileByRules(ds, '温度和阻值的关系');
  const run = await executePlan(plan, ds);
  const claims = buildClaims(plan, run.steps);
  const text = renderClaim(claims[0], run.steps);
  assert.ok(/r = -0\.\d+/.test(text) || /r = -1/.test(text), `实际：${text}`);
});

test('剔除清单：删掉的行号与记录一致，且后续步骤只用剩下的行', async () => {
  const ds = toDataset(csv);
  const plan = compileByRules(ds, '温度与阻值的关系，有异常点就剔除');
  const run = await executePlan(plan, ds);
  const out = run.steps.find((s) => s.op === 'drop_outliers');
  assert.equal(run.droppedRows.length, out.output.removed);
  assert.deepEqual([...run.droppedRows].sort((a, b) => a - b), [...out.output.outliers.map((o) => o.row)].sort((a, b) => a - b));
  const corr = run.steps.find((s) => s.op === 'correlate');
  assert.equal(corr.output.n, ds.rowCount - run.droppedRows.length, '相关性样本数应等于总行数减被删行数');
});

test('描述统计：删行之后按剩下的行算', async () => {
  const ds = toDataset(csv);
  const plan = {
    version: 1,
    question: '先删后描述',
    steps: [
      { id: 's1', op: 'drop_outliers', params: { column: 'resistance_kohm', k: 1.5, confirm: true } },
      { id: 's2', op: 'describe', params: { column: 'resistance_kohm' } },
    ],
  };
  const run = await executePlan(plan, ds);
  const desc = run.steps[1].output;
  assert.equal(desc.rowsUsed, ds.rowCount - run.droppedRows.length);
  assert.equal(desc.stats.n, ds.rowCount - run.droppedRows.length);
});

test('健壮性：中文列名、空值、单列数据的提示', async () => {
  const cn = toDataset('温度,阻值\n20,10.1\n22,9.4\n24,9.0\n26,8.5\n28,8.2');
  assert.deepEqual(cn.columns.map((c) => c.name), ['温度', '阻值']);
  const run = await executePlan(compileByRules(cn, '温度和阻值的关系，出图'), cn);
  assert.equal(run.artifactHash.length, 64);

  const withNull = toDataset('temp,res\n20,10.1\n22,\n24,9.0\n26,8.5');
  assert.equal(withNull.rowCount, 4);
  const run2 = await executePlan(compileByRules(withNull, '相关性'), withNull);
  const corr = run2.steps.find((s) => s.op === 'correlate');
  assert.equal(corr.output.n, 3, '空值行不参与相关性计算');

  const single = toDataset('x\n1\n2\n3');
  assert.throws(() => compileByRules(single, '相关性'), /至少需要两列数值/);
});

test('健壮性：空文件与只有表头都会给出可读错误', () => {
  assert.throws(() => toDataset(''), /表头和一行数据/);
  assert.throws(() => toDataset('a,b'), /表头和一行数据/);
});

test('复现包：文件齐全，产物指纹可独立重算', async () => {
  const ds = toDataset(csv);
  const plan = compileByRules(ds, '温度和阻值的关系，剔除异常点，出图');
  const run = await executePlan(plan, ds);
  const claims = buildClaims(plan, run.steps);
  const pkg = await buildReproducePackage({ rawCsv: csv, dataset: ds, plan, run, claims, meta: {} });
  const names = pkg.files.map((f) => f.name);
  for (const need of ['data.csv', 'plan.json', 'run.json', 'meta.json', 'report.md', 'verify.mjs']) {
    assert.ok(names.includes(need), `复现包缺少 ${need}`);
  }
  const recomputed = await sha256(stableStringify(canonicalArtifact(plan, run.steps, run.droppedRows)));
  assert.equal(recomputed, run.artifactHash, '复现包里的产物哈希必须能用 plan+run 重算出来');
  assert.equal(pkg.dataHash, await sha256(csv), '数据哈希必须等于原始 CSV 的 SHA-256');
  const runJson = JSON.parse(pkg.files.find((f) => f.name === 'run.json').text);
  assert.equal(runJson.artifactHash, run.artifactHash);
  assert.deepEqual(runJson.droppedRows, run.droppedRows);
  assert.ok(pkg.files.find((f) => f.name === 'verify.mjs').text.includes('WHITELIST'), 'verify.mjs 应自带白名单校验');
});

// ---------- 审计模式 ----------
import { auditReport, auditToMarkdown, compareValue } from '../src/audit.js';

test('审计：四舍五入差异算通过，人为改数算不符', () => {
  assert.equal(compareValue(-0.9635, -0.963531).ok, true, '4 位四舍五入应通过');
  assert.equal(compareValue(2, 2).ok, true);
  assert.equal(compareValue(3, 2).ok, false);
  assert.equal(compareValue(-0.9585, -0.963531).ok, false, '改动 0.005 必须被判不符');
});

test('审计：逐条重算，给出 通过/不符/无法复现 三态', async () => {
  const ds = toDataset(csv);
  const plan = compileByRules(ds, '温度和阻值的关系，剔除异常点，出图');
  const run = await executePlan(plan, ds);
  const claims = [
    { id: 'a', text: 'r 一致', stepId: 's3', field: 'r', value: Number(run.steps.find((s) => s.op === 'correlate').output.r.toFixed(4)) },
    { id: 'b', text: '异常点个数被改', stepId: 's2', field: 'count', value: 99 },
    { id: 'c', text: '引用了不存在的步骤', stepId: 's99', field: 'r', value: 1 },
  ];
  const { results, summary } = await auditReport({ dataset: ds, plan, claims, expectedArtifactHash: run.artifactHash });
  assert.deepEqual(results.map((r) => r.verdict), ['ok', 'mismatch', 'unreproducible']);
  assert.equal(summary.ok, 1);
  assert.equal(summary.mismatch, 1);
  assert.equal(summary.unreproducible, 1);
  assert.equal(summary.hashMatches, true);
  assert.equal(summary.passed, false);
});

test('审计：声明的产物哈希对不上时整体不通过', async () => {
  const ds = toDataset(csv);
  const plan = compileByRules(ds, '温度和阻值的关系');
  const run = await executePlan(plan, ds);
  const { summary } = await auditReport({
    dataset: ds, plan,
    claims: [{ text: 'r', stepId: 's2', field: 'r', value: Number(run.steps[1].output.r.toFixed(4)) }],
    expectedArtifactHash: 'deadbeef',
  });
  assert.equal(summary.hashMatches, false);
  assert.equal(summary.passed, false);
});

test('审计报告：Markdown 里三种判定都在', async () => {
  const ds = toDataset(csv);
  const plan = compileByRules(ds, '温度和阻值的关系，剔除异常点');
  const run = await executePlan(plan, ds);
  const claims = [
    { text: '正常条目', stepId: 's2', field: 'removed', value: 99 },
    { text: '缺步骤', stepId: 's77', field: 'x', value: 1 },
  ];
  const { results, summary } = await auditReport({ dataset: ds, plan, claims });
  const md = auditToMarkdown({ summary, results });
  assert.ok(md.includes('不符'));
  assert.ok(md.includes('无法复现'));
  assert.ok(md.includes('审计结论'));
});

// ---------- 第二批算子（分组 / t 检验 / 分布 / 趋势 / 缺失） ----------
const batteryCsv = readFileSync(new URL('../sample-data/battery.csv', import.meta.url), 'utf8');

test('分组汇总：空单元格算缺失，不能当 0（回归测试）', async () => {
  const ds = toDataset(batteryCsv);
  const plan = { version: 1, steps: [{ id: 's1', op: 'group_summary', params: { groupBy: 'group', column: 'capacity_mah' } }] };
  const run = await executePlan(plan, ds);
  const o = run.steps[0].output;
  assert.equal(o.groupCount, 2);
  const a = o.groups.find((g) => g.group === 'A');
  const b = o.groups.find((g) => g.group === 'B');
  assert.equal(a.n, 20, 'A 组没有缺失值');
  assert.equal(b.n, 16, 'B 组 4 个空单元格必须被排除，而不是算成 0');
  assert.ok(b.mean > 2900 && b.mean < 3000, `B 组均值应在 2900-3000，实际 ${b.mean}`);
});

test('两组检验：A 组容量显著高于 B 组', async () => {
  const ds = toDataset(batteryCsv);
  const plan = { version: 1, steps: [{ id: 's1', op: 'ttest', params: { groupBy: 'group', column: 'capacity_mah' } }] };
  const run = await executePlan(plan, ds);
  const o = run.steps[0].output;
  assert.equal(o.groupA, 'A');
  assert.equal(o.groupB, 'B');
  assert.ok(o.diff > 40 && o.diff < 50, `均值差应约 45，实际 ${o.diff}`);
  assert.ok(o.p < 0.01, `p 应显著，实际 ${o.p}`);
  assert.equal(o.significant, true);
});

test('分布直方图：各箱计数之和等于有效样本数', async () => {
  const ds = toDataset(batteryCsv);
  const plan = { version: 1, steps: [{ id: 's1', op: 'histogram', params: { column: 'capacity_mah', bins: 5 } }] };
  const run = await executePlan(plan, ds);
  const o = run.steps[0].output;
  const sum = o.bins.reduce((s, b) => s + b.count, 0);
  assert.equal(sum, o.n);
  assert.equal(o.n, 36, '40 行减去 4 个缺失');
});

test('缺失值盘点与时间趋势', async () => {
  const ds = toDataset(batteryCsv);
  const plan = { version: 1, steps: [
    { id: 's1', op: 'missing_report', params: { column: 'capacity_mah' } },
    { id: 's2', op: 'trend', params: { column: 'internal_mohm' } },
  ] };
  const run = await executePlan(plan, ds);
  const missing = run.steps[0].output;
  assert.equal(missing.missing, 4);
  assert.equal(missing.rate, 0.1);
  const trend = run.steps[1].output;
  assert.ok(trend.slope > 0, '内阻随循环次数上升');
  assert.ok(trend.r2 > 0.5, '交替分组的噪声会拉低 R²，但仍应明显');
});

test('规则编译：一句话能同时点亮 分组/检验/缺失 三个算子', async () => {
  const ds = toDataset(batteryCsv);
  const plan = compileByRules(ds, 'A 组和 B 组的容量有没有显著差异？各组分别是什么水平？有缺失值吗？');
  const ops = plan.steps.map((s) => s.op);
  assert.ok(ops.includes('missing_report'));
  assert.ok(ops.includes('group_summary'));
  assert.ok(ops.includes('ttest'));
  const run = await executePlan(plan, ds);
  const claims = buildClaims(plan, run.steps);
  assert.ok(claims.length >= 3);
  for (const c of claims) renderClaim(c, run.steps);
});
