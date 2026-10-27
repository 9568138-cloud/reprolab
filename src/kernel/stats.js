// 统计内核：只依赖 IEEE754 基本运算，保证同样输入 → 同样输出（可逐位复现）
export const round = (v, d = 6) => (Number.isFinite(v) ? Number(v.toFixed(d)) : null);

export function describe(values) {
  const v = values.filter((x) => Number.isFinite(x));
  const n = v.length;
  if (n === 0) return { n: 0 };
  const sorted = [...v].sort((a, b) => a - b);
  const sum = v.reduce((a, b) => a + b, 0);
  const mean = sum / n;
  const variance = v.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n - 1);
  const median = n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  return {
    n,
    mean: round(mean),
    std: round(Math.sqrt(variance)),
    min: round(sorted[0]),
    max: round(sorted[n - 1]),
    median: round(median),
    sum: round(sum),
    variance: round(variance),
  };
}

/** 皮尔逊相关系数 */
export function pearson(xs, ys) {
  const pairs = xs.map((x, i) => [x, ys[i]]).filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  const n = pairs.length;
  if (n < 3) throw new Error('有效样本不足 3 个，无法计算相关性');
  const mx = pairs.reduce((s, [x]) => s + x, 0) / n;
  const my = pairs.reduce((s, [, y]) => s + y, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (const [x, y] of pairs) {
    sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; syy += (y - my) ** 2;
  }
  const r = sxy / Math.sqrt(sxx * syy);
  return { r, n, mx, my };
}

/** 最小二乘线性拟合 y = a + b x */
export function linearFit(xs, ys) {
  const pairs = xs.map((x, i) => [x, ys[i]]).filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  const n = pairs.length;
  if (n < 3) throw new Error('有效样本不足 3 个，无法拟合');
  const mx = pairs.reduce((s, [x]) => s + x, 0) / n;
  const my = pairs.reduce((s, [, y]) => s + y, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (const [x, y] of pairs) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; syy += (y - my) ** 2; }
  const b = sxy / sxx;
  const a = my - b * mx;
  const ssRes = pairs.reduce((s, [x, y]) => s + (y - (a + b * x)) ** 2, 0);
  const r2 = 1 - ssRes / syy;
  return { slope: b, intercept: a, r2, n, mx, my };
}

/** 相关系数显著性：t = r*sqrt(n-2)/sqrt(1-r^2)，用 Student-t 尾概率的简洁近似 */
export function correlationPValue(r, n) {
  const df = n - 2;
  if (df <= 0) return 1;
  const t = Math.abs(r) * Math.sqrt(df) / Math.sqrt(Math.max(1e-12, 1 - r * r));
  // 用不完全 beta 的连分式近似（Numerical Recipes betacf）
  const x = df / (df + t * t);
  return Math.max(0, Math.min(1, betai(df / 2, 0.5, x)));
}

function betai(a, b, x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const lbeta = lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x);
  const front = Math.exp(lbeta) / a;
  return x < (a + 1) / (a + b + 2) ? front * betacf(a, b, x) : 1 - Math.exp(lbeta) / b * betacf(b, a, 1 - x);
}

function lgamma(z) {
  const g = [76.18009172947146, -86.50532032941677, 24.01409824083091,
    -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let x = z, y = z, tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j += 1) { y += 1; ser += g[j] / y; }
  return -tmp + Math.log(2.5066282746310005 * ser / x);
}

function betacf(a, b, x) {
  const itmax = 200, eps = 3e-12, fpmin = 1e-300;
  const qab = a + b, qap = a + 1, qam = a - 1;
  let c = 1, d = 1 - qab * x / qap;
  if (Math.abs(d) < fpmin) d = fpmin;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= itmax; m += 1) {
    const m2 = 2 * m;
    let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < fpmin) d = fpmin;
    c = 1 + aa / c; if (Math.abs(c) < fpmin) c = fpmin;
    d = 1 / d; h *= d * c;
    aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < fpmin) d = fpmin;
    c = 1 + aa / c; if (Math.abs(c) < fpmin) c = fpmin;
    d = 1 / d;
    const del = d * c; h *= del;
    if (Math.abs(del - 1) < eps) break;
  }
  return h;
}

/** IQR 异常点：返回索引与依据 */
export function detectOutliers(values, k = 1.5) {
  const idx = [];
  const nums = [];
  values.forEach((v, i) => { if (Number.isFinite(v)) { idx.push(i); nums.push(v); } });
  if (nums.length < 4) return { outliers: [], bounds: null };
  const sorted = [...nums].sort((a, b) => a - b);
  const q1 = quantile(sorted, 0.25), q3 = quantile(sorted, 0.75);
  const iqr = q3 - q1;
  const low = q1 - k * iqr, high = q3 + k * iqr;
  const outliers = [];
  idx.forEach((originalIdx, k2) => {
    const v = nums[k2];
    if (v < low || v > high) outliers.push({ row: originalIdx + 2, value: v, side: v < low ? 'low' : 'high' });
  });
  return { outliers, bounds: { q1, q3, iqr, low, high, k } };
}

function quantile(sorted, q) {
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  return sorted[base + 1] !== undefined ? sorted[base] + rest * (sorted[base + 1] - sorted[base]) : sorted[base];
}

/** 均值与样本标准差（只用有限值） */
export function meanStd(values) {
  const v = values.filter((x) => Number.isFinite(x));
  const n = v.length;
  if (n === 0) return { n: 0, mean: null, std: null };
  const mean = v.reduce((a, b) => a + b, 0) / n;
  const variance = n > 1 ? v.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1) : 0;
  return { n, mean, std: Math.sqrt(variance) };
}

/** Welch 两样本 t 检验（不假设方差齐性），返回 t / df / 双尾 p / 均值差 */
export function welchTTest(a, b) {
  const va = a.filter((x) => Number.isFinite(x));
  const vb = b.filter((x) => Number.isFinite(x));
  if (va.length < 2 || vb.length < 2) throw new Error('每组至少需要 2 个有效样本才能做 t 检验');
  const sa = meanStd(va), sb = meanStd(vb);
  const varA = sa.std ** 2 / va.length;
  const varB = sb.std ** 2 / vb.length;
  const denom = Math.sqrt(varA + varB);
  const t = denom === 0 ? 0 : (sa.mean - sb.mean) / denom;
  const df = (varA + varB) ** 2 / ((varA ** 2) / (va.length - 1) + (varB ** 2) / (vb.length - 1));
  const p = df > 0 && Number.isFinite(t) ? Math.max(0, Math.min(1, betai(df / 2, 0.5, df / (df + t * t)))) : 1;
  return {
    t, df, p,
    meanA: sa.mean, meanB: sb.mean, diff: sa.mean - sb.mean,
    stdA: sa.std, stdB: sb.std, nA: va.length, nB: vb.length,
  };
}

/** 等宽直方图 */
export function histogram(values, binCount = 8) {
  const v = values.filter((x) => Number.isFinite(x));
  if (v.length === 0) return { bins: [], min: null, max: null };
  const min = Math.min(...v), max = Math.max(...v);
  const width = (max - min) / binCount || 1;
  const bins = Array.from({ length: binCount }, (_, i) => ({
    from: round(min + width * i, 6),
    to: round(min + width * (i + 1), 6),
    count: 0,
  }));
  for (const x of v) {
    const i = Math.min(binCount - 1, Math.max(0, Math.floor((x - min) / width)));
    bins[i].count += 1;
  }
  return { bins, min, max, n: v.length, width };
}
