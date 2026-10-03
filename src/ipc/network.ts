import { invoke } from '@tauri-apps/api';
import { Response } from '../interfaces/Response';
import { RequestOptions } from '../interfaces/RequestOptions';
import * as R from 'ramda';
import { useSettingsStore } from '../stores/settings';
import { delay } from '../utils';

const MAX_RETRY_COUNT = 4;
const MAX_RETRY_DELAY = 4000;
const RATE_LIMIT_LOG_INTERVAL = 30000;

let netLog: ICategoriedLogger | null = null;
let lastRateLimitLogTime = 0;

const NOOP_LOG: ICategoriedLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

function getLog(): ICategoriedLogger {
  if (netLog) return netLog;
  if (typeof window !== 'undefined' && window.log?.category) {
    netLog = window.log.category('NET');
  } else {
    netLog = NOOP_LOG;
  }
  return netLog;
}

function isRateLimitError(msg: string): boolean {
  const m = msg.toLowerCase();
  return (
    m.includes('status=429') ||
    m.includes('too many requests') ||
    m.includes('rate limit') ||
    m.includes('expected value at line 1 column 1')
  );
}

const SENSITIVE_HEADER_KEYS = new Set([
  'cookie',
  'set-cookie',
  'authorization',
  'x-csrf-token',
  'proxy-authorization',
]);

const SENSITIVE_QUERY_KEYWORDS = [
  'token',
  'secret',
  'auth',
  'password',
  'key',
];

function sanitizeHeaders(
  headers: Record<string, string>,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (SENSITIVE_HEADER_KEYS.has(k.toLowerCase())) {
      out[k] = '******';
    } else {
      out[k] = v;
    }
  }
  return out;
}

function sanitizeUrl(url: string): string {
  try {
    const u = new URL(url);
    let changed = false;
    for (const key of Array.from(u.searchParams.keys())) {
      const lower = key.toLowerCase();
      if (SENSITIVE_QUERY_KEYWORDS.some((kw) => lower.includes(kw))) {
        u.searchParams.set(key, '******');
        changed = true;
      }
    }
    return changed ? u.href : url;
  } catch {
    return url;
  }
}

export async function request(options: RequestOptions) {
  const log = getLog();
  const url = new URL(options.url);

  if (options.query) {
    Object.entries(options.query).forEach(([k, v]) => {
      url.searchParams.append(k, v);
    });
  }

  const settings = useSettingsStore.getState();
  let remainingRetryCount = MAX_RETRY_COUNT;
  let retryDelay = 100;
  let lastErr: any;

  while (remainingRetryCount > 0) {
    try {
      return await requestInternal(
        R.defaultTo('GET', options.method),
        url.href,
        R.defaultTo('', options.body),
        settings.proxy.enable,
        // ✅ 直接用用户填的代理地址，不再区分系统/手动
        settings.proxy.url,
        R.defaultTo({}, options.headers),
        options.responseType,
      );
    } catch (err: any) {
      lastErr = err;
      const errMsg = err?.message || String(err);

      if (isRateLimitError(errMsg)) {
        const now = Date.now();
        if (now - lastRateLimitLogTime > RATE_LIMIT_LOG_INTERVAL) {
          log.warn(`Rate limit detected: ${errMsg}`);
          lastRateLimitLogTime = now;
        }
        throw err;
      }

      log.warn(
        `Request failed, retry after ${retryDelay}ms, remaining retry count: ${remainingRetryCount}`,
        err,
      );
      await delay(retryDelay);
      remainingRetryCount--;
      retryDelay *= 2;
      if (retryDelay > MAX_RETRY_DELAY) {
        retryDelay = MAX_RETRY_DELAY;
      }
    }
  }

  log.error('Max retry count reached, last error:', lastErr);
  throw lastErr;
}

let reqIdGlobal = 0;

async function requestInternal(
  method: string,
  url: string,
  body: string,
  enableProxy: boolean,
  proxyUrl: string,
  headers: Record<string, string>,
  responseType: string,
): Promise<Response> {
  const log = getLog();
  const startTs = Date.now();
  const reqId = reqIdGlobal++;

  log.info(`REQ_${reqId}`, method, sanitizeUrl(url), {
    body,
    enableProxy,
    proxyUrl,
    headers: sanitizeHeaders(headers),
    responseType,
  });

  const res = await invoke<Response>('network_fetch', {
    method,
    url,
    body,
    enableProxy,
    proxyUrl,
    headers,
    responseType,
  });

  const endTs = Date.now() - startTs;
  log.info(`RES_${reqId}(+${endTs}ms)`, res.status, sanitizeUrl(url), res);

  return res;
}