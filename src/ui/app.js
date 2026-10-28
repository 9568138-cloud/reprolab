import { toDataset } from '../kernel/csv.js';
import { executePlan, validatePlan } from '../kernel/index.js';
import { compileByRules, compileByLLM, buildClaims, renderClaim, groupCandidates, withoutDropOutliers } from '../planner.js';
import { sha256, shortHash } from '../kernel/hash.js';
import { buildReproducePackage } from '../export/package.js';
import { auditReport, auditToMarkdown } from '../audit.js';
import { zipStore } from '../export/zip.js';

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
async function loadCsv(text, label = 'CSV') {
  try {
    const dataset = toDataset(text);
    state.rawCsv = text;
    state.dataset = dataset;
    state.plan = null;
    state.run = null;
    const hash = await sha256(text);
    const numeric = dataset.columns.filter((c) => c.kind === 'number').map((c) => c.name);
    $('datasetInfo').innerHTML = [
      `<span class="chip">来源 <b>${label}</b></span>`,
      `<span class="chip">行数 <b>${dataset.rowCount}</b></span>`,
      `<span class="chip">列数 <b>${dataset.columns.length}</b></span>`,
      `<span class="chip">数值列 <b>${numeric.join(' / ') || '无'}</b></span>`,
      `<span class="chip">SHA-256 <b>${shortHash(hash, 16)}</b></span>`,
    ].join('');
    show('datasetInfo', true);
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
  if (file) loadCsv(await file.text(), file.name);
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
const dropzone = $('dropzone');
dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('drag'); });
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag'));
dropzone.addEventListener('drop', async (e) => {
  e.preventDefault(); dropzone.classList.remove('drag');
  const file = e.dataTransfer?.files?.[0];
  if (file) loadCsv(await file.text(), file.name);
});
$('loadPaste').addEventListener('click', () => {
  const text = $('pasteInput').value.trim();
  if (!text) return toast('先粘贴 CSV 内容', 'warn');
  loadCsv(text, '粘贴');
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
  { op: 'missing_report', label: '缺失盘点', hint: '数有多少空单元格' },
];
const INTENT_ORDER = ['missing_report', 'normalize', 'drop_outliers', 'transform_log', 'group_summary', 'ttest', 'correlate', 'fit_linear', 'trend', 'histogram', 'scatter'];
const selectedOps = new Set();

function renderIntentChips() {
  const hasGroup = !!getGroupColumns().length;
  $('intentChips').innerHTML = INTENTS.map((it) => {
    const blocked = it.need === 'group' && !hasGroup;
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

  const steps = [{ id: 's1', op: 'describe', params: { column: y } }];
  for (const op of picked) {
    let params;
    if (op === 'correlate' || op === 'fit_linear' || op === 'scatter') params = { x, y };
    else if (op === 'drop_outliers') params = { column: y, k: 1.5, confirm: true };
    else if (op === 'histogram') params = { column: y, bins: 8 };
    else if (op === 'group_summary' || op === 'ttest') {
      if (!group) throw new Error('这份数据没有文本列，分组类分析用不了');
      params = { groupBy: group, column: y };
    } else params = { column: y };
    steps.push({ id: `s${steps.length + 1}`, op, params });
  }

  const plan = {
    version: 1,
    question: [...selectedOps].map((op) => labelOf(op)).join(' + '),
    engine: 'options',
    steps,
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
    $('hashBox').textContent = `产物总哈希：${run.artifactHash}`;
    show('step4', true); show('step5', true);
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
  const rows = run.droppedRows || [];
  if (!rows.length) { $('droppedBox').innerHTML = ''; show('droppedBox', false); return; }
  const shown = rows.slice(0, 24);
  const rest = rows.length - shown.length;
  $('droppedBox').innerHTML = `<span class="dropped-title">本次删除了 ${rows.length} 行原始数据</span>` +
    shown.map((r) => `<span class="chip chip-danger">CSV 第 ${r} 行</span>`).join('') +
    (rest > 0 ? `<span class="chip">…等共 ${rows.length} 行（完整清单在复现包 run.json 里）</span>` : '') +
    '<button class="btn ghost small" id="undoDrop">撤回这次删除</button>' +
    '<span class="hint">撤回后按完整数据重算，产物哈希会变（已导出的复现包不受影响）。</span>';
  show('droppedBox', true);
}

$('droppedBox').addEventListener('click', async (e) => {
  if (e.target.closest('#undoDrop')) await undoDrop();
});

/** 撤回「剔除异常点」：从计划里去掉删除步骤，按完整数据重算 */
async function undoDrop() {
  if (!state.plan || !state.run) return;
  const next = withoutDropOutliers(state.plan);
  if (!next) return toast('本次计划里没有可撤回的删除步骤', 'warn');
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

/** 柱状图：分组均值 / 直方图共用 */
function renderBars(items, { title, xLabel, yLabel, stepId }) {
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
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="4" fill="${color}" opacity=".85"><title>${escapeHtml(String(it.label))}: ${it.value}</title></rect>
      <text x="${(x + w / 2).toFixed(1)}" y="${(y - 6).toFixed(1)}" fill="#cbd6f2" font-size="10.5" text-anchor="middle">${fmtTick(it.value)}</text>
      <text x="${(x + w / 2).toFixed(1)}" y="${H - P + 16}" fill="#b9c6e8" font-size="10.5" text-anchor="middle">${escapeHtml(String(it.label))}</text>
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
    claims: state.claims, meta: { question: state.plan.question, engine: state.plan.engine },
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

// ---------- 重置 ----------
$('resetBtn').addEventListener('click', () => {
  state.rawCsv = ''; state.dataset = null; state.plan = null; state.run = null; state.claims = [];
  $('pasteInput').value = '';
  $('question').value = '';
  $('datasetInfo').innerHTML = '';
  $('dataPreview').innerHTML = '';
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
    if (!state.dataset) toast('审计需要数据：先在「01 数据接入」里载入这份报告对应的 CSV', 'warn');
  } else {
    show('auditPanel', false);
    show('step1', true); show('step2', true);
    show('step3', !!state.plan); show('step4', !!state.run); show('step5', !!state.run);
  }
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
  const file = e.target.files?.[0];
  if (!file) return;
  try { loadAuditCase(JSON.parse(await file.text()), file.name); }
  catch { toast('不是合法的 JSON 文件', 'error'); }
});

$('auditRun').addEventListener('click', () => runAudit());

async function runAudit() {
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
      <span class="hint">审计只重算、不改数据；每条差异都写明是哪个步骤的哪个字段。</span>
    </div>`;
  show('auditResult', true);

  $('auditCopy').addEventListener('click', async () => {
    const md = auditToMarkdown({ title: auditCase?.title || '报告审计结果', summary, results });
    try { await navigator.clipboard.writeText(md); toast('审计报告已复制', 'ok'); }
    catch { toast('复制失败，可手动选中表格', 'warn'); }
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
