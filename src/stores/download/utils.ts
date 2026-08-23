import { fs, notification, path } from '@tauri-apps/api';
import * as R from 'ramda';
import { AriaStatus, aria2 } from '../../utils/aria2';
import { DownloadTask } from '../../interfaces/DownloadTask';
import { CreateDownloadTaskParams } from './types';
import { useSettingsStore } from '../settings';
import { getDownloadUrl } from '../../twitter/utils';
import { resolveVariables } from '../../utils/file-name-template';
import { FileNameTemplateData } from '../../interfaces/FileNameTemplateData';
import { delay } from '../../utils';

// ================= 日志系统 =================
const MAX_LOG_FILE_SIZE = 150 * 1024;
let debugLogFilePath: string | null = null;

async function ensureDebugLogPath(): Promise<string> {
  if (debugLogFilePath) return debugLogFilePath;
  const dataDir = await path.appDataDir();
  const dir = await path.join(dataDir, 'logs');
  if (!(await fs.exists(dir))) {
    await fs.createDir(dir, { recursive: true });
  }
  debugLogFilePath = await path.join(dir, 'debug-dl.log');
  return debugLogFilePath;
}

async function trimLogFile() {
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
}

export async function writeDebugLog(message: string) {
  try {
    const filePath = await ensureDebugLogPath();
    const timestamp = new Date().toISOString();
    const line = `${timestamp} ${message}\n`;
    await fs.writeTextFile(filePath, line, { append: true });
    setTimeout(() => trimLogFile(), 0);
  } catch (e) {}
}

export function logFn(level: string, ...args: any[]) {
  const msg = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
  writeDebugLog(`[DL] [${level.toUpperCase()}] ${msg}`);
  try {
    if (window.log?.category) {
      const l = window.log.category('DL');
      if (level === 'error') l.error(...args);
      else if (level === 'warn') l.warn(...args);
      else l.info(...args);
    }
  } catch (_) {}
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
  const fileName = resolveVariables(settings.download.fileNameTemplate, templateData);
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