import { toDataset } from '../kernel/csv.js';
import { executePlan } from '../kernel/index.js';
import { compileByRules, compileByLLM, buildClaims, renderClaim } from '../planner.js';
import { sha256, shortHash } from '../kernel/hash.js';
import { buildReproducePackage } from '../export/package.js';
import { zipStore } from '../export/zip.js';

const $ = (id) => document.getElementById(id);
const state = { rawCsv: '', dataset: null, plan: null, run: null, claims: [], needsConfirm: false };

function setStatus(text, live = false) {
  const pill = $('statusPill');
  pill.textContent = text;
  pill.classList.toggle('live', live);
}

function show(id, visible = true) {
  $(id).classList.toggle('hidden', !visible);
}

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
    setStatus(`已载入 ${dataset.rowCount} 行 · 原始层只读`, true);
    show('step3', false); show('step4', false); show('step5', false);
  } catch (err) {
    alert(`解析失败：${err.message}`);
  }
}

$('fileInput').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (file) loadCsv(await file.text(), file.name);
});
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
  if (!text) return alert('先粘贴 CSV 内容');
  loadCsv(text, '粘贴');
});
$('loadSample').addEventListener('click', async () => {
  const res = await fetch('./sample-data/thermal.csv');
  loadCsv(await res.text(), '示例 thermal.csv');
});

// ---------- 02 编译计划 ----------
$('toggleLLM').addEventListener('click', () => {
  const box = $('llmBox');
  box.classList.toggle('hidden');
  $('llmKey').value = localStorage.getItem('reprolab.llmKey') || '';
  $('llmEndpoint').value = localStorage.getItem('reprolab.llmEndpoint') || 'https://api.deepseek.com/chat/completions';
});
$('saveLLM').addEventListener('click', () => {
  localStorage.setItem('reprolab.llmKey', $('llmKey').value.trim());
  localStorage.setItem('reprolab.llmEndpoint', $('llmEndpoint').value.trim());
  $('compileHint').textContent = '已保存，下次编译优先走 LLM';
});

$('compileBtn').addEventListener('click', async () => {
  if (!state.dataset) return alert('先载入数据');
  const question = $('question').value.trim();
  if (!question) return alert('先写一句你想问的问题');
  const key = localStorage.getItem('reprolab.llmKey') || '';
  $('compileHint').textContent = '编译中…';
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
  } catch (err) {
    $('compileHint').textContent = '';
    alert(`编译失败：${err.message}`);
  }
});

function renderPlan(plan) {
  $('planEngine').textContent = plan.engine === 'llm' ? '来源：LLM 编译（已校验）' : '来源：本地规则编译';
  const needsConfirm = plan.steps.some((s) => s.op === 'drop_outliers');
  state.needsConfirm = needsConfirm;
  $('planList').innerHTML = plan.steps.map((s, i) => {
    const danger = s.op === 'drop_outliers';
    const params = Object.entries(s.params || {}).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join('  ');
    return `<li class="${danger ? 'danger' : ''}">
      <div><span class="plan-op">${i + 1}. ${labelOf(s.op)}</span>${danger ? '<span class="tag-danger">需人工确认 · 会删数据</span>' : ''}</div>
      <div class="plan-params">${s.id} · ${s.op} · ${params || '无参数'}</div>
    </li>`;
  }).join('');
  $('confirmGate').classList.toggle('hidden', !needsConfirm);
  $('confirmDestructive').checked = false;
  syncRunButton();
}

function labelOf(op) {
  return {
    describe: '描述统计', drop_outliers: '剔除异常点（IQR）', transform_log: '对数变换 ln(x)',
    correlate: '相关性检验', fit_linear: '线性拟合', scatter: '散点图',
  }[op] || op;
}

$('confirmDestructive').addEventListener('change', syncRunButton);
function syncRunButton() {
  const needConfirm = state.needsConfirm && !$('confirmDestructive').checked;
  $('runBtn').disabled = needConfirm;
  $('runHint').textContent = needConfirm ? '勾选确认后才能执行（AI 不允许擅自删数据）' : '';
}

// ---------- 03 执行 ----------
$('runBtn').addEventListener('click', async () => {
  if (!state.plan) return;
  $('runBtn').disabled = true;
  $('runHint').textContent = '执行中…';
  try {
    const run = await executePlan(state.plan, state.dataset);
    const claims = buildClaims(state.plan, run.steps);
    state.run = run;
    state.claims = claims;
    renderClaims(claims, run);
    renderTimeline(run);
    renderChart(run);
    $('hashBox').textContent = `产物总哈希：${run.artifactHash}`;
    show('step4', true); show('step5', true);
    setStatus('执行完成 · 已留痕', true);
    $('runHint').textContent = '';
  } catch (err) {
    alert(`执行失败：${err.message}`);
    $('runHint').textContent = '';
  } finally {
    $('runBtn').disabled = false;
    syncRunButton();
  }
});

function renderClaims(claims, run) {
  $('claims').innerHTML = claims.map((c) => {
    const text = renderClaim(c, run.steps);
    const badges = c.refs.map((r) => {
      const v = typeof r.value === 'number' ? Number(r.value.toFixed(4)) : r.value;
      return `<span class="badge" data-step="${r.stepId}">${r.field} = ${v}</span>`;
    }).join('');
    return `<div class="claim"><p>${text}</p>${badges}<div class="verdict">${c.verdict}</div></div>`;
  }).join('');
  $('claims').querySelectorAll('.badge').forEach((el) => {
    el.addEventListener('click', () => {
      document.querySelectorAll('.timeline li').forEach((li) => li.classList.remove('active'));
      const target = document.querySelector(`.timeline li[data-step="${el.dataset.step}"]`);
      if (target) { target.classList.add('active'); target.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
    });
  });
}

function renderTimeline(run) {
  $('timeline').innerHTML = run.steps.map((s, i) => `
    <li data-step="${s.id}">
      <div class="t-head"><span>${i + 1}. ${s.label}</span><span>${s.ms} ms</span></div>
      <div class="t-hash">输入 ${shortHash(s.inputHash, 12)} → 输出 ${shortHash(s.outputHash, 12)}</div>
    </li>`).join('');
}

function renderChart(run) {
  const scatter = run.steps.find((s) => s.op === 'scatter');
  if (!scatter) { $('chart').innerHTML = '<div class="hint">本次计划没有绘图步骤</div>'; return; }
  const { points, line, x, y, transformY } = scatter.output;
  if (!points.length) { $('chart').innerHTML = '<div class="hint">没有有效数据点</div>'; return; }
  const W = 480, H = 320, P = 40;
  const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const sx = (v) => P + ((v - minX) / (maxX - minX || 1)) * (W - 2 * P);
  const sy = (v) => H - P - ((v - minY) / (maxY - minY || 1)) * (H - 2 * P);
  const dots = points.map((p) => `<circle cx="${sx(p.x).toFixed(1)}" cy="${sy(p.y).toFixed(1)}" r="3" fill="#4da3ff" opacity=".85"><title>行 ${p.row}: (${p.x}, ${p.y})</title></circle>`).join('');
  const fit = line ? `<line x1="${sx(minX)}" y1="${sy(line.intercept + line.slope * minX)}" x2="${sx(maxX)}" y2="${sy(line.intercept + line.slope * maxX)}" stroke="#7be0c4" stroke-width="2" stroke-dasharray="6 4" />` : '';
  $('chart').innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" width="100%" height="320" role="img" aria-label="散点图">
      <line x1="${P}" y1="${H - P}" x2="${W - P}" y2="${H - P}" stroke="#24305a" />
      <line x1="${P}" y1="${P}" x2="${P}" y2="${H - P}" stroke="#24305a" />
      ${dots}${fit}
      <text x="${W - P}" y="${H - P + 18}" fill="#93a0c4" font-size="11" text-anchor="end">${x}</text>
      <text x="${P - 6}" y="${P + 4}" fill="#93a0c4" font-size="11" text-anchor="end">${transformY === 'ln' ? `ln ${y}` : y}</text>
    </svg>`;
}

// ---------- 04 复现 ----------
$('recheckBtn').addEventListener('click', async () => {
  if (!state.plan) return;
  $('recheckHint').textContent = '重跑中…';
  const again = await executePlan(state.plan, state.dataset);
  const same = again.artifactHash === state.run.artifactHash;
  $('recheckHint').textContent = same ? '✅ 逐位一致：同一数据 + 同一计划，产物哈希相同' : '❌ 不一致，请检查是否有随机或时间因素';
  $('hashBox').textContent = `首次：${state.run.artifactHash}\n重跑：${again.artifactHash}`;
});

$('exportBtn').addEventListener('click', async () => {
  if (!state.run) return;
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
  $('hashBox').textContent = `已导出 ${pkg.files.length} 个文件\n数据 SHA-256：${pkg.dataHash}\n产物哈希：${pkg.artifactHash}`;
});

setStatus('未载入数据');
