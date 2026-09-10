import { fs, path } from '@tauri-apps/api';
import { AriaStatus } from '../../utils/aria2';
import { DownloadTask } from '../../interfaces/DownloadTask';
import { CreateDownloadTaskParams } from './types';
import { useSettingsStore } from '../settings';
import { getDownloadUrl } from '../../twitter/utils';
import { resolveVariables } from '../../utils/file-name-template';
import { FileNameTemplateData } from '../../interfaces/FileNameTemplateData';

// ================= 日志系统 =================
const MAX_LOG_FILE_SIZE = 150 * 1024;
const TRIM_INTERVAL_MS = 30000;
let debugLogFilePath: string | null = null;
let trimScheduled = false;

async function ensureDebugLogPath(): Promise<string> {
  if (debugLogFilePath) return debugLogFilePath;
  // 与 appLogDir 保持一致，便于排查（用户打开日志文件夹即可看到）
  const logDir = await path.appLogDir();
  if (!(await fs.exists(logDir))) {
    await fs.createDir(logDir, { recursive: true });
  }
  debugLogFilePath = await path.join(logDir, 'debug-dl.log');
  return debugLogFilePath;
}

async function trimLogFile() {
  if (trimScheduled) return;
  trimScheduled = true;
  try {
    const filePath = await ensureDebugLogPath();
    if (!(await fs.exists(filePath))) return;
    let content = '';
    try {
      content = await fs.readTextFile(filePath);
    } catch (e) {
      return;
    }
    if (content.length <= MAX_LOG_FILE_SIZE) return;

    const lines = content.split('\n');
    const errorLines: string[] = [];
    const otherLines: string[] = [];

    for (const line of lines) {
      if (line.includes('[ERROR]') || line.includes('[WARN]')) {
        errorLines.push(line);
      } else {
        otherLines.push(line);
      }
    }

    const maxSize = Math.floor(MAX_LOG_FILE_SIZE * 0.8);
    let newContent = errorLines.join('\n');
    let remainingSize = maxSize - newContent.length;

    if (remainingSize > 0) {
      const selectedOther: string[] = [];
      for (let i = otherLines.length - 1; i >= 0 && remainingSize > 0; i--) {
        const line = otherLines[i];
        const lineSize = line.length + 1;
        if (lineSize <= remainingSize) {
          selectedOther.unshift(line);
          remainingSize -= lineSize;
        } else {
          break;
        }
      }
      if (selectedOther.length > 0) {
        newContent += '\n' + selectedOther.join('\n');
      }
    }

    await fs.writeTextFile(filePath, newContent);
  } finally {
    trimScheduled = false;
  }
}

// 直接异步写入，不再使用队列，避免队列 reject 后后续日志全部丢失
export function writeDebugLog(message: string) {
  const timestamp = new Date().toISOString();
  const line = `${timestamp} ${message}\n`;
  (async () => {
    try {
      const filePath = await ensureDebugLogPath();
      await fs.writeTextFile(filePath, line, { append: true });
    } catch (e) {
      // 写入失败输出到 console，避免静默丢失
      console.error('[DL] writeDebugLog error:', e);
    }
  })();
}

export function logFn(level: string, ...args: any[]) {
  const msg = args
    .map((a) => {
      if (a instanceof Error) return `${a.name}: ${a.message}`;
      if (typeof a === 'object') {
        try {
          return JSON.stringify(a);
        } catch {
          return String(a);
        }
      }
      return String(a);
    })
    .join(' ');

  // 1) 独立文件 debug-dl.log（专门给开发者排查下载流程用）
  writeDebugLog(`[DL] [${level.toUpperCase()}] ${msg}`);

  // 2) 应用日志 DL 分类（也会写入 <YYYY-MM-DD HHmmss>.log）
  try {
    if (window.log?.category) {
      const l = window.log.category('DL');
      if (level === 'error') l.error(msg);
      else if (level === 'warn') l.warn(msg);
      else l.info(msg);
    }
  } catch (err) {
    console.error('[DL] app log error:', err);
  }
}

// 定期 trim
if (typeof window !== 'undefined') {
  setInterval(() => {
    trimLogFile().catch(() => {});
  }, TRIM_INTERVAL_MS);
}

// ================= 辅助函数 =================
export async function mergeAriaStatusToDownloadTask(
  ariaStatus: any,
  oldTask: DownloadTask,
  now = Date.now(),
): Promise<DownloadTask> {
  return {
    ...oldTask,
    gid: ariaStatus.gid,
    status: ariaStatus.status,
    completeSize: Number(ariaStatus.completedLength),
    totalSize: Number(ariaStatus.totalLength),
    fileName: await path.basename(ariaStatus.files[0].path),
    error: ariaStatus.errorMessage,
    dir: ariaStatus.dir,
    updatedAt: now,
  };
}

export async function prepareDownloadTask({
  post,
  media,
}: CreateDownloadTaskParams): Promise<DownloadTask> {
  const settings = useSettingsStore.getState();
  const downloadUrl = getDownloadUrl(media);
  logFn('info', `准备下载: ${downloadUrl}`);
  const templateData: FileNameTemplateData = { media, post };
  const resolvedDirName = settings.download.dirTemplate
    ? resolveVariables(settings.download.dirTemplate, templateData)
    : '';
  const dir = await path.join(settings.download.saveDirBase, resolvedDirName);
  const fileName = resolveVariables(
    settings.download.fileNameTemplate,
    templateData,
  );
  logFn('info', `目录: ${dir}, 文件: ${fileName}`);
  return {
    gid: '',
    status: AriaStatus.Waiting,
    completeSize: 0,
    totalSize: Infinity,
    fileName,
    media,
    post,
    error: '',
    dir,
    updatedAt: Date.now(),
    downloadUrl,
    ariaRetryCountRemains: 5,
  };
}