/* eslint-disable no-console */

import dayjs, { Dayjs } from 'dayjs';
import { path, fs } from '@tauri-apps/api';

const DEFAULT_CATEGORY = 'APP';
const FLUSH_INTERVAL_MS = 500;

// ✅ 日志文件名（模块加载时固定，确保所有日志写入同一个文件）
const LOG_FILE_NAME = `${dayjs().format('YYYY-MM-DD HHmmss')}.log`;

// ✅ 日志写入队列，解决并发写文件冲突
const pendingLines: string[] = [];
let isWriting = false;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

async function flushLogFile() {
  if (isWriting || pendingLines.length === 0) return;
  isWriting = true;

  const linesToWrite = pendingLines.splice(0);
  try {
    const logDir = await path.appLogDir();
    if (!(await fs.exists(logDir))) {
      await fs.createDir(logDir, { recursive: true });
    }
    const logFilePath = await path.join(logDir, LOG_FILE_NAME);

    await fs.writeTextFile(logFilePath, linesToWrite.join('\n') + '\n', {
      append: true,
    });
  } catch (err) {
    console.error('Log file write error', err);
  } finally {
    isWriting = false;
    // 如果写入期间又有新的日志，继续调度
    if (pendingLines.length > 0 && flushTimer === null) {
      flushTimer = setTimeout(() => {
        flushTimer = null;
        flushLogFile();
      }, FLUSH_INTERVAL_MS);
    }
  }
}

function scheduleFlush() {
  if (flushTimer !== null || isWriting) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushLogFile();
  }, FLUSH_INTERVAL_MS);
}

export class Logger implements ILogger {
  info(...messages: any[]) {
    this.#log('INFO', DEFAULT_CATEGORY, ...messages);
  }
  warn(...messages: any[]) {
    this.#log('WARN', DEFAULT_CATEGORY, ...messages);
  }
  error(...messages: any[]) {
    this.#log('ERROR', DEFAULT_CATEGORY, ...messages);
  }
  debug(...messages: any[]) {
    if (import.meta.env.DEV) {
      this.#log('DEBUG', DEFAULT_CATEGORY, ...messages);
    }
  }
  category(name: string): ICategoriedLogger {
    return {
      info: (...messages: any[]) => {
        this.#log('INFO', name, ...messages);
      },
      warn: (...messages: any[]) => {
        this.#log('WARN', name, ...messages);
      },
      error: (...messages: any[]) => {
        this.#log('ERROR', name, ...messages);
      },
      debug: (...messages: any[]) => {
        if (import.meta.env.DEV) {
          this.#log('DEBUG', name, ...messages);
        }
      },
    };
  }

  #log(level: string, category: string, ...messages: any[]) {
    try {
      const time = dayjs();
      this.#logConsole(level, time, category, ...messages);

      // 全局只写 WARN/ERROR，INFO/DEBUG 一律不写入文件
      if (level === 'WARN' || level === 'ERROR') {
        this.#logFile(level, time, category, ...messages);
      }
    } catch (err) {
      console.error('Log error', err);
    }
  }

  #logFile(level: string, time: Dayjs, category: string, ...messages: any[]) {
    const fmtTime = time.format('YYYY-MM-DD HH:mm:ss.SSS');
    const msg = `${fmtTime} [${level}] <${category}> ${messages
      .map((m) => {
        if (m instanceof Error) {
          return JSON.stringify({
            type: 'Error',
            message: m.message,
            name: m.name,
          });
        }
        try {
          return JSON.stringify(m);
        } catch {
          return JSON.stringify(String(m));
        }
      })
      .join(' ')}`;

    // ✅ 推入队列，由 flushLogFile 串行写入，避免并发冲突
    pendingLines.push(msg);
    scheduleFlush();
  }

  #logConsole(level: string, time: Dayjs, category: string, ...messages: any[]) {
    let categoryColor = '#000000';
    if (category !== DEFAULT_CATEGORY) {
      const colorList = ['#f5222d', '#fa541c', '#fa8c16', '#faad14', '#d4b106', '#a0d911', '#52c41a', '#13c2c2', '#1677ff', '#2f54eb', '#722ed1', '#eb2f96'];
      const hashedCategoryName = category.split('').reduce((prev, curr) => prev + curr.charCodeAt(0), 0);
      categoryColor = colorList[hashedCategoryName % colorList.length];
    }

    const fmtTime = time.format('HH:mm:ss.SSS');
    const prefix = (level: string, color: string) => [
      `%c${fmtTime} %c[${level}]%c %c<${category}>%c`,
      'color: #aaa; font-weight: bold;',
      `color: white; font-weight: bold; background: ${color}`,
      'color: initial; background: initial; font-weight: initial;',
      `color: ${categoryColor}; font-weight: bold;`,
      'color: initial; background: initial; font-weight: initial;',
    ];

    switch (level) {
      case 'INFO':
        console.info(...prefix('INFO', '#52c41a'), ...messages);
        break;
      case 'WARN':
        console.warn(...prefix('WARN', '#d4b106'), ...messages);
        break;
      case 'ERROR':
        console.error(...prefix('ERROR', '#f5222d'), ...messages);
        break;
      case 'DEBUG':
        console.debug(...prefix('DEBUG', 'black'), ...messages);
        break;
    }
  }
}