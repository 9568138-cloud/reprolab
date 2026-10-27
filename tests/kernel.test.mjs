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
