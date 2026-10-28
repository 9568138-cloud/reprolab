import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { toDataset } from '../src/kernel/csv.js';
import { executePlan, validatePlan, PlanError, canonicalArtifact } from '../src/kernel/index.js';
import { compileByRules, buildClaims, renderClaim, withoutDropOutliers } from '../src/planner.js';
import { sha256, stableStringify } from '../src/kernel/hash.js';
import { buildReproducePackage } from '../src/export/package.js';
import { auditReport, auditBatchToMarkdown, auditToMarkdown, compareValue, summarizeAudits } from '../src/audit.js';
import { runAdversarialCases } from '../src/adversarial.js';
import { buildVariants, runSensitivity, driftOf, verdictText } from '../src/sensitivity.js';
import { decodeTextBuffer } from '../src/kernel/decode.js';
import { readZip, findEntry } from '../src/kernel/unzip.js';
import { zipStore } from '../src/export/zip.js';

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

// ---------- 条件筛选 ----------
test('条件筛选：只保留满足条件的行，下游统计随之变化', async () => {
  const d = ds(iris);
  const run = await executePlan({
    version: 1,
    steps: [
      { id: 's1', op: 'filter_rows', params: { column: 'petal_length_cm', op: '>', value: 4 } },
      { id: 's2', op: 'describe', params: { column: 'petal_width_cm' } },
    ],
  }, d);
  const f = run.steps[0].output;
  assert.equal(f.kept, 84, 'iris 里花瓣长 > 4 的有 84 行');
  assert.equal(f.removed, d.rowCount - 84);
  assert.equal(run.excludedRows.length, d.rowCount - 84);
  assert.equal(run.steps[1].output.rowsUsed, 84);
  const claim = buildClaims({ version: 1, steps: [] }, run.steps)[0];
  assert.match(renderClaim(claim, run.steps), /保留 84 行/);
});

test('条件筛选：与剔除异常点叠加时行号不串（回归：曾差 1 行）', async () => {
  const d = ds(iris);
  const run = await executePlan({
    version: 1,
    steps: [
      { id: 's1', op: 'filter_rows', params: { column: 'petal_length_cm', op: '>=', value: 3 } },
      { id: 's2', op: 'drop_outliers', params: { column: 'petal_width_cm', k: 1.5, confirm: true } },
      { id: 's3', op: 'correlate', params: { x: 'petal_length_cm', y: 'petal_width_cm' } },
    ],
  }, d);
  const f = run.steps[0].output;
  const drop = run.steps[1].output;
  const filteredSet = new Set(f.filteredRows);
  assert.equal(drop.droppedRows.filter((r) => filteredSet.has(r)).length, 0, '剔除的行不应落在筛选已排除的行里');
  assert.equal(run.steps[2].output.n, f.kept - drop.removed, '相关性样本数 = 筛选后行数 - 剔除行数');
  assert.equal(run.excludedRows.length, d.rowCount - run.steps[2].output.n);
});

test('条件筛选：非法比较符在执行期被拒绝', async () => {
  await assert.rejects(
    () => executePlan({ version: 1, steps: [{ id: 's1', op: 'filter_rows', params: { column: 'petal_length_cm', op: '像', value: 1 } }] }, ds(iris)),
    /不支持的条件/,
  );
});

// ---------- 界面内自校验（与 verify.mjs 同口径） ----------
test('自校验：正常包全部通过，篡改 run 则失败', async () => {
  const { verifyPackage } = await import('../src/export/verify-runner.js');
  const d = ds(iris);
  const plan = compileByRules(d, 'petal_length_cm 和 petal_width_cm 的关系，出图');
  const run = await executePlan(plan, d);
  const claims = buildClaims(plan, run.steps);
  const pkg = await buildReproducePackage({ rawCsv: iris, dataset: d, plan, run, claims, meta: {} });
  const meta = JSON.parse(pkg.files.find((f) => f.name === 'meta.json').text);

  const ok = await verifyPackage({ rawCsv: iris, plan, run, meta });
  assert.equal(ok.passed, true);
  assert.equal(ok.checks.length, 5);

  // 篡改：改掉 run 里某个步骤的输出（模拟手改 run.json）
  const tampered = { ...run, steps: run.steps.map((s, i) => (i === run.steps.length - 1 ? { ...s, output: { ...s.output, count: 999 } } : s)) };
  const bad = await verifyPackage({ rawCsv: iris, plan, run: tampered, meta });
  assert.equal(bad.passed, false);
  assert.ok(bad.checks.some((c) => !c.pass && c.name.includes('产物哈希')));
});

test('复现包：带图表时多一个 chart.svg', async () => {
  const d = ds(iris);
  const plan = compileByRules(d, 'petal_length_cm 和 petal_width_cm 的关系，出图');
  const run = await executePlan(plan, d);
  const claims = buildClaims(plan, run.steps);
  const withChart = await buildReproducePackage({ rawCsv: iris, dataset: d, plan, run, claims, meta: {}, chartSvg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>' });
  assert.ok(withChart.files.some((f) => f.name === 'chart.svg'));
  const noChart = await buildReproducePackage({ rawCsv: iris, dataset: d, plan, run, claims, meta: {} });
  assert.ok(!noChart.files.some((f) => f.name === 'chart.svg'));
});

// ---------- 文本列筛选（图表下钻用到） ----------
test('条件筛选：文本列支持 == / !=，且拒绝大小比较', async () => {
  const d = ds(iris);
  const run = await executePlan({
    version: 1,
    steps: [
      { id: 's1', op: 'filter_rows', params: { column: 'species', op: '==', value: 'setosa' } },
      { id: 's2', op: 'describe', params: { column: 'petal_length_cm' } },
    ],
  }, d);
  assert.equal(run.steps[0].output.kept, 50);
  assert.equal(run.steps[1].output.stats.mean, 1.462);

  const notSetosa = await executePlan({ version: 1, steps: [{ id: 's1', op: 'filter_rows', params: { column: 'species', op: '!=', value: 'setosa' } }] }, d);
  assert.equal(notSetosa.steps[0].output.kept, 100);

  await assert.rejects(
    () => executePlan({ version: 1, steps: [{ id: 's1', op: 'filter_rows', params: { column: 'species', op: '>', value: 'setosa' } }] }, d),
    /只支持 == 或 !=/,
  );
});

test('白名单：文本列的 filter value 允许字符串（any 类型不误报）', () => {
  assert.ok(validatePlan({ version: 1, steps: [{ id: 's1', op: 'filter_rows', params: { column: 'species', op: '==', value: 'setosa' } }] }, ds(iris)));
});

// ---------- 列类型手改：单位换算 ----------
test('按数值解析：去掉千分位与单位，万/亿 换算，解析不了的按缺失', async () => {
  const { forceNumericColumn } = await import('../src/kernel/profile.js');
  const d = ds('city,price\n北京,12.5 万\n上海,"138,000"\n深圳,未知\n广州,\n杭州,9.8万\n');
  const r = forceNumericColumn(d, 'price');
  assert.equal(r.parsed, 3);
  assert.equal(r.failed, 1);
  assert.equal(r.scaled, 2);
  assert.equal(r.dataset.columns.find((c) => c.name === 'price').kind, 'number');
  assert.deepEqual(r.dataset.rows.map((row) => row[1]), ['125000', '138000', '', '', '98000']);
  const again = forceNumericColumn(r.dataset, 'price');
  assert.equal(again.already, true, '已经是数值列时不再重复转换');
});

// ---------- 批量审计：一个实验室交来 N 份报告 ----------
test('批量审计：汇总累加各份判定，有一份不通过整体就不通过', async () => {
  const d = ds(iris);
  const planA = { version: 1, steps: [{ id: 's1', op: 'group_summary', params: { groupBy: 'species', column: 'sepal_width_cm' } }] };
  const a = await auditReport({
    dataset: d,
    plan: planA,
    claims: [{ text: '三个分组', stepId: 's1', field: 'groupCount', value: 3 }],
  });

  const planB = { version: 1, steps: [{ id: 's1', op: 'describe', params: { column: 'petal_width_cm' } }] };
  const b = await auditReport({
    dataset: d,
    plan: planB,
    claims: [
      { text: '用了 150 行', stepId: 's1', field: 'rowsUsed', value: 150 },
      { text: '写成 120 行', stepId: 's1', field: 'rowsUsed', value: 120 },
      { text: '引用了不存在的步骤', stepId: 's9', field: 'rowsUsed', value: 1 },
    ],
  });

  const batch = summarizeAudits(
    [{ title: '报告 A', summary: a.summary }, { title: '报告 B', summary: b.summary }],
    { dataName: 'iris.csv' },
  );
  assert.equal(batch.reports, 2);
  assert.equal(batch.claims, 4);
  assert.equal(batch.ok, 2);
  assert.equal(batch.mismatch, 1);
  assert.equal(batch.unreproducible, 1);
  assert.equal(batch.failedReports, 1);
  assert.equal(batch.passed, false);
  assert.equal(batch.dataName, 'iris.csv');
  assert.equal(batch.entries[0].passed, true);
  assert.equal(batch.entries[1].passed, false);
});

test('批量审计：全部通过时整体通过；空集合不算通过', async () => {
  const d = ds(iris);
  const plan = { version: 1, steps: [{ id: 's1', op: 'describe', params: { column: 'petal_length_cm' } }] };
  const one = await auditReport({ dataset: d, plan, claims: [{ text: '用了 150 行', stepId: 's1', field: 'rowsUsed', value: 150 }] });
  const all = summarizeAudits([{ title: 'A', summary: one.summary }, { title: 'B', summary: one.summary }]);
  assert.equal(all.passed, true);
  assert.equal(all.failedReports, 0);
  assert.equal(all.entries[0].artifactHash, one.summary.artifactHash);

  const empty = summarizeAudits([]);
  assert.equal(empty.reports, 0);
  assert.equal(empty.passed, false, '没有报告时不能给出「通过」这种结论');
  assert.deepEqual(empty.entries, []);
});

test('批量审计：Markdown 汇总里每份一行，结论不通过的那份标出来', async () => {
  const entries = [
    { title: '实验室 A 的报告', summary: { total: 2, ok: 2, mismatch: 0, unreproducible: 0, passed: true } },
    { title: '实验室 B 的报告', summary: { total: 3, ok: 1, mismatch: 1, unreproducible: 1, passed: false } },
  ];
  const summary = summarizeAudits(entries, { dataName: '中国70城房价指数_环比.csv' });
  const md = auditBatchToMarkdown({ summary });
  assert.match(md, /报告数：2/);
  assert.match(md, /结论数：5（通过 3 \/ 不符 1 \/ 无法复现 1）/);
  assert.match(md, /❌ 1 份报告存在问题/);
  assert.match(md, /\| 实验室 A 的报告 \| 2 \| 2 \| 0 \| 0 \| 通过 \|/);
  assert.match(md, /\| 实验室 B 的报告 \| 3 \| 1 \| 1 \| 1 \| 不通过 \|/);
  assert.match(md, /中国70城房价指数_环比\.csv/);
});

// ---------- 越界测试（对抗样例） ----------
test('越界测试：8 条坏计划全被拒，对照的合规计划照常放行', () => {
  const rows = runAdversarialCases(ds(iris));
  assert.equal(rows.length, 9);
  assert.equal(rows.filter((r) => r.rejected).length, 8);
  const bad = rows.filter((r) => !r.pass).map((r) => `${r.id}: ${r.reason}`);
  assert.deepEqual(bad, [], `有反例没被拦住：${bad.join(' / ')}`);
  const ctrl = rows.find((r) => r.id === 'control_ok');
  assert.equal(ctrl.rejected, false, '合规计划不该被拒');
  assert.match(ctrl.reason, /通过校验/);
});

test('计划校验：参数里夹带 sql 会被点名拒绝', () => {
  assert.throws(
    () => validatePlan({ version: 1, steps: [{ id: 's1', op: 'describe', params: { column: 'petal_width_cm', sql: 'DROP TABLE x' } }] }, ds(iris)),
    /sql 不是 describe 的参数/,
  );
});

test('计划校验：steps 缺失或不是数组时报 PlanError，而不是 TypeError', () => {
  assert.throws(() => validatePlan({ version: 1 }, ds(iris)), (err) => err instanceof PlanError && /steps 不能为空/.test(err.message));
  assert.throws(() => validatePlan({ version: 1, steps: 'oops' }, ds(iris)), PlanError);
  assert.throws(() => validatePlan({ version: 1, steps: { length: 3 } }, ds(iris)), PlanError);
});

// ---------- 编码：Excel 导出的 GBK ----------
test('编码：GBK 中文 CSV 自动按 GB18030 解码，UTF-8 的照常读', () => {
  // "city,value\n北京,1\n" —— 北京 = B1 B1 BE A9（GBK）
  const gbk = new Uint8Array([
    0x63, 0x69, 0x74, 0x79, 0x2c, 0x76, 0x61, 0x6c, 0x75, 0x65, 0x0a,
    0xb1, 0xb1, 0xbe, 0xa9, 0x2c, 0x31, 0x0a,
  ]);
  const r = decodeTextBuffer(gbk);
  assert.equal(r.encoding, 'GB18030');
  assert.match(r.text, /北京,1/);
  assert.equal(toDataset(r.text).rowCount, 1);

  const utf8 = decodeTextBuffer(new TextEncoder().encode('city,value\n北京,1\n'));
  assert.equal(utf8.encoding, 'UTF-8');
  assert.match(utf8.text, /北京,1/);
});

test('编码：UTF-8 BOM 被去掉（否则第一列名会带不可见字符）', () => {
  const body = new TextEncoder().encode('city,value\n北京,1\n');
  const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...body]);
  const r = decodeTextBuffer(withBom);
  assert.equal(r.encoding, 'UTF-8');
  assert.equal(r.bom, true);
  assert.ok(r.text.startsWith('city'), 'BOM 之后应直接是表头');
  assert.equal(r.text.charCodeAt(0), 0x63);
});

// ---------- 解包：拖进来的复现包 ----------
test('解包：自己写的 store zip 能读回来，findEntry 按后缀找文件', async () => {
  const zip = zipStore([
    { name: 'reprolab/data.csv', text: 'a,b\n1,2\n' },
    { name: 'reprolab/plan.json', text: '{"version":1,"steps":[]}' },
    { name: 'reprolab/中文说明.md', text: '# 说明\n' },
  ]);
  const files = await readZip(zip);
  assert.equal(files.size, 3);
  assert.equal(new TextDecoder().decode(findEntry(files, 'data.csv')), 'a,b\n1,2\n');
  assert.equal(new TextDecoder().decode(findEntry(files, 'plan.json')), '{"version":1,"steps":[]}');
  assert.ok(findEntry(files, '中文说明.md'), '中文文件名要能按 UTF-8 读回来');
  assert.equal(findEntry(files, '不存在.txt'), null);
});

// ---------- 敏感性检验：换个参数，结论还成立吗 ----------
test('敏感性：只扰动可调参数，一次只改一个，confirm 保留', () => {
  const plan = {
    version: 1,
    steps: [
      { id: 's1', op: 'describe', params: { column: 'petal_length_cm' } },
      { id: 's2', op: 'drop_outliers', params: { column: 'petal_length_cm', k: 1.5, confirm: true } },
      { id: 's3', op: 'correlate', params: { x: 'sepal_length_cm', y: 'petal_length_cm' } },
    ],
  };
  const vs = buildVariants(plan);
  assert.equal(vs.length, 3, 'k = 1.0 / 2.0 / 3.0 三个变体');
  for (const v of vs) {
    const changed = v.plan.steps.filter((s, i) => JSON.stringify(s) !== JSON.stringify(plan.steps[i]));
    assert.equal(changed.length, 1, '一次只能改一个步骤');
    assert.equal(changed[0].op, 'drop_outliers');
    assert.notEqual(changed[0].params.k, 1.5);
    assert.equal(changed[0].params.confirm, true, 'confirm 不能被扰动掉');
  }
});

test('敏感性：没有可调参数的计划给出 none，而不是假「稳健」', async () => {
  const plan = { version: 1, steps: [{ id: 's1', op: 'correlate', params: { x: 'sepal_length_cm', y: 'petal_length_cm' } }] };
  const run = await executePlan(plan, ds(iris));
  const res = await runSensitivity({ dataset: ds(iris), plan, baseline: run });
  assert.equal(res.variants.length, 0);
  assert.equal(res.verdict, 'none');
  assert.match(verdictText('none'), /没有可调参数/);
});

test('敏感性：剔除倍数改成 1/2/3 后重跑，给出漂移与三档判定', async () => {
  const d = ds(iris);
  const plan = {
    version: 1,
    steps: [
      { id: 's1', op: 'drop_outliers', params: { column: 'petal_length_cm', k: 1.5, confirm: true } },
      { id: 's2', op: 'correlate', params: { x: 'sepal_length_cm', y: 'petal_length_cm' } },
    ],
  };
  const run = await executePlan(plan, d);
  const res = await runSensitivity({ dataset: d, plan, baseline: run });
  assert.equal(res.variants.length, 3);
  assert.ok(res.witnesses.some((w) => w.field === 'r'), '相关性系数要作为被检验的结论');
  assert.ok(['robust', 'borderline', 'fragile'].includes(res.verdict));
  for (const v of res.variants) {
    assert.equal(v.error, null);
    const r = v.cells.find((c) => c.field === 'r');
    assert.equal(typeof r.drift, 'number');
    assert.ok(r.drift >= 0);
  }
});

test('漂移计算：以基线为参照，基线为 0 时按是否相等判定', () => {
  assert.equal(driftOf(2, 2), 0);
  assert.equal(driftOf(2, 3), 0.5);
  assert.equal(driftOf(0, 0), 0);
  assert.equal(driftOf(0, 5), 1);
  assert.equal(driftOf(-4, -2), 0.5);
});

test('敏感性：过程量（剔除点数）变化不算「结论翻盘」', async () => {
  const d = ds(iris);
  const plan = {
    version: 1,
    steps: [
      { id: 's1', op: 'drop_outliers', params: { column: 'petal_length_cm', k: 1.5, confirm: true } },
      { id: 's2', op: 'correlate', params: { x: 'sepal_length_cm', y: 'petal_length_cm' } },
    ],
  };
  const run = await executePlan(plan, d);
  const res = await runSensitivity({ dataset: d, plan, baseline: run });
  const removed = res.variants[0].cells.find((c) => c.field === 'removed');
  assert.ok(removed, '剔除点数应当被记录进表格');
  assert.equal(removed.judged, false, '剔除点数属于过程量，不参与稳健性判定');
  const r = res.variants[0].cells.find((c) => c.field === 'r');
  assert.equal(r.judged, true, '相关系数才是结论类数字');
  assert.notEqual(res.verdict, 'fragile', '过程量变化不能把结论判成不稳');
});
