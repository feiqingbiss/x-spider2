import { fs, path } from '@tauri-apps/api';

// Homepage 相关常量
export const TIMEOUT_MS = 60000;
export const BATCH_SIZE = 2;
export const BATCH_DELAY_MS = 2500;
export const MAX_RETRIES = 3;
export const RETRY_DELAY_MS = 8000;
export const ROUND_DELAY_MS = 30000;
export const RETRY_ROUNDS = 2;
export const WAIT_CREATION_TASKS_MAX_MS = 60000;
export const FAILED_USERS_FILE = 'failed_users.txt';
export const USER_LIST_FILE = 'search-user-name.txt';

export function userFriendlyError(err: any): string {
  const msg = (err?.message || err?.toString() || '').toLowerCase();
  if (
    msg.includes('status=429') ||
    msg.includes('rate limit') ||
    msg.includes('too many requests')
  ) {
    return '请求过于频繁，请稍后再试';
  }
  if (msg.includes('status=404') || msg.includes('找不到该用户')) {
    return '用户不存在或访问受限';
  }
  if (msg.includes('超时') || msg.includes('timeout')) {
    return '网络请求超时';
  }
  if (
    msg.includes('tls handshake') ||
    msg.includes('error decoding response body') ||
    msg.includes('error sending request') ||
    msg.includes('network') ||
    msg.includes('eof') ||
    msg.includes('10053')
  ) {
    return '网络连接异常，请检查代理配置';
  }
  return '加载失败，请稍后重试';
}

export function shuffleArray<T>(arr: T[]): T[] {
  const shuffled = [...arr];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`请求超时（超过${timeoutMs / 1000}秒）`));
    }, timeoutMs);
    promise
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

export function isRateLimitError(err: any): boolean {
  const msg = (err?.message || err?.toString() || '').toLowerCase();
  return (
    msg.includes('status=429') ||
    msg.includes('too many requests') ||
    msg.includes('rate limit')
  );
}

export function cleanUsername(input: string): string {
  let text = input.trim();
  if (!text) return '';
  try {
    if (text.includes('x.com') || text.includes('twitter.com')) {
      const urlString = text.startsWith('http') ? text : `https://${text}`;
      const url = new URL(urlString);
      const pathParts = url.pathname.split('/').filter((p) => p.length > 0);
      if (pathParts.length > 0) return pathParts[0];
    }
    if (text.startsWith('@')) return text.substring(1);
  } catch (e) {
    console.error('识别用户名失败:', e);
  }
  return text;
}

/**
 * 归一化用户名为小写形式。
 * Twitter 的 screenName 是大小写不敏感的，所有比较、持久化都使用此函数。
 */
export function normalizeUsername(input: string): string {
  const cleaned = cleanUsername(input);
  return cleaned.toLowerCase();
}

/**
 * 从原始文本（名单文件内容）解析出归一化、去重后的用户名列表。
 */
export function parseUsernames(rawText: string): string[] {
  if (!rawText) return [];
  const names = rawText
    .split('\n')
    .map((line) => normalizeUsername(line))
    .filter((n) => n.length > 0);
  return Array.from(new Set(names));
}

/**
 * 获取名单文件的完整路径。
 */
export async function getUserListFilePath(
  saveDirBase: string,
): Promise<string> {
  const baseDir = saveDirBase || (await path.appDataDir());
  return await path.join(baseDir, USER_LIST_FILE);
}

/**
 * 把用户加入下载名单（search-user-name.txt），并归一化去重。
 * 返回 true 表示新增了用户，false 表示用户已存在或无效。
 */
export async function addUserToDownloadList(
  screenName: string,
  saveDirBase: string,
): Promise<boolean> {
  const normalized = normalizeUsername(screenName);
  if (!normalized) return false;

  const filePath = await getUserListFilePath(saveDirBase);

  let content = '';
  try {
    content = await fs.readTextFile(filePath);
  } catch {
    // 文件不存在，content 保持空串
  }

  const existing = parseUsernames(content);
  if (existing.includes(normalized)) {
    return false;
  }

  const combined = [...existing, normalized];
  const newContent = combined.map((n) => `https://x.com/${n}`).join('\n');
  await fs.writeTextFile(filePath, newContent);
  return true;
}