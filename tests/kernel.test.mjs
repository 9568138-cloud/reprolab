import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { toDataset } from '../src/kernel/csv.js';
import { executePlan, validatePlan, PlanError, canonicalArtifact } from '../src/kernel/index.js';
import { compileByRules, buildClaims, renderClaim, withoutDropOutliers } from '../src/planner.js';
import { sha256, stableStringify } from '../src/kernel/hash.js';
import { buildReproducePackage } from '../src/export/package.js';
import { auditReport, auditToMarkdown, compareValue } from '../src/audit.js';

const read = (f) => readFileSync(new URL(`../sample-data/${f}`, import.meta.url), 'utf8');
const iris = read('iris.csv');
const faithful = read('faithful.csv');
const airpassengers = read('airpassengers.csv');
const airquality = read('airquality.csv');
const ds = (csv) => toDataset(csv);

// ---------- 解析 ----------
test('CSV 解析：真实数据 iris 的列类型', () => {
  const d = ds(iris);
  assert.equal(d.rowCount, 150);
  assert.deepEqual(d.columns.map((c) => c.name), ['sepal_length_cm', 'sepal_width_cm', 'petal_length_cm', 'petal_width_cm', 'species']);
  assert.equal(d.columns.find((c) => c.name === 'species').kind, 'string');
  assert.equal(d.columns.filter((c) => c.kind === 'number').length, 4);
});

test('缺失标记归一：NA / 空串都算缺失，不会被当成 0 或字符串', () => {
  const d = ds('a,b\n1,NA\n2,\n3,5\n4,6\n');
  assert.equal(d.columns[1].kind, 'number');
  assert.equal(d.rows[0][1], '');
  assert.equal(d.rows[1][1], '');
  assert.equal(d.rowCount, 4);
});

test('健壮性：空文件与只有表头都会给出可读错误', () => {
  assert.throws(() => toDataset(''), /表头和一行数据/);
  assert.throws(() => toDataset('a,b'), /表头和一行数据/);
});

test('健壮性：中文列名可用，单列数据会明确拒绝', async () => {
  const cn = ds('温度,阻值\n20,10.1\n22,9.4\n24,9.0\n26,8.5');
  assert.deepEqual(cn.columns.map((c) => c.name), ['温度', '阻值']);
  const run = await executePlan(compileByRules(cn, '温度和阻值的关系，出图'), cn);
  assert.equal(run.artifactHash.length, 64);
  assert.throws(() => compileByRules(ds('x\n1\n2\n3'), '相关性'), /至少需要两列数值/);
});

// ---------- 计划校验 ----------
test('白名单：未知算子被拒绝', () => {
  assert.throws(() => validatePlan({ version: 1, steps: [{ id: 's1', op: 'exec_python', params: {} }] }, ds(iris)), PlanError);
});

test('白名单：列名不存在也要被拒绝', () => {
  assert.throws(
    () => validatePlan({ version: 1, steps: [{ id: 's1', op: 'describe', params: { column: '不存在的列' } }] }, ds(iris)),
    /不存在列/,
  );
});

test('破坏性算子必须 confirm', () => {
  assert.throws(
    () => validatePlan({ version: 1, steps: [{ id: 's1', op: 'drop_outliers', params: { column: 'sepal_width_cm' } }] }, ds(iris)),
    /confirm/,
  );
});

test('规则编译：一句话能点亮 相关/剔除/出图', () => {
  const plan = compileByRules(ds(iris), 'petal_length_cm 和 petal_width_cm 相关性如何？有异常点就剔除，再出一张图');
  const ops = plan.steps.map((s) => s.op);
  assert.ok(ops.includes('drop_outliers'));
  assert.ok(ops.includes('correlate'));
  assert.ok(ops.includes('scatter'));
  assert.equal(plan.steps.find((s) => s.op === 'drop_outliers').params.confirm, true);
});

test('规则编译：分组类意图需要文本列，没有就跳过而不是报错', () => {
  const plan = compileByRules(ds(faithful), '各组分别是什么水平');
  assert.ok(!plan.steps.some((s) => s.op === 'group_summary'), '没有文本列时不应生成分组步骤');
});

// ---------- 执行与复现 ----------
test('执行：同一数据 + 同一计划，两次产物哈希逐位一致', async () => {
  const d = ds(iris);
  const plan = compileByRules(d, 'petal_length_cm 和 petal_width_cm 的关系，出图');
  const a = await executePlan(plan, d);
  const b = await executePlan(plan, d);
  assert.equal(a.artifactHash, b.artifactHash);
  assert.equal(a.steps.length, plan.steps.length);
});

test('相关性：iris 花瓣长宽强正相关', async () => {
  const d = ds(iris);
  const run = await executePlan({ version: 1, steps: [{ id: 's1', op: 'correlate', params: { x: 'petal_length_cm', y: 'petal_width_cm' } }] }, d);
  const o = run.steps[0].output;
  assert.ok(o.r > 0.95, `r 应 > 0.95，实际 ${o.r}`);
  assert.equal(o.n, 150);
  assert.ok(o.p < 0.001);
});

test('分组汇总：iris 三个物种各 50 个，均值排序合理', async () => {
  const d = ds(iris);
  const run = await executePlan({ version: 1, steps: [{ id: 's1', op: 'group_summary', params: { groupBy: 'species', column: 'petal_length_cm' } }] }, d);
  const o = run.steps[0].output;
  assert.equal(o.groupCount, 3);
  assert.deepEqual(o.groups.map((g) => g.n), [50, 50, 50]);
  assert.equal(o.groups[0].group, 'virginica', '按均值降序，virginica 最大');
  assert.equal(o.groups[2].group, 'setosa');
});

test('两组检验：setosa 与 versicolor 花瓣长差异极显著', async () => {
  const d = ds(iris);
  const run = await executePlan({ version: 1, steps: [{ id: 's1', op: 'ttest', params: { groupBy: 'species', column: 'petal_length_cm', groupA: 'setosa', groupB: 'versicolor' } }] }, d);
  const o = run.steps[0].output;
  assert.ok(o.diff < -2.5, `均值差应约 -2.8，实际 ${o.diff}`);
  assert.ok(o.p < 1e-6, `p 应极小，实际 ${o.p}`);
  assert.equal(o.significant, true);
});

test('缺失值盘点：airquality 的 Ozone 有 37 个缺失，相关性样本自动降到 116', async () => {
  const d = ds(airquality);
  const run = await executePlan({
    version: 1,
    steps: [
      { id: 's1', op: 'missing_report', params: { column: 'ozone_ppb' } },
      { id: 's2', op: 'correlate', params: { x: 'temp_f', y: 'ozone_ppb' } },
    ],
  }, d);
  assert.equal(run.steps[0].output.missing, 37);
  assert.ok(Math.abs(run.steps[0].output.rate - 0.2418) < 0.001);
  assert.equal(run.steps[1].output.n, 116);
});

test('时间趋势：AirPassengers 明显上升', async () => {
  const d = ds(airpassengers);
  const run = await executePlan({ version: 1, steps: [{ id: 's1', op: 'trend', params: { column: 'passengers' } }] }, d);
  const o = run.steps[0].output;
  assert.ok(o.slope > 0);
  assert.ok(o.r2 > 0.8, `r² 应较高，实际 ${o.r2}`);
});

test('直方图：各箱计数之和等于有效样本数', async () => {
  const d = ds(faithful);
  const run = await executePlan({ version: 1, steps: [{ id: 's1', op: 'histogram', params: { column: 'waiting_min', bins: 8 } }] }, d);
  const o = run.steps[0].output;
  assert.equal(o.n, 272);
  assert.equal(o.bins.reduce((s, b) => s + b.count, 0), 272);
});

test('剔除异常点：删行清单与异常点行号一致，后续统计只用剩下的行', async () => {
  const d = ds(iris);
  const run = await executePlan({
    version: 1,
    steps: [
      { id: 's1', op: 'drop_outliers', params: { column: 'sepal_width_cm', k: 1.5, confirm: true } },
      { id: 's2', op: 'describe', params: { column: 'sepal_width_cm' } },
    ],
  }, d);
  const o = run.steps[0].output;
  assert.equal(o.removed, 4, 'iris sepal_width_cm 的 IQR 异常点是 4 个');
  assert.deepEqual([...run.droppedRows].sort((a, b) => a - b), [...o.outliers.map((x) => x.row)].sort((a, b) => a - b));
  assert.equal(run.steps[1].output.rowsUsed, 146);
  assert.equal(run.steps[1].output.stats.n, 146);
});

test('空单元格不能当 0（回归：曾把一组均值算低 600）', async () => {
  const csv = 'group,v\nA,10\nB,20\nA,12\nB,\nA,14\nB,24\n';
  const d = ds(csv);
  const run = await executePlan({ version: 1, steps: [{ id: 's1', op: 'group_summary', params: { groupBy: 'group', column: 'v' } }] }, d);
  const b = run.steps[0].output.groups.find((g) => g.group === 'B');
  assert.equal(b.n, 2, 'B 组只有 2 个有效值');
  assert.equal(b.mean, 22);
});

// ---------- 结论卡 ----------
test('结论溯源：引用缺失字段必须报错', () => {
  const claim = { id: 'c1', text: 'r = {{r}}', refs: [{ stepId: 's9', field: 'r', value: 1 }] };
  assert.throws(() => renderClaim(claim, []), /步骤不存在/);
});

test('结论绑定真实数字，且 p 值显示为 < 0.0001 而不是 0', async () => {
  const d = ds(iris);
  const plan = compileByRules(d, 'petal_length_cm 和 petal_width_cm 的关系');
  const run = await executePlan(plan, d);
  const claims = buildClaims(plan, run.steps);
  const text = renderClaim(claims[0], run.steps);
  assert.ok(/r = 0\.96/.test(text), `实际：${text}`);
  assert.ok(/p < 0\.0001/.test(text), `小 p 值应写成 < 0.0001，实际：${text}`);
});

// ---------- 复现包 ----------
test('复现包：文件齐全，产物指纹可独立重算', async () => {
  const d = ds(iris);
  const plan = compileByRules(d, 'petal_length_cm 和 petal_width_cm 的关系，出图');
  const run = await executePlan(plan, d);
  const claims = buildClaims(plan, run.steps);
  const pkg = await buildReproducePackage({ rawCsv: iris, dataset: d, plan, run, claims, meta: {} });
  const names = pkg.files.map((f) => f.name);
  for (const need of ['data.csv', 'plan.json', 'run.json', 'meta.json', 'report.md', 'verify.mjs']) {
    assert.ok(names.includes(need), `复现包缺少 ${need}`);
  }
  const recomputed = await sha256(stableStringify(canonicalArtifact(plan, run.steps, run.droppedRows)));
  assert.equal(recomputed, run.artifactHash);
  assert.equal(pkg.dataHash, await sha256(iris));
});

// ---------- 审计 ----------
test('审计：四舍五入差异算通过，人为改数算不符', () => {
  assert.equal(compareValue(0.9629, 0.962865).ok, true);
  assert.equal(compareValue(3, 4).ok, false);
  assert.equal(compareValue(-2.798, -2.797).ok, true);
});

test('审计：逐条重算，给出 通过/不符/无法复现 三态', async () => {
  const d = ds(iris);
  const plan = { version: 1, steps: [{ id: 's2', op: 'group_summary', params: { groupBy: 'species', column: 'petal_length_cm' } }] };
  const run = await executePlan(plan, d);
  const { results, summary } = await auditReport({
    dataset: d,
    plan,
    claims: [
      { text: '三个分组', stepId: 's2', field: 'groupCount', value: 3 },
      { text: '写成了四组', stepId: 's2', field: 'groupCount', value: 4 },
      { text: '引用不到', stepId: 's9', field: 'mean', value: 1 },
    ],
    expectedArtifactHash: run.artifactHash,
  });
  assert.deepEqual(results.map((r) => r.verdict), ['ok', 'mismatch', 'unreproducible']);
  assert.equal(summary.passed, false);
  assert.equal(summary.hashMatches, true);
});

test('审计：声明的产物哈希对不上时整体不通过', async () => {
  const d = ds(iris);
  const plan = { version: 1, steps: [{ id: 's1', op: 'describe', params: { column: 'petal_width_cm' } }] };
  const { summary } = await auditReport({
    dataset: d,
    plan,
    claims: [{ text: 'n', stepId: 's1', field: 'n', value: 150 }],
    expectedArtifactHash: 'deadbeef',
  });
  assert.equal(summary.hashMatches, false);
  assert.equal(summary.passed, false);
});

test('审计报告：Markdown 里三种判定都在', async () => {
  const d = ds(iris);
  const plan = { version: 1, steps: [{ id: 's1', op: 'group_summary', params: { groupBy: 'species', column: 'sepal_width_cm' } }] };
  const { results, summary } = await auditReport({
    dataset: d,
    plan,
    claims: [
      { text: '分组数', stepId: 's1', field: 'groupCount', value: 9 },
      { text: '缺步骤', stepId: 's7', field: 'x', value: 1 },
    ],
  });
  const md = auditToMarkdown({ summary, results });
  assert.ok(md.includes('不符'));
  assert.ok(md.includes('无法复现'));
  assert.ok(md.includes('审计结论'));
});

// ---------- 回归：两个曾经翻车的坑 ----------
test('回归：只提到一列时，x 和 y 不能撞成同一列（否则 r 恒为 1）', () => {
  const d = ds(iris);
  const plan = compileByRules(d, 'petal_width_cm 怎么样');
  const corr = plan.steps.find((s) => s.op === 'correlate' || s.op === 'fit_linear' || s.op === 'scatter');
  if (corr) assert.notEqual(corr.params.x, corr.params.y, `x 与 y 撞了：${corr.params.x}`);
});

test('回归：复现包里的 verify.mjs 白名单要跟算子表同步（曾漏掉新算子导致 FAIL）', async () => {
  const d = ds(iris);
  const plan = { version: 1, steps: [{ id: 's1', op: 'ttest', params: { groupBy: 'species', column: 'petal_length_cm' } }] };
  const run = await executePlan(plan, d);
  const pkg = await buildReproducePackage({ rawCsv: iris, dataset: d, plan, run, claims: [], meta: {} });
  const verify = pkg.files.find((f) => f.name === 'verify.mjs').text;
  const { OPERATORS } = await import('../src/kernel/ops.js');
  for (const op of Object.keys(OPERATORS)) {
    assert.ok(verify.includes(`"${op}"`), `verify.mjs 白名单缺少算子 ${op}`);
  }
});

// ---------- 撤回删除 ----------
test('撤回删除：计划里去掉 drop_outliers 并重排 step id', async () => {
  const d = ds(iris);
  const plan = compileByRules(d, 'petal_length_cm 和 petal_width_cm 的关系，有异常点就剔除，出图');
  assert.ok(plan.steps.some((s) => s.op === 'drop_outliers'));
  const next = withoutDropOutliers(plan);
  assert.ok(next);
  assert.ok(!next.steps.some((s) => s.op === 'drop_outliers'));
  assert.deepEqual(next.steps.map((s) => s.id), next.steps.map((_, i) => `s${i + 1}`));
  const run = await executePlan(next, d);
  assert.equal(run.droppedRows.length, 0, '撤回后不应再有删除行');
  const original = await executePlan(plan, d);
  assert.notEqual(run.artifactHash, original.artifactHash, '撤回后产物哈希应当变化');
});

test('撤回删除：没有删除步骤时返回 null', () => {
  const plan = { version: 1, steps: [{ id: 's1', op: 'describe', params: { column: 'petal_width_cm' } }] };
  assert.equal(withoutDropOutliers(plan), null);
});

// ---------- 审计：正文数字 vs 声明值 ----------
test('审计：正文里的数字与声明值不一致要判不符', async () => {
  const d = ds(iris);
  const plan = { version: 1, steps: [{ id: 's1', op: 'correlate', params: { x: 'petal_length_cm', y: 'petal_width_cm' } }] };
  const { results } = await auditReport({
    dataset: d,
    plan,
    claims: [
      { text: '花瓣长宽相关（r = 0.9629）', stepId: 's1', field: 'r', value: 0.962865 },
      { text: '花瓣长宽相关（r = 0.5）', stepId: 's1', field: 'r', value: 0.962865 },
      { text: '正文没写数字', stepId: 's1', field: 'r', value: 0.962865 },
    ],
  });
  assert.equal(results[0].verdict, 'ok', '四舍五入后一致应通过');
  assert.equal(results[1].verdict, 'mismatch', '正文写 0.5 但声明值是真实值，应判不符');
  assert.match(results[1].reason, /正文/);
  assert.equal(results[2].verdict, 'ok', '正文没有数字时不检查');
  assert.equal(results[2].textCheck.checked, false);
});

// ---------- 数据体检 ----------
test('数据体检：缺失率、唯一值、常量列与范围', async () => {
  const { columnProfiles, profileWarnings, columnProfile } = await import('../src/kernel/profile.js');
  const d = ds('a,b,c\n1,x,5\n2,,5\n3,y,5\n4,,5\n');
  const profiles = columnProfiles(d);
  const a = profiles.find((p) => p.name === 'a');
  const b = profiles.find((p) => p.name === 'b');
  const c = profiles.find((p) => p.name === 'c');
  assert.equal(a.missing, 0);
  assert.equal(a.min, 1);
  assert.equal(a.max, 4);
  assert.equal(b.missing, 2);
  assert.equal(b.missingRate, 0.5);
  assert.equal(b.unique, 2);
  assert.equal(c.constant, true);
  const warnings = profileWarnings(profiles);
  assert.ok(warnings.some((w) => w.includes('b') && w.includes('50.0%')));
  assert.ok(warnings.some((w) => w.includes('c') && w.includes('常量')));
  assert.equal(columnProfile(d, d.columns[0]).kind, 'number');
});
