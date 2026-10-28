// 复现包自校验（界面内版本）
// 与 package.js 里生成的 verify.mjs 做同样的 5 项检查——那边要保持"解压即可独立运行"，
// 所以逻辑是两处实现；改动这里的任何一条，记得同步改 package.js 的 verifyScript()。
import { sha256, stableStringify } from '../kernel/hash.js';
import { canonicalArtifact } from '../kernel/index.js';
import { OPERATORS } from '../kernel/ops.js';

export async function verifyPackage({ rawCsv, plan, run, meta }) {
  const checks = [];
  const add = (name, pass, detail) => checks.push({ name, pass, detail });

  const dataHash = await sha256(rawCsv);
  add('数据 SHA-256 与包内记录一致', dataHash === meta.dataHash, `${dataHash.slice(0, 16)}…`);

  const recomputed = await sha256(stableStringify(canonicalArtifact(plan, run.steps, run.excludedRows)));
  add('产物哈希可重算（执行记录未被篡改）', recomputed === run.artifactHash, `${recomputed.slice(0, 16)}…`);

  add('meta 与 run 的产物哈希一致', meta.artifactHash === run.artifactHash, `${run.artifactHash.slice(0, 12)}…`);

  const whitelist = Object.keys(OPERATORS);
  const badOps = plan.steps.map((s) => s.op).filter((op) => !whitelist.includes(op));
  add('计划只使用白名单算子', badOps.length === 0, badOps.length ? `越界：${badOps.join(',')}` : `${whitelist.length} 个算子内`);

  const noConfirm = plan.steps.filter((s) => s.op === 'drop_outliers' && s.params?.confirm !== true);
  add('破坏性算子已人工确认', noConfirm.length === 0, noConfirm.length ? '缺少 confirm' : '通过');

  return { checks, passed: checks.every((c) => c.pass) };
}
