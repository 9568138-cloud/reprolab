import { toDataset } from '../kernel/csv.js';
import { columnProfiles, profileWarnings, forceNumericColumn } from '../kernel/profile.js';
import { executePlan, validatePlan } from '../kernel/index.js';
import { compileByRules, compileByLLM, buildClaims, renderClaim, groupCandidates, withoutDropOutliers } from '../planner.js';
import { sha256, shortHash } from '../kernel/hash.js';
import { buildReproducePackage } from '../export/package.js';
import { verifyPackage } from '../export/verify-runner.js';
import { auditReport, auditBatchToMarkdown, auditToMarkdown, resolveStepField, summarizeAudits } from '../audit.js';
import { zipStore } from '../export/zip.js';
import { decodeTextBuffer, encodingNote } from '../kernel/decode.js';
import { readZip, findEntry } from '../kernel/unzip.js';
import { runAdversarialCases } from '../adversarial.js';

const $ = (id) => document.getElementById(id);
const state = { rawCsv: '', dataset: null, plan: null, run: null, claims: [], needsConfirm: false, demo: false };


// ---------- 基础交互 ----------
let toastTimer = null;
function toast(message, kind = 'info') {
  const el = $('toast');
  el.textContent = message;
  el.className = `toast ${kind}`;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), kind === 'error' ? 5200 : 2600);
}

function setStatus(text, live = false) {
  const pill = $('statusPill');
  pill.textContent = text;
  pill.classList.toggle('live', live);
}
function show(id, visible = true) { $(id).classList.toggle('hidden', !visible); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 01 数据接入 ----------
/** 读 CSV 文件：先按 UTF-8 严格解码，不是 UTF-8 就按 GB18030（Excel 导出的中文 CSV） */
async function readCsvFile(file) {
  const { text, encoding } = decodeTextBuffer(new Uint8Array(await file.arrayBuffer()));
  const note = encodingNote(encoding);
  if (note) toast(note, 'ok');
  return { text, encoding };
}

async function loadCsv(text, label = 'CSV', encoding = 'UTF-8') {
  try {
    const dataset = toDataset(text);
    state.rawCsv = text;
    state.dataset = dataset;
    state.plan = null;
    state.run = null;
    const hash = await sha256(text);
    state.dataHash = hash;
    const numeric = dataset.columns.filter((c) => c.kind === 'number').map((c) => c.name);
    $('datasetInfo').innerHTML = [
      `<span class="chip">来源 <b>${label}</b></span>`,
      `<span class="chip">行数 <b>${dataset.rowCount}</b></span>`,
      `<span class="chip">列数 <b>${dataset.columns.length}</b></span>`,
      `<span class="chip">数值列 <b>${numeric.join(' / ') || '无'}</b></span>`,
      encoding === 'UTF-8' ? '' : `<span class="chip">编码 <b>${encoding}</b>（已自动转换）</span>`,
      `<span class="chip">SHA-256 <b>${shortHash(hash, 16)}</b></span>`,
    ].join('');
    show('datasetInfo', true);
    renderProfile(dataset);
    renderPreview(dataset);
    setStatus(`已载入 ${dataset.rowCount} 行 · 原始层只读`, true);
    show('step3', false); show('step4', false); show('step5', false);
    fillColumnSelects();
    renderIntentChips();
    if (numeric.length < 2) {
      toast(`只有 ${numeric.length} 列数值：能出描述统计，但做不了相关/拟合`, 'warn');
    }
    return dataset;
  } catch (err) {
    toast(`解析失败：${err.message}`, 'error');
    return null;
  }
}

$('fileInput').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  const { text, encoding } = await readCsvFile(file);
  loadCsv(text, file.name, encoding);
});

/** 前 8 行预览：用户上传后第一件事是确认“传对了吗” */
function renderPreview(dataset) {
  const cols = dataset.columns.slice(0, 8);
  const rows = dataset.rows.slice(0, 8);
  const head = cols.map((c) => `<th>${escapeHtml(c.name)}<span class="kind">${c.kind === 'number' ? '数值' : '文本'}</span></th>`).join('');
  const body = rows.map((r) => `<tr>${cols.map((c) => {
    const v = r[c.index];
    const missing = v === undefined || v === '';
    const shown = missing ? '<span class="miss">缺失</span>' : escapeHtml(String(v).slice(0, 20));
    return `<td class="${c.kind === 'number' ? 'num' : ''}">${shown}</td>`;
  }).join('')}</tr>`).join('');
  $('dataPreview').innerHTML = `
    <div class="preview-head">前 ${rows.length} 行预览<span class="hint">共 ${dataset.rowCount} 行 · ${dataset.columns.length} 列</span></div>
    <div class="preview-scroll">
      <table>
        <thead><tr>${head}</tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>`;
  show('dataPreview', true);
}

/** 数据体检：每列缺失率、唯一值、范围/最常见值，顺手标出明显问题 */
function renderProfile(dataset) {
  const profiles = columnProfiles(dataset);
  const warnings = profileWarnings(profiles);
  const fmt = (v) => (typeof v === 'number' ? fmtTick(v) : escapeHtml(String(v ?? '').slice(0, 14)));
  const rows = profiles.map((p) => {
    const bad = p.missingRate >= 0.2 || p.constant;
    const range = p.kind === 'number' && p.min !== undefined
      ? `${fmt(p.min)} ~ ${fmt(p.max)}（均值 ${fmt(p.mean)}）`
      : p.top !== undefined ? `最常见「${fmt(p.top)}」×${p.topCount}` : '—';
    const isText = p.kind !== 'number' && p.digitRatio >= 0.5; // 一半以上取值含数字才提示可以当数值用
    const action = isText ? `<button class="btn ghost small" data-force-num="${escapeHtml(p.name)}" title="去掉单位/千分位，尽量解析成数字">按数值解析</button>` : '';
    return `<tr class="${bad ? 'bad' : ''}">
      <td>${escapeHtml(p.name)}<span class="kind">${p.kind === 'number' ? '数值' : '文本'}</span></td>
      <td class="num">${p.n}</td>
      <td class="num ${p.missing ? 'warn' : ''}">${p.missing}${p.missing ? `（${(p.missingRate * 100).toFixed(1)}%）` : ''}</td>
      <td class="num">${p.unique}</td>
      <td>${range}${action ? ' ' + action : ''}</td>
    </tr>`;
  }).join('');
  $('dataProfile').innerHTML = `
    <div class="preview-head">数据体检<span class="hint">${dataset.columns.length} 列 · ${dataset.rowCount} 行${warnings.length ? ` · ⚠ ${escapeHtml(warnings.slice(0, 3).join('；'))}${warnings.length > 3 ? ' …' : ''}` : ' · 未发现明显问题'}</span></div>
    <div class="preview-scroll">
      <table>
        <thead><tr><th>列</th><th>行数</th><th>缺失</th><th>不同取值</th><th>范围 / 最常见</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
  show('dataProfile', true);
}

// 文本列一键当数值用（去掉单位/千分位，「万/亿」会换算）
$('dataProfile').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-force-num]');
  if (!btn || !state.dataset) return;
  const name = btn.getAttribute('data-force-num');
  try {
    const res = forceNumericColumn(state.dataset, name);
    if (res.already) return toast(`${name} 已经是数值列了`, 'warn');
    state.dataset = res.dataset;
    state.plan = null;
    state.run = null;
    show('step3', false); show('step4', false); show('step5', false);
    renderProfile(state.dataset);
    renderPreview(state.dataset);
    fillColumnSelects();
    renderIntentChips();
    const extra = [res.scaled ? `${res.scaled} 行按 万/亿/千 换算` : '', res.failed ? `${res.failed} 行无法解析、按缺失处理` : ''].filter(Boolean).join('，');
    toast(`${name} 已按数值解析（${res.parsed} 行${extra ? '；' + extra : ''}）`, 'ok');
  } catch (err) {
    toast(`解析失败：${err.message}`, 'error');
  }
});

const dropzone = $('dropzone');
dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('drag'); });
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag'));
dropzone.addEventListener('drop', async (e) => {
  e.preventDefault(); dropzone.classList.remove('drag');
  const file = e.dataTransfer?.files?.[0];
  if (!file) return;
  // 拖进来的是复现包 zip → 走「一键重跑」，不是当 CSV 解析
  if (/\.zip$/i.test(file.name) || file.type === 'application/zip') { await loadReproducePackage(file); return; }
  const { text, encoding } = await readCsvFile(file);
  loadCsv(text, file.name, encoding);
});
$('loadPaste').addEventListener('click', () => {
  const text = $('pasteInput').value.trim();
  if (!text) return toast('先粘贴 CSV 内容', 'warn');
  loadCsv(text, '粘贴');
});

/**
 * 拖进来一个复现包：用包里自己的 data.csv + plan.json 重新执行一遍，
 * 再和包里的 run.json / meta.json 对账（与 verify.mjs 同一套口径，5 项检查）。
 */
async function loadReproducePackage(file) {
  const banner = (cls, title, hint) => {
    $('reproResult').innerHTML = `<div class="audit-summary ${cls}">
      <span class="verdict-big">${title}</span><span class="hint">${hint}</span></div>`;
    show('reproResult', true);
  };
  banner('', '正在读复现包…', escapeHtml(file.name));
  try {
    const files = await readZip(new Uint8Array(await file.arrayBuffer()));
    const dec = (b) => new TextDecoder('utf-8').decode(b);
    const dataBytes = findEntry(files, 'data.csv');
    const planBytes = findEntry(files, 'plan.json');
    const runBytes = findEntry(files, 'run.json');
    const metaBytes = findEntry(files, 'meta.json');
    if (!dataBytes || !planBytes) throw new Error('包里没有 data.csv 或 plan.json，不像是 ReproLab 的复现包');

    const rawCsv = decodeTextBuffer(dataBytes).text;
    const plan = JSON.parse(dec(planBytes));
    const run = runBytes ? JSON.parse(dec(runBytes)) : null;
    const meta = metaBytes ? JSON.parse(dec(metaBytes)) : null;

    // 载入包里的数据（走正常接入流程，界面状态保持一致）
    await loadCsv(rawCsv, `${file.name} → data.csv`);

    // 关键一步：不看包里的结论，自己重算一遍
    const fresh = await executePlan(plan, state.dataset);
    const sameAsRun = run ? fresh.artifactHash === run.artifactHash : null;

    let checks;
    let passed;
    if (run && meta) {
      const v = await verifyPackage({ rawCsv, plan, run, meta });
      checks = v.checks;
      passed = v.passed && sameAsRun !== false;
    } else {
      checks = [{ name: '包里带了 data.csv 与 plan.json', pass: true, detail: `${plan.steps.length} 步` }];
      passed = true;
    }

    const ops = plan.steps.map((s) => s.op.replace('_rows', '').replace('_', ' ')).join(' → ');
    $('reproResult').innerHTML = `
      <div class="audit-summary ${passed ? 'ok' : 'bad'}">
        <span class="verdict-big">${passed ? '✅ 这份复现包与它的执行记录逐位一致' : '❌ 包里内容与记录对不上'}</span>
        <span class="hint">${checks.filter((c) => c.pass).length}/${checks.length} 项通过 · 重算产物哈希 <code>${shortHash(fresh.artifactHash, 16)}</code>${sameAsRun === null ? '' : sameAsRun ? '（与包内 run.json 一致）' : '（与包内 run.json 不一致）'}</span>
      </div>
      <div class="audit-plan">${escapeHtml(ops)}</div>
      <table class="audit-table">
        <thead><tr><th>#</th><th>检查项</th><th>结果</th><th>明细</th></tr></thead>
        <tbody>${checks.map((c, i) => `<tr class="audit-row ${c.pass ? 'ok' : 'bad'}">
          <td class="idx">${i + 1}</td>
          <td>${escapeHtml(c.name)}</td>
          <td><span class="vchip ${c.pass ? 'ok' : 'bad'}">${c.pass ? 'PASS' : 'FAIL'}</span></td>
          <td class="why">${escapeHtml(c.detail || '')}</td>
        </tr>`).join('')}</tbody>
      </table>
      <div class="hint">整个过程没有用到包里写的任何结论：数据、计划来自包，结果是我刚重算的。</div>`;
    show('reproResult', true);
    setStatus(`已重跑复现包 · ${plan.steps.length} 步`, true);
    toast(passed ? '复现包校验通过' : '复现包与记录不一致', passed ? 'ok' : 'error');
  } catch (err) {
    banner('bad', '❌ 复现包读不了', escapeHtml(err.message));
    toast(`复现包处理失败：${err.message}`, 'error');
  }
}

// ---------- 越界测试：看校验器怎么对付「坏计划」 ----------
$('advRun').addEventListener('click', () => {
  if (!state.dataset) return toast('先载入数据（要用真实列名）', 'warn');
  const rows = runAdversarialCases(state.dataset);
  const rejected = rows.filter((r) => r.rejected).length;
  const allPass = rows.every((r) => r.pass);
  $('advResult').innerHTML = `
    <div class="audit-summary ${allPass ? 'ok' : 'bad'}">
      <span class="verdict-big">${allPass ? `✅ ${rejected} 条越界全部被拒，1 条合规照常放行` : '❌ 有反例没被拦住'}</span>
      <span class="hint">逐条过 validatePlan()，期望与实际一致才算通过</span>
    </div>
    <table class="audit-table">
      <thead><tr><th>#</th><th>模型可能给的指令</th><th>期望</th><th>实际</th><th>为什么</th></tr></thead>
      <tbody>${rows.map((r, i) => `<tr class="audit-row ${r.pass ? (r.rejected ? 'ok' : 'warn') : 'bad'}">
        <td class="idx">${i + 1}</td>
        <td>${escapeHtml(r.title)}<div class="hint">${escapeHtml(r.why)}</div></td>
        <td>${r.expect === 'rejected' ? '应被拒' : '应放行'}</td>
        <td><span class="vchip ${r.rejected ? 'bad' : 'ok'}">${r.rejected ? '已拒绝' : '放行'}</span></td>
        <td class="why">${escapeHtml(r.reason)}</td>
      </tr>`).join('')}</tbody>
    </table>`;
  show('advResult', true);
  toast(allPass ? '9 条都符合预期' : '有反例没被拦住，得补校验', allPass ? 'ok' : 'error');
});

// ---------- 02 编译计划 ----------
$('question').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); compilePlan(); }
});

$('saveLLM').addEventListener('click', () => {
  localStorage.setItem('reprolab.llmKey', $('llmKey').value.trim());
  localStorage.setItem('reprolab.llmEndpoint', $('llmEndpoint').value.trim());
  $('compileHint').textContent = '已保存，下次编译优先走 LLM';
  toast('已保存 LLM 配置（只存在本机浏览器）', 'ok');
});

// ---------- 02-A 点选模式：勾意图 + 选列 → 生成计划 ----------
const INTENTS = [
  { op: 'correlate', label: '相关性', need: 'xy', hint: '两列有多相关：r / n / p' },
  { op: 'fit_linear', label: '线性拟合', need: 'xy', hint: '斜率、截距、R²' },
  { op: 'scatter', label: '散点图', need: 'xy', hint: '出图，被剔除的点画成红圈' },
  { op: 'drop_outliers', label: '剔除异常点', danger: true, hint: 'IQR 规则，会删行，需要人工确认' },
  { op: 'transform_log', label: '对数变换', hint: '对主列取 ln，适合指数关系' },
  { op: 'normalize', label: '标准化', hint: 'z-score，方便跨量级比较' },
  { op: 'group_summary', label: '分组汇总', need: 'group', hint: '按文本列分组求均值/中位数' },
  { op: 'ttest', label: '两组比较', need: 'group', hint: 'Welch t 检验，看差异显不显著' },
  { op: 'histogram', label: '分布直方图', hint: '看数据落在哪些区间' },
  { op: 'trend', label: '时间趋势', hint: '按行序做线性趋势' },
  { op: 'filter_rows', label: '条件筛选', need: 'filter', hint: '只看满足条件的行：列 + 比较符 + 阈值' },
  { op: 'missing_report', label: '缺失盘点', hint: '数有多少空单元格' },
];
const INTENT_ORDER = ['filter_rows', 'missing_report', 'normalize', 'drop_outliers', 'transform_log', 'group_summary', 'ttest', 'correlate', 'fit_linear', 'trend', 'histogram', 'scatter'];
const selectedOps = new Set();

function renderIntentChips() {
  const hasGroup = !!getGroupColumns().length;
  const hasNumeric = (state.dataset?.columns || []).some((c) => c.kind === 'number');
  $('intentChips').innerHTML = INTENTS.map((it) => {
    const blocked = (it.need === 'group' && !hasGroup) || (it.need === 'filter' && !hasNumeric);
    const active = selectedOps.has(it.op);
    return `<button class="intent${active ? ' on' : ''}${it.danger ? ' danger' : ''}${blocked ? ' blocked' : ''}"
      data-op="${it.op}" ${blocked ? 'disabled' : ''} title="${escapeHtml(it.hint)}">${it.label}</button>`;
  }).join('');
  const n = selectedOps.size;
  $('buildHint').textContent = !state.dataset
    ? '先载入数据，再点上面想做的分析'
    : n === 0
      ? '点上面的按钮选要做的事（可多选），再点「生成计划」'
      : `已选 ${n} 项：${[...selectedOps].map((op) => labelOf(op)).join('、')}`;
  $('buildBtn').disabled = !state.dataset || n === 0;
  $('filterRow').classList.toggle('hidden', !selectedOps.has('filter_rows'));
}

$('intentChips').addEventListener('click', (e) => {
  const btn = e.target.closest('.intent');
  if (!btn || btn.disabled) return;
  const op = btn.dataset.op;
  selectedOps.has(op) ? selectedOps.delete(op) : selectedOps.add(op);
  renderIntentChips();
});
$('clearIntents').addEventListener('click', () => { selectedOps.clear(); renderIntentChips(); });

function getGroupColumns() {
  return state.dataset ? groupCandidates(state.dataset) : [];
}

function fillColumnSelects() {
  const nums = (state.dataset?.columns || []).filter((c) => c.kind === 'number');
  const groups = getGroupColumns();
  const opts = nums.map((c) => `<option value="${escapeHtml(c.name)}">${escapeHtml(c.name)}</option>`).join('');
  $('colY').innerHTML = opts;
  $('filterCol').innerHTML = opts;
  $('colX').innerHTML = opts;
  $('colGroup').innerHTML = groups.length
    ? groups.map((c) => `<option value="${escapeHtml(c.name)}">${escapeHtml(c.name)}</option>`).join('')
    : '<option value="">（这份数据没有文本列）</option>';
  // 默认口径：第一列当自变量（温度/循环/时间），第二列当被测量的主列
  if (nums.length > 1) { $('colX').value = nums[0].name; $('colY').value = nums[1].name; }
  $('colGroup').disabled = groups.length === 0;
}

$('buildBtn').addEventListener('click', () => generateFromOptions());

function generateFromOptions() {
  try {
    const plan = buildPlanFromOptions();
    state.plan = plan;
    rememberPlan(plan);
    renderPlan(plan);
    show('step3', true);
    $('step3').scrollIntoView({ behavior: 'smooth', block: 'start' });
    toast(`已生成 ${plan.steps.length} 步计划`, 'ok');
    return plan;
  } catch (err) {
    toast(`生成失败：${err.message}`, 'error');
    return null;
  }
}

// ---------- 02-B 两种提需求方式切换 ----------
function switchAskTab(which) {
  document.querySelectorAll('#askTabs .tab').forEach((b) => b.classList.toggle('active', b.dataset.ask === which));
  show('askOptions', which === 'options');
  show('askText', which === 'text');
}
$('askTabs').addEventListener('click', (e) => {
  const tab = e.target.closest('.tab');
  if (tab) switchAskTab(tab.dataset.ask);
});

function buildPlanFromOptions() {
  if (!state.dataset) throw new Error('先载入数据');
  const y = $('colY').value;
  const x = $('colX').value;
  const group = $('colGroup').value;
  if (!y) throw new Error('没有可选的主列');
  const picked = INTENT_ORDER.filter((op) => selectedOps.has(op));
  if (!picked.length) throw new Error('至少选一项');

  // 筛选要排在描述统计之前：先圈定数据范围，后面的统计才有意义
  const pre = [];
  const steps = [];
  for (const op of picked) {
    let params;
    if (op === 'filter_rows') {
      const fv = Number($('filterValue').value);
      if (!Number.isFinite(fv)) throw new Error('条件筛选需要一个阈值（数字）');
      params = { column: $('filterCol').value || y, op: $('filterOp').value, value: fv };
      pre.push({ op, params });
      continue;
    }
    if (op === 'correlate' || op === 'fit_linear' || op === 'scatter') params = { x, y };
    else if (op === 'drop_outliers') params = { column: y, k: 1.5, confirm: true };
    else if (op === 'histogram') params = { column: y, bins: 8 };
    else if (op === 'group_summary' || op === 'ttest') {
      if (!group) throw new Error('这份数据没有文本列，分组类分析用不了');
      params = { groupBy: group, column: y };
    } else params = { column: y };
    steps.push({ op, params });
  }
  const ordered = [...pre, { op: 'describe', params: { column: y } }, ...steps];

  const plan = {
    version: 1,
    question: [...selectedOps].map((op) => labelOf(op)).join(' + '),
    engine: 'options',
    steps: ordered.map((s, i) => ({ id: `s${i + 1}`, ...s })),
  };
  validatePlan(plan, state.dataset);
  return plan;
}

$('compileBtn').addEventListener('click', () => compilePlan());

async function compilePlan() {
  if (!state.dataset) return toast('先在「01 数据接入」里上传或粘贴 CSV', 'warn');
  const question = $('question').value.trim();
  if (!question) return toast('先写一句你想问的问题', 'warn');
  const key = localStorage.getItem('reprolab.llmKey') || '';
  $('compileHint').textContent = '编译中…';
  $('compileBtn').disabled = true;
  try {
    let plan;
    if (key) {
      try {
        plan = await compileByLLM({
          dataset: state.dataset, question,
          endpoint: localStorage.getItem('reprolab.llmEndpoint') || 'https://api.deepseek.com/chat/completions',
          apiKey: key,
        });
      } catch (err) {
        $('compileHint').textContent = `LLM 编译失败（${err.message}），已降级为本地规则编译`;
        plan = compileByRules(state.dataset, question);
      }
    } else {
      plan = compileByRules(state.dataset, question);
    }
    state.plan = plan;
    rememberPlan(plan);
    renderPlan(plan);
    $('compileHint').textContent = plan.engine === 'llm' ? 'LLM 编译通过白名单校验' : '本地规则编译（离线可复现）';
    show('step3', true);
    $('step3').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    $('compileHint').textContent = '';
    toast(`编译失败：${err.message}`, 'error');
  } finally {
    $('compileBtn').disabled = false;
  }
}

function renderPlan(plan) {
  $('planEngine').textContent =
    plan.engine === 'llm' ? '来源：LLM 编译（已校验）'
      : plan.engine === 'options' ? '来源：点选生成（没有 AI 参与，完全确定）'
        : '来源：本地规则编译';
  const needsConfirm = plan.steps.some((s) => s.op === 'drop_outliers');
  state.needsConfirm = needsConfirm;
  $('planList').innerHTML = plan.steps.map((s, i) => {
    const danger = s.op === 'drop_outliers';
    const params = Object.entries(s.params || {}).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join('  ');
    return `<li class="${danger ? 'danger' : ''}">
      <div class="plan-row">
        <span class="plan-op">${i + 1}. ${labelOf(s.op)}</span>${danger ? '<span class="tag-danger">需人工确认 · 会删数据</span>' : ''}
        <button class="plan-del" data-index="${i}" title="从计划里删掉这一步">✕</button>
      </div>
      <div class="plan-params">${s.id} · ${s.op} · ${params || '无参数'}</div>
    </li>`;
  }).join('');
  $('planJson').textContent = JSON.stringify(plan, null, 2);
  $('confirmGate').classList.toggle('hidden', !needsConfirm);
  $('confirmDestructive').checked = false;
  syncRunButton();
}

/** 人工审阅：允许直接删掉计划的某一步（删完要重新执行） */
$('planList').addEventListener('click', (e) => {
  const btn = e.target.closest('.plan-del');
  if (!btn || !state.plan) return;
  const idx = Number(btn.dataset.index);
  const steps = state.plan.steps.filter((_, i) => i !== idx);
  if (!steps.length) return toast('至少保留一步', 'warn');
  state.plan = { ...state.plan, steps: steps.map((s, i) => ({ ...s, id: `s${i + 1}` })) };
  // 结果对应的是旧计划，作废并提示重跑
  state.run = null;
  state.claims = [];
  show('step4', false); show('step5', false);
  $('hashBox').textContent = '';
  renderPlan(state.plan);
  toast(`已删掉第 ${idx + 1} 步，请重新执行`, 'ok');
});

function labelOf(op) {
  return {
    describe: '描述统计', drop_outliers: '剔除异常点（IQR）', transform_log: '对数变换 ln(x)',
    correlate: '相关性检验', fit_linear: '线性拟合', scatter: '散点图',
    group_summary: '分组汇总', ttest: '两组均值检验（Welch t）', normalize: '标准化 z-score',
    trend: '时间趋势', histogram: '分布直方图', missing_report: '缺失值盘点',
    filter_rows: '条件筛选',
  }[op] || op;
}

$('confirmDestructive').addEventListener('change', syncRunButton);
function syncRunButton() {
  const needConfirm = state.needsConfirm && !$('confirmDestructive').checked;
  $('runBtn').disabled = needConfirm;
  $('runHint').textContent = needConfirm ? '勾选确认后才能执行（AI 不允许擅自删数据）' : '';
}

$('copyPlan').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('planJson').textContent);
    toast('计划 DSL 已复制', 'ok');
  } catch {
    toast('复制失败，请手动选中复制', 'warn');
  }
});

// ---------- 最近计划（localStorage，最近 5 个） ----------
const HISTORY_KEY = 'reprolab.planHistory';

function readHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); } catch { return []; }
}

function planSignature(p) {
  return JSON.stringify(p.steps.map((s) => [s.op, s.params]));
}

function rememberPlan(plan) {
  try {
    const list = readHistory().filter((x) => planSignature(x.plan) !== planSignature(plan));
    list.unshift({ at: Date.now(), question: plan.question || '(未命名)', engine: plan.engine || 'rules', plan });
    localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, 5)));
  } catch { /* localStorage 不可用就算了，不影响主流程 */ }
}

$('planHistoryBtn').addEventListener('click', () => {
  const box = $('planHistory');
  const list = readHistory();
  if (!list.length) return toast('还没有历史计划——生成或导入一次就会记下来', 'warn');
  box.innerHTML = '<div class="plan-history-head">最近 5 个计划<span class="hint">点「恢复」会用当前数据重新校验</span></div>' +
    list.map((x, i) => `<div class="plan-history-row">
      <span class="when">${new Date(x.at).toLocaleString('zh-CN', { hour12: false }).slice(5, 16)}</span>
      <span>${escapeHtml(String(x.question).slice(0, 38))}</span>
      <span class="why">${x.plan.steps.length} 步</span>
      <button class="btn ghost small" data-restore="${i}">恢复</button>
    </div>`).join('');
  box.classList.remove('hidden');
});

$('planHistory').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-restore]');
  if (!btn) return;
  if (!state.dataset) return toast('先载入数据，再恢复计划', 'warn');
  const entry = readHistory()[Number(btn.dataset.restore)];
  if (!entry) return;
  try {
    validatePlan(entry.plan, state.dataset);
  } catch (err) {
    return toast(`这份计划和当前数据对不上：${err.message}`, 'error');
  }
  state.plan = entry.plan;
  state.run = null;
  show('step4', false); show('step5', false);
  renderPlan(entry.plan);
  show('step3', true);
  $('planHistory').classList.add('hidden');
  toast('已恢复历史计划，点「执行计划」重算', 'ok');
});

// ---------- 计划的导出 / 导入 ----------
$('exportPlan').addEventListener('click', () => {
  if (!state.plan) return toast('先生成一份计划', 'warn');
  downloadText(`plan-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(state.plan, null, 2), 'application/json');
  toast('计划已导出，换台机器导入即可跑出同一哈希', 'ok');
});

$('importPlan').addEventListener('click', () => {
  if (!state.dataset) return toast('先载入数据，再导入计划', 'warn');
  $('planFile').click();
});

$('planFile').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const raw = await file.text();
    const plan = JSON.parse(raw);
    validatePlan(plan, state.dataset); // 列名对不上、算子越界都会在这里被拦下
    state.plan = plan;
    state.run = null;
    state.claims = [];
    show('step4', false); show('step5', false);
    $('hashBox').textContent = '';
    rememberPlan(plan);
    renderPlan(plan);
    show('step3', true);
    toast(`已导入 ${plan.steps.length} 步计划（已过白名单校验）`, 'ok');
  } catch (err) {
    toast(`导入失败：${err.message}`, 'error');
  } finally {
    e.target.value = '';
  }
});

/** 下载一段文本为一个文件 */
function downloadText(filename, text, mime = 'text/plain') {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ---------- 03 执行 ----------
$('runBtn').addEventListener('click', () => runPlan());

async function runPlan() {
  if (!state.plan) return;
  $('runBtn').disabled = true;
  $('runHint').textContent = '执行中…';
  try {
    const run = await executePlan(state.plan, state.dataset);
    const claims = buildClaims(state.plan, run.steps);
    state.run = run;
    state.claims = claims;
    renderClaims(claims, run);
    renderDropped(run);
    renderTimeline(run);
    renderChart(run);
    addChartActions();
    $('hashBox').textContent = `产物总哈希：${run.artifactHash}`;
    show('step4', true); show('step5', true);
    syncAuditButtons();
    setStatus(`执行完成 · ${run.steps.length} 步 · 已留痕`, true);
    $('runHint').textContent = '';
    $('step4').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    toast(`执行失败：${err.message}`, 'error');
    $('runHint').textContent = '';
  } finally {
    $('runBtn').disabled = false;
    syncRunButton();
  }
}

function renderClaims(claims, run) {
  const derived = new Set(['pPhrase', 'slopeSign', 'absSlope']);
  $('claims').innerHTML = claims.map((c) => {
    const text = renderClaim(c, run.steps);
    const badges = c.refs.filter((r) => !derived.has(r.field)).map((r) => {
      const v = typeof r.value === 'number' ? Number(r.value.toFixed(4)) : r.value;
      return `<span class="badge" data-step="${r.stepId}" title="点一下跳到对应步骤">${r.field} = ${v}</span>`;
    }).join('');
    const source = c.refs.map((r) => `${r.stepId}.${r.field}`).join(' · ');
    return `<div class="claim"><p>${text}</p><div>${badges}</div>
      <div class="claim-foot"><span class="verdict">${c.verdict}</span><span class="src">出处 ${source}</span></div></div>`;
  }).join('');
  $('claims').querySelectorAll('.badge').forEach((el) => {
    el.addEventListener('click', () => {
      document.querySelectorAll('.timeline li').forEach((li) => li.classList.remove('active'));
      const target = document.querySelector(`.timeline li[data-step="${el.dataset.step}"]`);
      if (target) { target.classList.add('active'); target.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
    });
  });
}

function renderDropped(run) {
  const dropped = run.droppedRows || [];
  const filtered = run.filteredRows || [];
  const excluded = run.excludedRows || [];
  if (!excluded.length) { $('droppedBox').innerHTML = ''; show('droppedBox', false); return; }
  const parts = [];
  if (dropped.length) parts.push(`剔除异常点 ${dropped.length} 行`);
  if (filtered.length) parts.push(`条件筛选 ${filtered.length} 行`);
  const shown = excluded.slice(0, 24);
  const rest = excluded.length - shown.length;
  const remaining = (state.dataset?.rowCount || 0) - excluded.length;
  $('droppedBox').innerHTML = `<span class="dropped-title">本次排除了 ${excluded.length} 行原始数据（${parts.join('，')}）</span>` +
    shown.map((r) => `<span class="chip chip-danger">CSV 第 ${r} 行</span>`).join('') +
    (rest > 0 ? `<span class="chip">…等共 ${excluded.length} 行（完整清单在复现包 run.json 里）</span>` : '') +
    (dropped.length ? '<button class="btn ghost small" id="undoDrop">撤回剔除异常点</button>' : '') +
    `<span class="hint">后面的统计基于剩下的 ${remaining} 行；条件筛选要在计划卡里删掉那一步才能恢复。</span>`;
  show('droppedBox', true);
}

$('droppedBox').addEventListener('click', async (e) => {
  if (e.target.closest('#undoDrop')) await undoDrop();
});

/** 撤回「剔除异常点」：从计划里去掉删除步骤，按完整数据重算 */
async function undoDrop() {
  if (!state.plan || !state.run) return;
  const next = withoutDropOutliers(state.plan);
  if (!next) return toast('本次计划里没有可撤回的剔除步骤', 'warn');
  const btn = $('undoDrop');
  if (btn) btn.disabled = true;
  try {
    state.plan = next;
    renderPlan(next); // 计划卡、确认门、DSL 同步
    const run = await executePlan(next, state.dataset);
    const claims = buildClaims(next, run.steps);
    state.run = run;
    state.claims = claims;
    renderClaims(claims, run);
    renderDropped(run);
    renderTimeline(run);
    renderChart(run);
    addChartActions();
    $('hashBox').textContent = `已撤回删除并按完整数据重算\n产物总哈希：${run.artifactHash}`;
    $('recheckHint').textContent = '';
    setStatus('已撤回删除 · 已按原始数据重算', true);
    toast('已撤回「剔除异常点」，结果按完整数据重新算过', 'ok');
  } catch (err) {
    toast(`撤回失败：${err.message}`, 'error');
  }
}

function renderTimeline(run) {
  $('timeline').innerHTML = run.steps.map((s, i) => `
    <li data-step="${s.id}">
      <div class="t-head"><span>${i + 1}. ${s.label}</span><span>${s.ms} ms</span></div>
      <div class="t-params">${Object.entries(s.params || {}).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join('  ') || '无参数'}</div>
      <div class="t-hash">输入 ${shortHash(s.inputHash, 12)} → 输出 ${shortHash(s.outputHash, 12)}</div>
    </li>`).join('');
}

/** 被剔除的行在图上画成空心红点：一眼看出“删了什么” */
function droppedPoints(run) {
  const scatter = run.steps.find((s) => s.op === 'scatter');
  if (!scatter) return [];
  const xCol = state.dataset.columns.find((c) => c.name === scatter.output.x);
  const yCol = state.dataset.columns.find((c) => c.name === scatter.output.y);
  if (!xCol || !yCol) return [];
  const drop = new Set(run.droppedRows || []);
  const out = [];
  state.dataset.rows.forEach((row, i) => {
    if (!drop.has(i + 2)) return;
    const x = Number(row[xCol.index]);
    const yRaw = Number(row[yCol.index]);
    const y = scatter.output.transformY === 'ln' ? Math.log(yRaw) : yRaw;
    if (Number.isFinite(x) && Number.isFinite(y)) out.push({ x, y, row: i + 2 });
  });
  return out;
}

/** 折线图：时间趋势（按记录顺序），叠一条拟合直线 */
function renderTrendChart(trendStep, run) {
  const o = trendStep.output;
  const col = state.dataset.columns.find((c) => c.name === o.column);
  if (!col) { $('chart').innerHTML = '<div class="hint">没有可画的列</div>'; return; }
  const dropped = new Set(run.droppedRows || []);
  const masked = state.dataset.rows.filter((_, i) => !dropped.has(i + 2));
  const series = [];
  masked.forEach((row, k) => {
    const v = Number(row[col.index]);
    if (Number.isFinite(v)) series.push({ x: k + 1, y: v });
  });
  if (series.length < 2) { $('chart').innerHTML = '<div class="hint">有效数据点不足</div>'; return; }

  const W = 520, H = 340, P = 52;
  const xs = series.map((p) => p.x), ys = series.map((p) => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const padY = (maxY - minY) * 0.08 || 1;
  const y0 = minY - padY, y1 = maxY + padY;
  const sx = (v) => P + ((v - minX) / (maxX - minX || 1)) * (W - 2 * P);
  const sy = (v) => H - P - ((v - y0) / (y1 - y0)) * (H - 2 * P);

  const stepN = Math.max(1, Math.ceil(series.length / 400)); // 采样，最多画 400 个点
  const pts = series.filter((_, i) => i % stepN === 0);
  const path = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join(' ');
  const ticks = Array.from({ length: 5 }, (_, i) => y0 + ((y1 - y0) * i) / 4);
  const grid = ticks.map((v) => `<line x1="${P}" y1="${sy(v).toFixed(1)}" x2="${W - P}" y2="${sy(v).toFixed(1)}" stroke="#22305c" />
    <text x="${P - 8}" y="${(sy(v) + 4).toFixed(1)}" fill="#b9c6e8" font-size="10.5" text-anchor="end">${fmtTick(v)}</text>`).join('');

  const lineY = (v) => sy(o.intercept + o.slope * v);
  const fits = `<line x1="${sx(minX).toFixed(1)}" y1="${lineY(minX).toFixed(1)}" x2="${sx(maxX).toFixed(1)}" y2="${lineY(maxX).toFixed(1)}" stroke="#7be0c4" stroke-width="2" stroke-dasharray="6 4" />`;

  $('chart').innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" width="100%" height="340" role="img" aria-label="时间趋势折线图">
      ${grid}
      <line x1="${P}" y1="${H - P}" x2="${W - P}" y2="${H - P}" stroke="#24305a" />
      <line x1="${P}" y1="${P}" x2="${P}" y2="${H - P}" stroke="#24305a" />
      <path d="${path}" fill="none" stroke="#4da3ff" stroke-width="1.6" opacity=".9" />
      ${fits}
      <text x="${W / 2}" y="${H - 6}" fill="#cbd6f2" font-size="12" text-anchor="middle">记录顺序（第几行）</text>
      <text x="${P - 42}" y="${P - 10}" fill="#cbd6f2" font-size="12">y：${escapeHtml(o.column)}</text>
    </svg>
    <div class="chart-note">每 100 行变化 ${Number(o.per100).toFixed(3)}　·　R² = ${Number(o.r2).toFixed(4)}　·　n = ${o.n}${pts.length < series.length ? `（折线抽样 ${pts.length} 点）` : ''}</div>`;
}

function renderChart(run) {
  const has = (op) => run.steps.some((s) => s.op === op);
  if (has('scatter')) return renderScatterChart(run);
  const group = run.steps.find((s) => s.op === 'group_summary');
  if (group) {
    const all = group.output.groups;
    const shown = all.length > 12 ? all.slice(0, 12) : all; // 组太多时只画前 12 组（按均值降序）
    return renderBars(shown.map((g) => ({ label: g.group, value: g.mean, sub: `n=${g.n}` })), {
      title: all.length > 12 ? `${group.output.column} 各组均值（前 12 组，共 ${all.length} 组）` : `${group.output.column} 各组均值`,
      xLabel: group.output.groupBy,
      yLabel: group.output.column,
      stepId: group.id,
      drill: { column: group.output.groupBy },
    });
  }
  const trend = run.steps.find((s) => s.op === 'trend');
  if (trend) return renderTrendChart(trend, run);
  const hist = run.steps.find((s) => s.op === 'histogram');
  if (hist) {
    return renderBars(hist.output.bins.map((b) => ({ label: b.from, value: b.count })), {
      title: `${hist.output.column} 分布`, xLabel: '区间（左边界）', yLabel: '条数', stepId: hist.id,
    });
  }
  $('chart').innerHTML = '<div class="hint">本次计划没有绘图步骤</div>';
}

/** 柱状图：分组均值 / 直方图共用；给 drill 时柱子可点，点了自动加一条筛选 */
function renderBars(items, { title, xLabel, yLabel, stepId, drill = null }) {
  if (!items.length) { $('chart').innerHTML = '<div class="hint">没有可画的数据</div>'; return; }
  const W = 520, H = 340, P = 52;
  const maxV = Math.max(...items.map((i) => i.value), 1e-9);
  const minV = Math.min(...items.map((i) => i.value), 0);
  const base = minV > 0 ? 0 : minV;
  const top = maxV * 1.12 || 1;
  const sy = (v) => H - P - ((v - base) / (top - base)) * (H - 2 * P);
  const bw = (W - 2 * P) / items.length;
  const ticks = Array.from({ length: 5 }, (_, i) => base + ((top - base) * i) / 4);

  const grid = ticks.map((v) => `<line x1="${P}" y1="${sy(v).toFixed(1)}" x2="${W - P}" y2="${sy(v).toFixed(1)}" stroke="#22305c" />
    <text x="${P - 8}" y="${(sy(v) + 4).toFixed(1)}" fill="#b9c6e8" font-size="10.5" text-anchor="end">${fmtTick(v)}</text>`).join('');

  const bars = items.map((it, i) => {
    const x = P + bw * i + bw * 0.18;
    const w = bw * 0.64;
    const y = sy(it.value);
    const h = Math.max(1, H - P - y);
    const color = it.label === 'A' ? '#4da3ff' : it.label === 'B' ? '#7be0c4' : '#4da3ff';
    const drillAttrs = drill ? ` data-drill-col="${escapeHtml(drill.column)}" data-drill-value="${escapeHtml(String(it.label))}"` : '';
    const cursor = drill ? ' style="cursor:pointer"' : '';
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="4" fill="${color}" opacity=".85"${drillAttrs}${cursor}><title>${escapeHtml(String(it.label))}: ${it.value}${drill ? '（点击只看这一组）' : ''}</title></rect>
      <text x="${(x + w / 2).toFixed(1)}" y="${(y - 6).toFixed(1)}" fill="#cbd6f2" font-size="10.5" text-anchor="middle">${fmtTick(it.value)}</text>
      <text x="${(x + w / 2).toFixed(1)}" y="${H - P + 16}" fill="#b9c6e8" font-size="10.5" text-anchor="middle"${drillAttrs}${cursor}>${escapeHtml(String(it.label))}</text>
      ${it.sub ? `<text x="${(x + w / 2).toFixed(1)}" y="${H - P + 30}" fill="#8fa0cc" font-size="9.5" text-anchor="middle">${it.sub}</text>` : ''}`;
  }).join('');

  $('chart').innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" width="100%" height="340" role="img" aria-label="${escapeHtml(title)}">
      ${grid}
      <line x1="${P}" y1="${H - P}" x2="${W - P}" y2="${H - P}" stroke="#24305a" />
      <line x1="${P}" y1="${P}" x2="${P}" y2="${H - P}" stroke="#24305a" />
      ${bars}
      <text x="${W / 2}" y="${H - 6}" fill="#cbd6f2" font-size="12" text-anchor="middle">x：${escapeHtml(xLabel)}</text>
      <text x="${P - 42}" y="${P - 10}" fill="#cbd6f2" font-size="12">y：${escapeHtml(yLabel)}</text>
    </svg>
    <div class="chart-note">${escapeHtml(title)}　·　来自步骤 ${stepId}</div>`;
}

function fmtTick(v) {
  if (!Number.isFinite(v)) return '—';
  if (Math.abs(v) >= 1000) return v.toExponential(2);
  if (Math.abs(v) >= 10) return String(Number(v.toFixed(1)));
  return String(Number(v.toFixed(2)));
}

function renderScatterChart(run) {
  const scatter = run.steps.find((s) => s.op === 'scatter');
  if (!scatter) { $('chart').innerHTML = '<div class="hint">本次计划没有绘图步骤</div>'; return; }
  const { points, line, x, y, transformY } = scatter.output;
  if (!points.length) { $('chart').innerHTML = '<div class="hint">没有有效数据点</div>'; return; }

  const dropped = droppedPoints(run);
  const all = [...points, ...dropped];
  const W = 520, H = 340, P = 52;
  const xsAll = all.map((p) => p.x), ysAll = all.map((p) => p.y);
  const minX = Math.min(...xsAll), maxX = Math.max(...xsAll);
  const minY = Math.min(...ysAll), maxY = Math.max(...ysAll);
  const padX = (maxX - minX) * 0.06 || 1, padY = (maxY - minY) * 0.08 || 1;
  const x0 = minX - padX, x1 = maxX + padX, y0 = minY - padY, y1 = maxY + padY;
  const sx = (v) => P + ((v - x0) / (x1 - x0)) * (W - 2 * P);
  const sy = (v) => H - P - ((v - y0) / (y1 - y0)) * (H - 2 * P);

  const ticks = (a, b, n = 5) => Array.from({ length: n + 1 }, (_, i) => a + ((b - a) * i) / n);
  const fmt = (v) => (Math.abs(v) >= 1000 ? v.toExponential(1) : String(Number(v.toFixed(2))));

  const grid = [
    ...ticks(y0, y1).map((v) => `<line x1="${P}" y1="${sy(v).toFixed(1)}" x2="${W - P}" y2="${sy(v).toFixed(1)}" stroke="#22305c" />
      <text x="${P - 8}" y="${(sy(v) + 4).toFixed(1)}" fill="#b9c6e8" font-size="10.5" text-anchor="end">${fmt(v)}</text>`),
    ...ticks(x0, x1).map((v) => `<text x="${sx(v).toFixed(1)}" y="${H - P + 16}" fill="#b9c6e8" font-size="10.5" text-anchor="middle">${fmt(v)}</text>`),
  ].join('');

  const dots = points.map((p) => `<circle cx="${sx(p.x).toFixed(1)}" cy="${sy(p.y).toFixed(1)}" r="3.2" fill="#4da3ff" opacity=".85"><title>CSV 第 ${p.row} 行: (${p.x}, ${p.y})</title></circle>`).join('');
  const dropDots = dropped.map((p) => `<circle cx="${sx(p.x).toFixed(1)}" cy="${sy(p.y).toFixed(1)}" r="5" fill="none" stroke="#ff6b6b" stroke-width="2" stroke-dasharray="3 2"><title>已剔除 · CSV 第 ${p.row} 行</title></circle>`).join('');
  const fit = line
    ? `<line x1="${sx(x0)}" y1="${sy(line.intercept + line.slope * x0)}" x2="${sx(x1)}" y2="${sy(line.intercept + line.slope * x1)}" stroke="#7be0c4" stroke-width="2" stroke-dasharray="6 4" opacity=".9" />`
    : '';
  const fitStep = run.steps.find((s) => s.op === 'fit_linear');
  const corrStep = run.steps.find((s) => s.op === 'correlate');
  const noteBits = [];
  if (corrStep) noteBits.push(`r = ${Number(corrStep.output.r).toFixed(4)}（${corrStep.output.strength}${corrStep.output.direction}）`);
  if (fitStep) noteBits.push(`R² = ${Number(fitStep.output.r2).toFixed(4)}`);
  if (dropped.length) noteBits.push(`空心红点 = 已剔除 ${dropped.length} 行`);

  $('chart').innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" width="100%" height="340" role="img" aria-label="散点图">
      ${grid}
      <line x1="${P}" y1="${H - P}" x2="${W - P}" y2="${H - P}" stroke="#24305a" />
      <line x1="${P}" y1="${P}" x2="${P}" y2="${H - P}" stroke="#24305a" />
      <text x="${W / 2}" y="${H - 6}" fill="#cbd6f2" font-size="12" text-anchor="middle">x：${x}</text>
      <text x="${P - 42}" y="${P - 10}" fill="#cbd6f2" font-size="12">y：${transformY === 'ln' ? `ln ${y}` : y}</text>
      ${dots}${dropDots}${fit}
    </svg>
    <div class="chart-note">${noteBits.join('　·　')}</div>`;
}

// ---------- 04 复现 ----------
$('recheckBtn').addEventListener('click', () => recheck());

async function recheck() {
  if (!state.plan || !state.run) return toast('先执行一次计划', 'warn');
  $('recheckHint').textContent = '重跑中…';
  const again = await executePlan(state.plan, state.dataset);
  const same = again.artifactHash === state.run.artifactHash;
  $('recheckHint').textContent = same ? '✅ 逐位一致：同一数据 + 同一计划，产物哈希相同' : '❌ 不一致，请检查是否有随机或时间因素';
  $('recheckHint').className = same ? 'hint ok' : 'hint bad';
  $('hashBox').textContent = `首次：${state.run.artifactHash}\n重跑：${again.artifactHash}\n${same ? '两次哈希完全一致 —— 可复现性成立。' : '两次哈希不同。'}`;
  toast(same ? '重跑一致，产物哈希逐位相同' : '重跑结果不一致', same ? 'ok' : 'error');
}

$('exportBtn').addEventListener('click', async () => {
  if (!state.run) return toast('先执行一次计划', 'warn');
  const pkg = await buildReproducePackage({
    rawCsv: state.rawCsv, dataset: state.dataset, plan: state.plan, run: state.run,
    claims: state.claims,
    meta: { question: state.plan.question, engine: state.plan.engine },
    chartSvg: currentChartSvg(),
  });
  const bytes = zipStore(pkg.files, new Date());
  const blob = new Blob([bytes], { type: 'application/zip' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `reprolab-${Date.now()}.zip`;
  a.click();
  URL.revokeObjectURL(url);
  $('hashBox').textContent = `已导出 ${pkg.files.length} 个文件\n数据 SHA-256：${pkg.dataHash}\n产物哈希：${pkg.artifactHash}\n解压后执行 node verify.mjs 可离线自校验。`;
  toast(`复现包已导出（${pkg.files.length} 个文件，含 verify.mjs）`, 'ok');
});

// ---------- 界面内自校验复现包 ----------
/** 当前图表转 SVG 字符串（放进复现包） */
function currentChartSvg() {
  const svg = document.querySelector('#chart svg');
  return svg ? new XMLSerializer().serializeToString(svg) : null;
}

$('selfCheckBtn').addEventListener('click', () => selfCheck());

async function selfCheck() {
  if (!state.run) return toast('先执行一次计划', 'warn');
  const box = $('selfCheckBox');
  box.innerHTML = '<div class="hint">校验中…</div>';
  show('selfCheckBox', true);
  try {
    const pkg = await buildReproducePackage({
      rawCsv: state.rawCsv,
      dataset: state.dataset,
      plan: state.plan,
      run: state.run,
      claims: state.claims,
      meta: { question: state.plan.question, engine: state.plan.engine },
      chartSvg: currentChartSvg(),
    });
    const meta = JSON.parse(pkg.files.find((f) => f.name === 'meta.json').text);
    const { checks, passed } = await verifyPackage({ rawCsv: state.rawCsv, plan: state.plan, run: state.run, meta });
    box.innerHTML = `<div class="self-check-head"><b>${passed ? '✓ 全部通过' : '✗ 有不通过项'}</b><span class="hint">与导出的复现包里 verify.mjs 做同一套检查</span></div>` +
      checks.map((c) => `<div class="self-check-row ${c.pass ? 'ok' : 'bad'}"><span>${c.pass ? 'PASS' : 'FAIL'}</span><span>${escapeHtml(c.name)}</span><span class="why">${escapeHtml(c.detail)}</span></div>`).join('');
    toast(passed ? '自校验全部通过' : '自校验发现不一致', passed ? 'ok' : 'error');
  } catch (err) {
    box.innerHTML = `<div class="hint bad">校验失败：${escapeHtml(err.message)}</div>`;
    toast(`自校验失败：${err.message}`, 'error');
  }
}

// ---------- 分析报告导出（HTML，可直接打印成 PDF） ----------
$('exportReport').addEventListener('click', () => {
  if (!state.run) return toast('先执行一次计划', 'warn');
  const html = analysisHtmlReport();
  downloadText(`分析报告-${new Date().toISOString().slice(0, 10)}.html`, html, 'text/html');
  toast('分析报告已导出（可用浏览器打印成 PDF）', 'ok');
});

function analysisHtmlReport() {
  const run = state.run;
  const plan = state.plan;
  const claims = state.claims.map((c) => ({ text: renderClaim(c, run.steps), verdict: c.verdict, refs: c.refs }));
  const rowStyle = 'padding:8px 10px;border-bottom:1px solid #e3e7ef;text-align:left;vertical-align:top';
  const claimsHtml = claims.map((c, i) => `<li style="margin-bottom:8px">${escapeHtml(c.text)}<div style="color:#5b6577;font-size:12px">出处：${c.refs.map((r) => `${r.stepId}.${r.field}`).join('、')}　判定：${escapeHtml(c.verdict)}</div></li>`).join('');
  const stepsHtml = run.steps.map((s, i) => `<tr>
    <td style="${rowStyle}">${i + 1}</td>
    <td style="${rowStyle}">${escapeHtml(s.label)}</td>
    <td style="${rowStyle};font-family:ui-monospace,Consolas,monospace;font-size:12px">${escapeHtml(JSON.stringify(s.params || {}))}</td>
    <td style="${rowStyle};font-family:ui-monospace,Consolas,monospace;font-size:12px">${s.inputHash.slice(0, 12)}</td>
    <td style="${rowStyle};font-family:ui-monospace,Consolas,monospace;font-size:12px">${s.outputHash.slice(0, 12)}</td>
    <td style="${rowStyle};text-align:right">${s.ms}</td>
  </tr>`).join('');
  const dropped = run.droppedRows || [];
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>分析报告 · ${escapeHtml(plan.question || '分析结果')}</title>
<style>
body{font-family:"Segoe UI","Microsoft YaHei",sans-serif;max-width:960px;margin:40px auto;padding:0 24px;color:#1b2333;line-height:1.7}
h1{font-size:22px;margin:0 0 6px} h2{font-size:15px;margin:26px 0 8px}
.meta{color:#5b6577;font-size:13px;margin-bottom:8px}
table{width:100%;border-collapse:collapse;font-size:13px}
th{color:#5b6577;font-size:12px;text-align:left;padding:8px 10px;border-bottom:1px solid #e3e7ef}
code{background:#f3f4f7;padding:1px 6px;border-radius:4px;font-size:12px}
footer{margin-top:28px;color:#8a93a5;font-size:12px}
@media print{body{margin:0}}
</style></head><body>
<h1>${escapeHtml(plan.question || '分析报告')}</h1>
<div class="meta">生成时间 ${new Date().toLocaleString('zh-CN')}　·　数据集 ${state.dataset.rowCount} 行 × ${state.dataset.columns.length} 列　·　计划来源 ${plan.engine === 'llm' ? 'LLM 编译（已校验）' : plan.engine === 'options' ? '点选生成（无 AI 参与）' : '本地规则编译'}</div>
<div class="meta">数据 SHA-256 <code>${state.dataHash ? state.dataHash : '(见复现包)'}</code>　·　产物总哈希 <code>${run.artifactHash}</code></div>
<h2>结论（每条都能回溯到计算步骤）</h2>
<ol>${claimsHtml}</ol>
<h2>步骤时间轴</h2>
<table><thead><tr><th>#</th><th>算子</th><th>参数</th><th>输入哈希</th><th>输出哈希</th><th>耗时(ms)</th></tr></thead><tbody>${stepsHtml}</tbody></table>
${dropped.length ? `<h2>数据变更</h2><p>本次剔除了 ${dropped.length} 行原始数据（CSV 行号：${dropped.slice(0, 30).join(', ')}${dropped.length > 30 ? ' …' : ''}）。</p>` : ''}
<h2>怎么复现</h2>
<ol>
<li>把这份报告对应的 <code>data.csv</code> 和计划 JSON 导入 ReproLab，点「执行计划」，产物哈希应与上面一致；</li>
<li>或者用命令行：<code>node cli.mjs check data.csv plan.json</code>，对比输出里的产物哈希；</li>
<li>导出的复现包里带 <code>verify.mjs</code>，解压后 <code>node verify.mjs</code> 可离线自校验。</li>
</ol>
<footer>由溯真 ReproLab 生成 · 纯浏览器计算，数据不出本机。</footer>
</body></html>`;
}

// ---------- 重置 ----------
$('resetBtn').addEventListener('click', () => {
  state.rawCsv = ''; state.dataset = null; state.plan = null; state.run = null; state.claims = [];
  $('pasteInput').value = '';
  $('question').value = '';
  $('datasetInfo').innerHTML = '';
  $('dataPreview').innerHTML = '';
  $('dataProfile').innerHTML = '';
  show('dataProfile', false);
  show('dataPreview', false);
  $('planList').innerHTML = '';
  $('claims').innerHTML = '';
  $('timeline').innerHTML = '';
  $('chart').innerHTML = '';
  $('hashBox').textContent = '';
  $('recheckHint').textContent = '';
  $('compileHint').textContent = '';
  show('datasetInfo', false); show('step3', false); show('step4', false); show('step5', false);
  selectedOps.clear();
  state.run = null;
  renderIntentChips();
  syncAuditButtons();
  setStatus('未载入数据');
  toast('已重置', 'ok');
});

setStatus('未载入数据');
renderIntentChips();

// ---------- 模式切换：分析 / 审计 ----------
const STEP_IDS = ['step1', 'step2', 'step3', 'step4', 'step5'];

function setMode(mode) {
  document.body.dataset.mode = mode;
  document.querySelectorAll('#modeSwitch .mode').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  show('hero', mode !== 'audit');
  if (mode === 'audit') {
    show('step1', true); ['step2','step3','step4','step5'].forEach((id) => show(id, false));
    show('auditPanel', true);
    syncAuditButtons();
    if (!state.dataset) toast('审计需要数据：先在「01 数据接入」里载入这份报告对应的 CSV', 'warn');
  } else {
    show('auditPanel', false);
    show('step1', true); show('step2', true);
    show('step3', !!state.plan); show('step4', !!state.run); show('step5', !!state.run);
  }
}

/** 审计按钮是否可用：需要数据 +（审计案 or 当前分析结果） */
function syncAuditButtons() {
  $('auditFromRun').disabled = !(state.plan && state.run && state.claims.length);
}
$('modeSwitch').addEventListener('click', (e) => {
  const btn = e.target.closest('.mode');
  if (btn) setMode(btn.dataset.mode);
});

$('heroStart').addEventListener('click', () => {
  $('step1').scrollIntoView({ behavior: 'smooth', block: 'start' });
  $('fileInput').click();
});

$('heroAudit').addEventListener('click', () => {
  setMode('audit');
  $('auditPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
});

// ---------- 审计 ----------
let auditCase = null;

async function loadAuditCase(data, source = 'JSON') {
  try {
    if (!data || !data.plan || !Array.isArray(data.claims)) throw new Error('审计案需要包含 plan 与 claims');
    auditCase = data;
    if (!state.dataset) {
      $('auditHint').textContent = '';
      toast('先在上面「数据接入」里载入这份报告对应的 CSV', 'warn');
      return;
    }
    const ops = data.plan.steps.map((s) => labelOf(s.op)).join(' → ');
    $('auditCase').innerHTML = `
      <div class="audit-meta">
        <span class="chip">报告 <b>${escapeHtml(data.title || '未命名')}</b></span>
        <span class="chip">结论 <b>${data.claims.length}</b> 条</span>
        <span class="chip">计划 <b>${data.plan.steps.length}</b> 步</span>
        <span class="chip">数据集 <b>${state.dataset.rowCount}</b> 行</span>
      </div>
      <div class="audit-plan">${escapeHtml(ops)}</div>
      ${data.note ? `<div class="hint">${escapeHtml(data.note)}</div>` : ''}`;
    show('auditCase', true);
    show('auditResult', false);
    $('auditRun').disabled = false;
    $('auditHint').textContent = `已载入（${source}），可以开始审计`;
  } catch (err) {
    $('auditHint').textContent = '';
    toast(`审计案载入失败：${err.message}`, 'error');
  }
}

$('auditPick').addEventListener('click', () => {
  if (!state.dataset) return toast('先在「数据接入」载入这份报告对应的 CSV', 'warn');
  $('auditFile').click();
});
$('auditFile').addEventListener('change', async (e) => {
  const files = [...(e.target.files || [])];
  e.target.value = '';
  if (!files.length) return;
  if (files.length === 1) {
    try { loadAuditCase(JSON.parse(await files[0].text()), files[0].name); }
    catch { toast('不是合法的 JSON 文件', 'error'); }
    return;
  }
  const cases = [];
  for (const f of files) {
    try { cases.push({ ...JSON.parse(await f.text()), __file: f.name }); }
    catch { toast(`${f.name} 不是合法 JSON，已跳过`, 'warn'); }
  }
  await runBatchAudit(cases);
});

/** 批量审计：一个实验室交来 N 份报告，一次全部重算并汇总 */
let auditBatchDetail = [];

async function runBatchAudit(cases) {
  if (!state.dataset) return toast('先在「数据接入」载入这些报告对应的 CSV', 'warn');
  if (!cases.length) return;
  $('auditHint').textContent = `批量重算 ${cases.length} 份…`;
  $('auditRun').disabled = true;
  show('auditCase', false);
  show('auditResult', false);
  try {
    const entries = [];
    const details = [];
    for (const c of cases) {
      const title = c.title || c.__file || '未命名报告';
      if (!c.plan || !Array.isArray(c.claims)) {
        entries.push({ title, summary: { total: 1, ok: 0, mismatch: 0, unreproducible: 1, passed: false } });
        details.push({ title, error: '缺少 plan 或 claims，无法审计' });
        continue;
      }
      const { results, summary } = await auditReport({
        dataset: state.dataset,
        plan: c.plan,
        claims: c.claims,
        expectedArtifactHash: c.expectedArtifactHash,
      });
      entries.push({ title, summary });
      details.push({ title, auditCase: c, results, summary });
    }
    auditBatchDetail = details;
    const summary = summarizeAudits(entries, { dataName: state.dataset.source || '' });
    renderBatchAudit(summary);
    $('auditHint').textContent = summary.passed
      ? `${summary.reports} 份全部通过`
      : `${summary.failedReports} / ${summary.reports} 份存在问题`;
    setStatus(`批量审计完成 · ${summary.reports} 份 · ${summary.claims} 条`, true);
    toast(
      summary.passed ? `${summary.reports} 份报告全部可复现` : `${summary.failedReports} 份报告有问题：不符 ${summary.mismatch} 处、无法复现 ${summary.unreproducible} 条`,
      summary.passed ? 'ok' : 'warn',
    );
  } catch (err) {
    toast(`批量审计失败：${err.message}`, 'error');
    $('auditHint').textContent = '';
  } finally {
    $('auditRun').disabled = false;
  }
}

function renderBatchAudit(summary) {
  const rows = summary.entries.map((r, i) => {
    const kind = r.passed ? 'ok' : r.mismatch ? 'bad' : 'warn';
    return `<tr class="audit-row ${kind}">
      <td class="idx">${i + 1}</td>
      <td>${escapeHtml(r.title)}</td>
      <td class="num">${r.total}</td>
      <td class="num">${r.ok}</td>
      <td class="num">${r.mismatch}</td>
      <td class="num">${r.unreproducible}</td>
      <td><span class="vchip ${r.passed ? 'ok' : 'bad'}">${r.passed ? '通过' : '不通过'}</span></td>
      <td><button class="btn ghost" data-batch="${i}">看明细</button></td>
    </tr>`;
  }).join('');

  $('auditBatch').innerHTML = `
    <div class="audit-summary ${summary.passed ? 'ok' : 'bad'}">
      <span class="verdict-big">${summary.passed
        ? `✅ ${summary.reports} 份报告全部可复现`
        : `❌ ${summary.failedReports} / ${summary.reports} 份报告存在对不上的结论`}</span>
      <span class="hint">共 ${summary.claims} 条结论 · 通过 ${summary.ok} · 不符 ${summary.mismatch} · 无法复现 ${summary.unreproducible}</span>
    </div>
    <table class="audit-table">
      <thead><tr><th>#</th><th>报告</th><th>结论</th><th>通过</th><th>不符</th><th>无法复现</th><th>判定</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="row">
      <button class="btn ghost" id="batchCopy">复制汇总（Markdown）</button>
      <button class="btn ghost" id="batchDownload">下载汇总（.md）</button>
      <span class="hint">这些报告用的是同一份数据；点「看明细」看单份的逐条判定。</span>
    </div>`;
  show('auditBatch', true);

  $('auditBatch').querySelectorAll('[data-batch]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const item = auditBatchDetail[Number(btn.dataset.batch)];
      if (!item || !item.auditCase) return toast(item?.error || '这份报告的明细不可用', 'warn');
      loadAuditCase(item.auditCase, '批量里的这一份');
      $('auditJson').value = JSON.stringify(item.auditCase, null, 2);
      runAudit();
      $('auditResult').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });

  const md = () => auditBatchToMarkdown({ summary });
  $('batchCopy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(md()); toast('汇总已复制', 'ok'); }
    catch { toast('复制失败，可用「下载汇总」', 'warn'); }
  });
  $('batchDownload').addEventListener('click', () => {
    downloadText('批量审计汇总.md', md(), 'text/markdown;charset=utf-8');
    toast('汇总已下载', 'ok');
  });
}

$('auditFromRun').addEventListener('click', () => {
  const c = auditCaseFromRun();
  if (!c) return toast('先在「分析」里跑一次，再来生成审计案', 'warn');
  $('auditJson').value = JSON.stringify(c, null, 2);
  $('auditJsonWrap').open = true;
  loadAuditCase(c, '当前分析结果');
});

$('auditTemplate').addEventListener('click', () => {
  if (!state.dataset) return toast('先载入数据，再生成模板', 'warn');
  downloadText('审计案模板.json', JSON.stringify(auditTemplate(), null, 2), 'application/json');
  toast('模板已下载：照着 claims 填你报告里的结论', 'ok');
});

/** 生成一份空白的审计案模板（列名取当前数据的前两列数值 + 第一列文本） */
function auditTemplate() {
  const nums = state.dataset.columns.filter((c) => c.kind === 'number');
  const strs = state.dataset.columns.filter((c) => c.kind === 'string');
  const y = (nums[1] || nums[0] || {}).name;
  const x = (nums[0] || {}).name;
  const g = (strs[0] || {}).name;
  const steps = [];
  if (y) steps.push({ id: 's1', op: 'describe', params: { column: y } });
  if (x && y && x !== y) steps.push({ id: `s${steps.length + 1}`, op: 'correlate', params: { x, y } });
  if (g && y) steps.push({ id: `s${steps.length + 1}`, op: 'group_summary', params: { groupBy: g, column: y } });
  const corr = steps.find((s) => s.op === 'correlate');
  return {
    title: '（改成你的报告名字）',
    note: 'claims 里每条对应报告里的一句话：stepId + field 指向上面的步骤字段，value 填报告写的数字，正文里也要写同一个数字。',
    plan: { version: 1, question: '（这份报告要回答的问题）', steps },
    claims: [
      corr
        ? { text: '示例：两列呈强负相关（r = -0.96）', stepId: corr.id, field: 'r', value: -0.96 }
        : { text: '示例：均值 12.3', stepId: steps[0]?.id || 's1', field: 'n', value: 0 },
    ],
    expectedArtifactHash: '',
  };
}

$('auditUseJson').addEventListener('click', () => {
  try {
    const c = JSON.parse($('auditJson').value);
    loadAuditCase(c, '文本框');
    runAudit();
  } catch (e) { toast(`JSON 不合法：${e.message}`, 'error'); }
});

/** 拿当前会话的分析结果生成一份审计案（只取能重算的数字字段，保证不会自己判自己无法复现） */
function auditCaseFromRun() {
  if (!state.plan || !state.run || !state.claims.length) return null;
  const byId = new Map(state.run.steps.map((s) => [s.id, s]));
  const claims = [];
  for (const c of state.claims) {
    for (const r of c.refs) {
      const step = byId.get(r.stepId);
      const actual = resolveStepField(step, r.field);
      if (typeof actual !== 'number') continue;
      claims.push({ text: `${labelOf(step.op)} · ${r.field}`, stepId: r.stepId, field: r.field, value: actual });
    }
  }
  if (!claims.length) return null;
  return {
    title: `${state.plan.question || '本次分析'} · 自动生成`,
    note: '由当前会话的分析结果生成，用于验证「自己验自己」的闭环。',
    plan: state.plan,
    claims,
    expectedArtifactHash: state.run.artifactHash,
  };
}

$('auditRun').addEventListener('click', () => runAudit());

async function runAudit() {
  const raw = ($('auditJson')?.value || '').trim();
  if (raw) {
    try { auditCase = JSON.parse(raw); }
    catch (e) { return toast(`审计案 JSON 不合法：${e.message}`, 'error'); }
  }
  if (!auditCase) return toast('先载入一份审计案', 'warn');
  $('auditRun').disabled = true;
  $('auditHint').textContent = '重算中…';
  try {
    const { results, summary } = await auditReport({
      dataset: state.dataset,
      plan: auditCase.plan,
      claims: auditCase.claims,
      expectedArtifactHash: auditCase.expectedArtifactHash,
    });
    renderAudit(results, summary);
    $('auditHint').textContent = summary.passed ? '全部通过' : '存在对不上的条目';
    setStatus(`审计完成 · ${summary.total} 条`, true);
    toast(summary.passed ? '报告全部通过' : `发现 ${summary.mismatch} 处不一致、${summary.unreproducible} 条无法复现`, summary.passed ? 'ok' : 'warn');
  } catch (err) {
    toast(`审计失败：${err.message}`, 'error');
    $('auditHint').textContent = '';
  } finally {
    $('auditRun').disabled = false;
  }
}

function renderAudit(results, summary) {
  const chip = { ok: ['通过', 'ok'], mismatch: ['不符', 'bad'], unreproducible: ['无法复现', 'warn'] };
  const rows = results.map((r, i) => {
    const [label, kind] = chip[r.verdict];
    const declared = r.declared === undefined ? '—' : String(r.declared);
    const actual = r.actual === undefined ? '—' : String(typeof r.actual === 'number' ? Number(r.actual.toFixed(6)) : r.actual);
    return `<tr class="audit-row ${kind}">
      <td class="idx">${i + 1}</td>
      <td>${escapeHtml(r.text)}</td>
      <td class="num">${declared}</td>
      <td class="num">${actual}</td>
      <td><span class="vchip ${kind}">${label}</span></td>
      <td class="why">${escapeHtml(r.reason || '')}</td>
    </tr>`;
  }).join('');

  $('auditResult').innerHTML = `
    <div class="audit-summary ${summary.passed ? 'ok' : 'bad'}">
      <span class="verdict-big">${summary.passed ? '✅ 全部通过' : '❌ 存在对不上的结论'}</span>
      <span class="hint">共 ${summary.total} 条 · 通过 ${summary.ok} · 不符 ${summary.mismatch} · 无法复现 ${summary.unreproducible}</span>
      <span class="hint">重算产物哈希 <code>${shortHash(summary.artifactHash, 16)}</code>${summary.hashMatches === null ? '' : summary.hashMatches ? '（与报告声明一致）' : '（与报告声明不一致）'}</span>
    </div>
    <table class="audit-table">
      <thead><tr><th>#</th><th>报告里的结论</th><th>报告值</th><th>重算值</th><th>判定</th><th>说明</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="row">
      <button class="btn ghost" id="auditCopy">复制审计报告（Markdown）</button>
      <button class="btn ghost" id="auditExport">导出审计报告（HTML）</button>
      <span class="hint">审计只重算、不改数据；每条差异都写明是哪个步骤的哪个字段。</span>
    </div>`;
  show('auditResult', true);

  $('auditCopy').addEventListener('click', async () => {
    const md = auditToMarkdown({ title: auditCase?.title || '报告审计结果', summary, results });
    try { await navigator.clipboard.writeText(md); toast('审计报告已复制', 'ok'); }
    catch { toast('复制失败，可手动选中表格', 'warn'); }
  });

  $('auditExport').addEventListener('click', () => {
    const html = auditHtmlReport({ title: auditCase?.title || '报告审计结果', summary, results, dataset: state.dataset });
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `审计报告-${new Date().toISOString().slice(0, 10)}.html`;
    a.click();
    URL.revokeObjectURL(url);
    toast('审计报告已导出（可用浏览器打印成 PDF）', 'ok');
  });
}

/** 审计结果 → 可打印的独立 HTML（浅色，打印/存 PDF 都好看） */
function auditHtmlReport({ title, summary, results, dataset }) {
  const chip = {
    ok: ['通过', '#0f7b4f', '#e6f7ef'],
    mismatch: ['不符', '#b42318', '#fdecea'],
    unreproducible: ['无法复现', '#8a5a00', '#fff6e5'],
  };
  const rows = results.map((r, i) => {
    const [label, color, bg] = chip[r.verdict];
    const declared = r.declared === undefined ? '—' : String(r.declared);
    const actual = r.actual === undefined ? '—' : String(typeof r.actual === 'number' ? Number(r.actual.toFixed(6)) : r.actual);
    return `<tr><td>${i + 1}</td><td>${escapeHtml(r.text)}</td><td class="num">${declared}</td><td class="num">${actual}</td><td><span class="chip" style="color:${color};background:${bg}">${label}</span></td><td class="why">${escapeHtml(r.reason || '')}</td></tr>`;
  }).join('');
  const hashNote = summary.hashMatches === null ? '' : summary.hashMatches ? '（与报告声明一致）' : '（与报告声明不一致）';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>
body{font-family:"Segoe UI","Microsoft YaHei",sans-serif;max-width:960px;margin:40px auto;padding:0 24px;color:#1b2333}
h1{font-size:22px;margin:0 0 6px}
.meta{color:#5b6577;font-size:13px;margin-bottom:20px}
.banner{padding:12px 16px;border-radius:10px;margin:16px 0;font-weight:600}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{padding:8px 10px;border-bottom:1px solid #e3e7ef;text-align:left;vertical-align:top}
th{color:#5b6577;font-size:12px}
td.num{text-align:right;font-variant-numeric:tabular-nums}
td.why{color:#5b6577;font-size:12px}
.chip{display:inline-block;padding:1px 8px;border-radius:999px;font-size:12px}
code{background:#f3f4f7;padding:1px 6px;border-radius:4px;font-size:12px}
footer{margin-top:28px;color:#8a93a5;font-size:12px}
@media print{body{margin:0}}
</style></head><body>
<h1>${escapeHtml(title)}</h1>
<div class="meta">审计时间 ${new Date().toLocaleString('zh-CN')}　·　数据集 ${dataset ? dataset.rowCount : '?'} 行　·　重算产物哈希 <code>${summary.artifactHash.slice(0, 24)}…</code>${hashNote}</div>
<div class="banner" style="background:${summary.passed ? '#e6f7ef' : '#fdecea'};color:${summary.passed ? '#0f7b4f' : '#b42318'}">${summary.passed ? '✓ 全部通过' : '✗ 存在对不上的结论'}：共 ${summary.total} 条，通过 ${summary.ok} · 不符 ${summary.mismatch} · 无法复现 ${summary.unreproducible}</div>
<table><thead><tr><th>#</th><th>报告里的结论</th><th>报告值</th><th>重算值</th><th>判定</th><th>说明</th></tr></thead><tbody>${rows}</tbody></table>
<footer>由溯真 ReproLab 生成：每条判定都用「原始数据 + 分析计划」重新执行得到，可用 reprolab 命令行复现。</footer>
</body></html>`;
}

/** 图表导出：SVG 直接序列化，PNG 用 canvas 光栅化（2 倍图） */
/** 图表下钻：点某个分组柱子 → 计划最前面加一条筛选，然后直接重算 */
async function drillToGroup(column, value) {
  if (!state.plan) return;
  const dup = state.plan.steps.some((s) => s.op === 'filter_rows' && s.params.column === column && s.params.op === '==' && String(s.params.value) === String(value));
  if (dup) return toast(`计划里已经有「${column} = ${value}」这个筛选了`, 'warn');
  const steps = [{ op: 'filter_rows', params: { column, op: '==', value } }, ...state.plan.steps];
  state.plan = {
    ...state.plan,
    question: `${state.plan.question || ''}（只看 ${value}）`.trim(),
    steps: steps.map((s, i) => ({ ...s, id: `s${i + 1}` })),
  };
  state.run = null;
  show('step4', false); show('step5', false);
  renderPlan(state.plan);
  toast(`已加筛选：${column} = ${value}，正在重算…`, 'ok');
  await runPlan();
}

function addChartActions() {
  const el = $('chart');
  const svg = el.querySelector('svg');
  if (!svg || el.querySelector('.chart-actions')) return;
  el.insertAdjacentHTML('beforeend', '<div class="chart-actions"><button class="btn ghost small" data-act="svg">下载 SVG</button><button class="btn ghost small" data-act="png">下载 PNG</button></div>');
}

$('chart').addEventListener('click', async (e) => {
  // 先看是不是「点柱子下钻」，再处理下载按钮
  const drillEl = e.target.closest('[data-drill-value]');
  if (drillEl) {
    const col = drillEl.getAttribute('data-drill-col');
    const val = drillEl.getAttribute('data-drill-value');
    if (col && val) return drillToGroup(col, val);
  }
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (!act) return;
  const svg = $('chart').querySelector('svg');
  if (!svg) return;
  const xml = new XMLSerializer().serializeToString(svg);
  if (act === 'svg') {
    downloadText(`图表-${Date.now()}.svg`, `<?xml version="1.0" encoding="UTF-8"?>
${xml}`, 'image/svg+xml');
    toast('SVG 已下载', 'ok');
    return;
  }
  try {
    const img = new Image();
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml);
    await img.decode();
    const scale = 2;
    const canvas = document.createElement('canvas');
    canvas.width = svg.viewBox.baseVal.width * scale || 520 * scale;
    canvas.height = svg.viewBox.baseVal.height * scale || 340 * scale;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#0d1428';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    canvas.toBlob((blob) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `图表-${Date.now()}.png`;
      a.click();
      URL.revokeObjectURL(url);
      toast('PNG 已下载（2 倍图）', 'ok');
    }, 'image/png');
  } catch (err) {
    toast(`导出 PNG 失败：${err.message}`, 'error');
  }
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
