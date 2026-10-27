// 计划 DSL：校验 + 执行。AI 只能产出这套结构，超出即拒绝执行。
import { OPERATORS, DESTRUCTIVE } from './ops.js';
import { sha256, stableStringify } from './hash.js';

export const DSL_VERSION = 1;

export class PlanError extends Error {}

/** 白名单 + 参数类型校验（替代 zod，零依赖） */
export function validatePlan(plan, dataset) {
  const errors = [];
  if (!plan || typeof plan !== 'object') throw new PlanError('计划必须是对象');
  if (plan.version !== DSL_VERSION) errors.push(`version 必须是 ${DSL_VERSION}`);
  if (!Array.isArray(plan.steps) || plan.steps.length === 0) errors.push('steps 不能为空');
  if (plan.steps.length > 12) errors.push('steps 超过 12 步，请拆小问题');

  const columns = new Set(dataset?.columns?.map((c) => c.name) || []);
  const ids = new Set();

  (plan.steps || []).forEach((step, i) => {
    const at = `steps[${i}]`;
    if (typeof step?.id !== 'string' || !step.id) errors.push(`${at}.id 必填`);
    else if (ids.has(step.id)) errors.push(`${at}.id 重复：${step.id}`);
    else ids.add(step.id);

    if (!OPERATORS[step.op]) {
      errors.push(`${at}.op 不在白名单：${step.op}（可用：${Object.keys(OPERATORS).join(', ')}）`);
      return;
    }
    const spec = OPERATORS[step.op].params;
    for (const [key, type] of Object.entries(spec)) {
      const optional = type.endsWith('?');
      const base = type.replace('?', '');
      const value = step.params?.[key];
      if (value === undefined) { if (!optional) errors.push(`${at}.params.${key} 必填`); continue; }
      if (base === 'number' && !Number.isFinite(Number(value))) errors.push(`${at}.params.${key} 必须是数字`);
      if (base === 'string' && typeof value !== 'string') errors.push(`${at}.params.${key} 必须是字符串`);
      if (base === 'string' && columns.size > 0 && ['column', 'x', 'y'].includes(key) && !columns.has(value)) {
        errors.push(`${at}.params.${key} 不存在列：${value}`);
      }
    }
    if (DESTRUCTIVE.has(step.op) && step.params?.confirm !== true) {
      errors.push(`${at} 是破坏性步骤（${step.op}），必须带 confirm: true 由人工确认`);
    }
  });

  if (errors.length) throw new PlanError(errors.join('\n'));
  return true;
}

/** 产物指纹的唯一口径：导出、复跑校验、复现包自校验都用这个函数 */
export function canonicalArtifact(plan, steps, droppedRows) {
  return {
    plan: {
      version: plan.version,
      question: plan.question || '',
      steps: plan.steps.map((s) => ({ id: s.id, op: s.op, params: s.params || {} })),
    },
    outputs: steps.map((s) => ({ id: s.id, op: s.op, output: s.output })),
    droppedRows: droppedRows || [],
  };
}

/** 执行计划：每步都留 输入哈希 / 输出哈希 / 耗时，供溯源与重跑比对 */
export async function executePlan(plan, dataset) {
  validatePlan(plan, dataset);
  const steps = [];
  const state = { dataset, droppedRows: [], transforms: [] };
  const inputHashes = [];

  for (const step of plan.steps) {
    const inputSnapshot = snapshot(state);
    const inputHash = await sha256(stableStringify(inputSnapshot));
    const t0 = performanceNow();
    const output = OPERATORS[step.op].run(state, step.params || {});
    const ms = Math.max(0, performanceNow() - t0);
    const outputHash = await sha256(stableStringify(output));

    if (output.droppedRows) state.droppedRows = output.droppedRows;
    if (output.transform === 'ln') state.transforms.push({ column: output.column, transform: 'ln' });

    steps.push({
      id: step.id,
      op: step.op,
      label: OPERATORS[step.op].label,
      params: step.params || {},
      destructive: DESTRUCTIVE.has(step.op),
      inputHash,
      outputHash,
      ms: Number(ms.toFixed(3)),
      output,
    });
    inputHashes.push(inputHash);
  }

  const artifact = canonicalArtifact(plan, steps, state.droppedRows);
  const artifactHash = await sha256(stableStringify(artifact));
  return { steps, artifact, artifactHash, droppedRows: state.droppedRows };
}

function snapshot(state) {
  return {
    rows: state.dataset.rows.length,
    columns: state.dataset.columns.map((c) => `${c.name}:${c.kind}`),
    droppedRows: [...(state.droppedRows || [])].sort((a, b) => a - b),
    transforms: state.transforms,
  };
}

function performanceNow() {
  return typeof performance !== 'undefined' && performance.now ? performance.now() : Number(process.hrtime.bigint() / 1000n) / 1000;
}
