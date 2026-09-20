/**
 * 把内部 semver 版本号转成 UI 显示用的 4 段式版本号。
 * - "2.5.2-0"  → "2.5.2.0"
 * - "2.5.2-13" → "2.5.2.13"
 * - "2.5.2"    → "2.5.2"（无 prerelease 时保持原样）
 * - "v2.5.2-1" → "2.5.2.1"（去掉 v 前缀）
 */
export function formatVersion(v: string): string {
  if (!v) return '';
  const cleaned = String(v).replace(/^v/i, '').trim();
  return cleaned.replace(/-(\d+)$/, '.$1');
}

/**
 * 语义化版本比较：返回 a > b 时为 true。
 * 支持 prerelease 格式（如 2.5.1-4、2.5.1-10、2.5.1-alpha.1）。
 */
export function isVersionGt(a: string, b: string): boolean {
  const cleanA = String(a).replace(/^v/i, '').trim();
  const cleanB = String(b).replace(/^v/i, '').trim();

  const [mainA, preA] = splitVersion(cleanA);
  const [mainB, preB] = splitVersion(cleanB);

  const mainCmp = compareMain(mainA, mainB);
  if (mainCmp !== 0) return mainCmp > 0;

  // 主版本相同：比较 prerelease
  // 无 prerelease 的更大（2.5.2 > 2.5.2-4）
  if (!preA && preB) return true;
  if (preA && !preB) return false;
  if (!preA && !preB) return false;

  return comparePre(preA, preB) > 0;
}

function splitVersion(v: string): [string, string] {
  const idx = v.indexOf('-');
  if (idx === -1) return [v, ''];
  return [v.slice(0, idx), v.slice(idx + 1)];
}

function compareMain(a: string, b: string): number {
  const aa = a.split('.').map((x) => {
    const n = Number(x);
    return Number.isNaN(n) ? 0 : n;
  });
  const bb = b.split('.').map((x) => {
    const n = Number(x);
    return Number.isNaN(n) ? 0 : n;
  });
  const len = Math.max(aa.length, bb.length);
  for (let i = 0; i < len; i++) {
    const x = aa[i] ?? 0;
    const y = bb[i] ?? 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

function comparePre(a: string, b: string): number {
  const aa = a.split('.');
  const bb = b.split('.');
  const len = Math.max(aa.length, bb.length);
  for (let i = 0; i < len; i++) {
    const x = aa[i];
    const y = bb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;

    const xn = Number(x);
    const yn = Number(y);
    const xIsNum = !Number.isNaN(xn);
    const yIsNum = !Number.isNaN(yn);

    if (xIsNum && yIsNum) {
      if (xn > yn) return 1;
      if (xn < yn) return -1;
    } else if (xIsNum && !yIsNum) {
      return -1;
    } else if (!xIsNum && yIsNum) {
      return 1;
    } else {
      if (x > y) return 1;
      if (x < y) return -1;
    }
  }
  return 0;
}