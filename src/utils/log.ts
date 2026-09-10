/* eslint-disable no-console */

import dayjs, { Dayjs } from 'dayjs';
import { path, fs } from '@tauri-apps/api';

const DEFAULT_CATEGORY = 'APP';
const FLUSH_INTERVAL_MS = 500;

export class Logger implements ILogger {
  #now = dayjs();
  #logFileBuffers: string[] = [];
  #logFileTimeoutId: number | undefined;

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

  async #getLogFilePath() {
    const fileName = `${this.#now.format('YYYY-MM-DD HHmmss')}.log`;
    const logDir = await path.appLogDir();

    if (!(await fs.exists(logDir))) {
      await fs.createDir(logDir, { recursive: true });
    }

    return await path.join(logDir, fileName);
  }

  #log(level: string, category: string, ...messages: any[]) {
    try {
      const time = dayjs();
      this.#logConsole(level, time, category, ...messages);
      // 默认始终写入文件（Settings.writeLogs 默认为 true 且无 UI 开关）
      this.#logFile(level, time, category, ...messages);
    } catch (err) {
      console.error('Log error', err);
    }
  }

  #logFile(level: string, time: Dayjs, category: string, ...messages: any[]) {
    const fmtTime = time.toISOString();
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
    this.#logFileBuffers.push(msg);

    // 已有 flush 任务在等待，无需重复创建
    if (this.#logFileTimeoutId !== undefined) return;

    this.#logFileTimeoutId = window.setTimeout(async () => {
      this.#logFileTimeoutId = undefined;
      const buffers = this.#logFileBuffers.slice();
      this.#logFileBuffers.length = 0;
      if (buffers.length === 0) return;
      try {
        await fs.writeTextFile(
          await this.#getLogFilePath(),
          buffers.join('\n') + '\n',
          { append: true },
        );
      } catch (err) {
        console.error('Log file write error', err);
      }
    }, FLUSH_INTERVAL_MS);
  }

  #logConsole(
    level: string,
    time: Dayjs,
    category: string,
    ...messages: any[]
  ) {
    let categoryColor = '#000000';

    if (category !== DEFAULT_CATEGORY) {
      const colorList = [
        '#f5222d',
        '#fa541c',
        '#fa8c16',
        '#faad14',
        '#d4b106',
        '#a0d911',
        '#52c41a',
        '#13c2c2',
        '#1677ff',
        '#2f54eb',
        '#722ed1',
        '#eb2f96',
      ];
      const hashedCategoryName = category
        .split('')
        .reduce((prev, curr) => prev + curr.charCodeAt(0), 0);
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