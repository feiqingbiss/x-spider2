import { fs, path } from '@tauri-apps/api';
import dayjs from 'dayjs';
import { AriaStatus } from '../../utils/aria2';
import { DownloadTask } from '../../interfaces/DownloadTask';
import { CreateDownloadTaskParams } from './types';
import { useSettingsStore } from '../settings';
import { getDownloadUrl } from '../../twitter/utils';
import { resolveVariables } from '../../utils/file-name-template';
import { FileNameTemplateData } from '../../interfaces/FileNameTemplateData';
import MediaType from '../../enums/MediaType';

// ================= 日志系统 =================
const MAX_LOG_FILE_SIZE = 150 * 1024;
const TRIM_INTERVAL_MS = 30000;
const HARD_LIMIT_BYTES = 1024 * 1024;
let debugLogFilePath: string | null = null;
let trimScheduled = false;

async function ensureDebugLogPath(): Promise<string> {
  if (debugLogFilePath) return debugLogFilePath;
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

    if (content.length > HARD_LIMIT_BYTES) {
      content = content.slice(-HARD_LIMIT_BYTES);
      const firstNewline = content.indexOf('\n');
      if (firstNewline >= 0) {
        content = content.slice(firstNewline + 1);
      }
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

export function writeDebugLog(message: string) {
  const timestamp = dayjs().format('YYYY-MM-DD HH:mm:ss.SSS');
  const line = `${timestamp} ${message}\n`;
  (async () => {
    try {
      const filePath = await ensureDebugLogPath();
      await fs.writeTextFile(filePath, line, { append: true });
    } catch (e) {
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

  writeDebugLog(`[DL] [${level.toUpperCase()}] ${msg}`);

  if (level === 'warn' || level === 'error') {
    try {
      if (window.log?.category) {
        const l = window.log.category('DL');
        if (level === 'error') l.error(msg);
        else l.warn(msg);
      }
    } catch (err) {
      console.error('[DL] app log error:', err);
    }
  }
}

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
  // ✅ 修复：不再从 aria2 覆盖 `dir` 和 `fileName`。
  //    原因：aria2 返回的路径可能与前端生成的字符串有细微差异
  //    （斜杠方向、URL 编码等），导致 `DownloadListItem` 的 useEffect
  //    依赖被误判为变化，图片被反复重置、UI 频闪。
  //    我们自己的 `dir` / `fileName` 才是权威值，保持不变。
  return {
    ...oldTask,
    gid: ariaStatus.gid,
    status: ariaStatus.status,
    completeSize: Number(ariaStatus.completedLength),
    totalSize: Number(ariaStatus.totalLength),
    error: ariaStatus.errorMessage,
    updatedAt: now,
  };
}

// ✅ 新增：封面图任务参数（视频 / GIF 才有）
export interface ThumbTaskInfo {
  url: string;
  dir: string;
  fileName: string;
}

export interface PreparedTasks {
  task: DownloadTask;
  thumbTask?: ThumbTaskInfo;
}

export async function prepareDownloadTask({
  post,
  media,
}: CreateDownloadTaskParams): Promise<PreparedTasks> {
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

  const task: DownloadTask = {
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

  let thumbTask: ThumbTaskInfo | undefined;
  const isVideoLike =
    media.type === MediaType.Video || media.type === MediaType.Gif;
  if (isVideoLike && media.url) {
    thumbTask = {
      url: `${media.url}?format=jpg&name=thumb`,
      dir,
      fileName: `${fileName}.thumb.jpg`,
    };
  }

  return { task, thumbTask };
}