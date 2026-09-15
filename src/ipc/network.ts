import { invoke } from '@tauri-apps/api';
import { Response } from '../interfaces/Response';
import { RequestOptions } from '../interfaces/RequestOptions';
import * as R from 'ramda';
import { useSettingsStore } from '../stores/settings';
import { delay } from '../utils';

const MAX_RETRY_COUNT = 4;
const MAX_RETRY_DELAY = 4000;
const RATE_LIMIT_LOG_INTERVAL = 30000;

// ✅ 优化：用 getLog() 懒初始化，并加 noop 兜底，避免 window.log 未就绪时崩溃
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
        settings.proxy.useSystem ? '' : settings.proxy.url,
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
  log.info(`REQ_${reqId}`, method, url, {
    body,
    enableProxy,
    proxyUrl,
    headers: {
      ...headers,
      Cookie: headers.Cookie ? '******' : undefined,
    },
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
  log.info(`RES_${reqId}(+${endTs}ms)`, res.status, url, res);

  return res;
}

export async function getSystemProxy(): Promise<string> {
  const map: Record<string, string> = await invoke(
    'network_get_system_proxy_url',
  );
  const value = map.https || map.http;
  if (value) {
    return `http://${value}`;
  }
  return '';
}