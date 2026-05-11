import { fs, notification, path } from '@tauri-apps/api';
import * as R from 'ramda';
import { create } from 'zustand';
import { CreationTask } from '../interfaces/CreationTask';
import { DownloadFilter } from '../interfaces/DownloadFilter';
import { DownloadTask } from '../interfaces/DownloadTask';
import { TwitterMedia } from '../interfaces/TwitterMedia';
import { TwitterPost } from '../interfaces/TwitterPost';
import { TwitterUser } from '../interfaces/TwitterUser';
import { AriaStatus, aria2 } from '../utils/aria2';
import { getUserMedias, getUserTweets } from '../twitter/api';
import { useSettingsStore } from './settings';
import { getDownloadUrl } from '../twitter/utils';
import { resolveVariables } from '../utils/file-name-template';
import { FileNameTemplateData } from '../interfaces/FileNameTemplateData';
import dayjs from 'dayjs';
import { notification as antNotification } from 'antd';
import { delay } from '../utils';

// ================= 日志系统（150KB，智能保留错误/警告） =================
const MAX_LOG_FILE_SIZE = 150 * 1024; // 150KB
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

  // 保留所有错误/警告，并从 INFO 日志尾部截取，总大小不超过限制的80%
  const maxSize = Math.floor(MAX_LOG_FILE_SIZE * 0.8);
  let newContent = errorLines.join('\n');
  let remainingSize = maxSize - newContent.length;

  if (remainingSize > 0) {
    const selectedOther: string[] = [];
    for (let i = otherLines.length - 1; i >= 0 && remainingSize > 0; i--) {
      const line = otherLines[i];
      const lineSize = line.length + 1; // +1 for newline
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

async function writeDebugLog(message: string) {
  try {
    const filePath = await ensureDebugLogPath();
    const timestamp = new Date().toISOString();
    const line = `${timestamp} ${message}\n`;
    await fs.writeTextFile(filePath, line, { append: true });
    // 异步清理，避免阻塞
    setTimeout(() => trimLogFile(), 0);
  } catch (e) {
    // 静默失败
  }
}

function logFn(level: string, ...args: any[]) {
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

// ================= 类型与辅助函数 =================
export interface CreateDownloadTaskParams { post: TwitterPost; media: TwitterMedia; }
export interface BatchProgress { total: number; completed: number; currentUser: string; }

async function mergeAriaStatusToDownloadTask(
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

async function prepareDownloadTask({
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

const creationTaskAbortControllerMap = new Map<string, AbortController>();

export interface DownloadStore {
  currentTab: string;
  setCurrentTab: (tab: string) => void;
  downloadTasks: DownloadTask[];
  autoSyncTaskIds: string[];
  setAutoSyncTaskIds: (ids: string[]) => void;
  createDownloadTask: (params: CreateDownloadTaskParams) => Promise<void>;
  batchCreateDownloadTask: (paramsList: CreateDownloadTaskParams[]) => Promise<void>;
  pauseDownloadTask: (gid: string) => Promise<void>;
  pauseAllDownloadTask: () => Promise<void>;
  unpauseDownloadTask: (gid: string) => Promise<void>;
  unpauseAllDownloadTask: () => Promise<void>;
  removeDownloadTask: (gid: string) => Promise<void>;
  batchRemoveDownloadTasks: (gids: string[]) => Promise<void>;
  syncDownloadTaskStatus: (gid: string) => Promise<void>;
  updateDownloadTask: (task: DownloadTask, now?: number) => void;
  batchUpdateDownloadTasks: (tasks: DownloadTask[]) => void;
  redownloadTask: (gid: string) => Promise<void>;
  batchRedownloadTask: (gid: string[]) => Promise<void>;
  creationTasks: CreationTask[];
  createCreationTask: (user: TwitterUser, filter: DownloadFilter) => void;
  removeCreationTask: (id: string) => void;
  updateCreationTask: (task: CreationTask) => void;
  batchProgress: BatchProgress | null;
  setBatchProgress: (progress: BatchProgress | null) => void;
}

export const useDownloadStore = create<DownloadStore>((set, get) => ({
  currentTab: '',
  setCurrentTab: (tab) => set({ currentTab: tab }),

  autoSyncTaskIds: [],
  setAutoSyncTaskIds: (ids) => set({ autoSyncTaskIds: ids }),

  downloadTasks: [],
  createDownloadTask: async (params) => {
    const task = await prepareDownloadTask(params);
    const gid = await aria2.invoke('aria2.addUri', [task.downloadUrl], {
      dir: task.dir,
      out: task.fileName,
    });
    task.gid = gid;
    const status = await aria2.tellStatus(task.gid);
    task.status = status.status;
    set({ downloadTasks: get().downloadTasks.concat(task) });
  },
  updateDownloadTask: (task, now = Date.now()) => {
    const oldTasks = get().downloadTasks;
    const idx = oldTasks.findIndex((t) => t.gid === task.gid);
    if (idx === -1 || oldTasks[idx].updatedAt > now) return;
    set({ downloadTasks: R.adjust(idx, R.always(task))(oldTasks) });
  },
  batchUpdateDownloadTasks: (tasks) => {
    const { downloadTasks: old } = get();
    const map = R.fromPairs(tasks.map((t) => [t.gid, t] as [string, DownloadTask]));
    set({
      downloadTasks: old.map((o) =>
        map[o.gid]?.updatedAt >= o.updatedAt ? map[o.gid] : o,
      ),
    });
  },
  batchCreateDownloadTask: async (paramsList) => {
    const tasks: DownloadTask[] = [];
    for (const p of paramsList) {
      try {
        tasks.push(await prepareDownloadTask(p));
      } catch (e: any) {
        logFn('error', `准备失败: ${e.message}`);
      }
    }
    if (!tasks.length) return;
    const gids = (
      await aria2.batchInvoke(
        tasks.map((t) => ({
          methodName: 'aria2.addUri',
          params: [[t.downloadUrl], { dir: t.dir, out: t.fileName }],
        })),
      )
    ).flat();
    const statusMap = await aria2.tellStatus(gids);
    tasks.forEach((t, i) => {
      t.gid = gids[i];
      t.status = statusMap[t.gid].status;
    });
    set({ downloadTasks: get().downloadTasks.concat(tasks) });
  },
  pauseDownloadTask: async (gid) => {
    await aria2.invoke('aria2.pause', gid);
  },
  pauseAllDownloadTask: async () => {
    await aria2.invoke('aria2.pauseAll');
  },
  unpauseDownloadTask: async (gid) => {
    await aria2.invoke('aria2.unpause', gid);
  },
  unpauseAllDownloadTask: async () => {
    await aria2.invoke('aria2.unpauseAll');
  },
  removeDownloadTask: async (gid) => {
    aria2.invoke('aria2.remove', gid).catch((e) => logFn('warn', 'remove fail', e));
    const s = get();
    set({
      downloadTasks: s.downloadTasks.filter((v) => v.gid !== gid),
      autoSyncTaskIds: s.autoSyncTaskIds.filter((v) => v !== gid),
    });
  },
  batchRemoveDownloadTasks: async (gids) => {
    aria2
      .batchInvoke(
        gids.map((g) => ({ methodName: 'aria2.remove', params: [g] })),
      )
      .catch((e) => logFn('error', gids, e));
    set({
      downloadTasks: get().downloadTasks.filter((v) => !gids.includes(v.gid)),
    });
  },
  redownloadTask: async (gid) => {
    const s = get();
    const old = s.downloadTasks.find((t) => t.gid === gid);
    if (!old) throw new Error('not found');
    await s.removeDownloadTask(gid);
    await s.createDownloadTask({ post: old.post, media: old.media });
  },
  batchRedownloadTask: async (gids) => {
    const s = get();
    const olds = s.downloadTasks.filter((t) => gids.includes(t.gid));
    if (!olds.length) throw new Error('no tasks');
    await s.batchRemoveDownloadTasks(gids);
    await s.batchCreateDownloadTask(olds.map((t) => ({ media: t.media, post: t.post })));
  },
  syncDownloadTaskStatus: async (gid) => {
    const { downloadTasks, updateDownloadTask, removeDownloadTask } = get();
    const task = downloadTasks.find((v) => v.gid === gid);
    if (!task) return;
    const now = Date.now();
    const status = await aria2.tellStatus(gid);
    if (status.status === 'error') {
      if (task.ariaRetryCountRemains > 0) {
        logFn('warn', `重试下载 ${task.ariaRetryCountRemains}`);
        removeDownloadTask(gid);
        const newTask = await prepareDownloadTask({
          post: task.post,
          media: task.media,
        });
        newTask.ariaRetryCountRemains = task.ariaRetryCountRemains - 1;
        const newGid = await aria2.invoke('aria2.addUri', [task.downloadUrl], {
          dir: newTask.dir,
          out: newTask.fileName,
        });
        newTask.gid = newGid;
        newTask.status = (await aria2.tellStatus(newGid)).status;
        set({ downloadTasks: get().downloadTasks.concat(newTask) });
      } else {
        const merged = await mergeAriaStatusToDownloadTask(status, task);
        logFn('error', '下载失败', merged);
        antNotification.error({ message: '下载失败', description: merged.fileName });
        notification.sendNotification({ title: '下载失败', body: merged.fileName });
      }
    } else {
      updateDownloadTask(await mergeAriaStatusToDownloadTask(status, task), now);
    }
  },
  creationTasks: [],
  createCreationTask: (user, filter) => {
    const id =
      crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
    const ctrl = new AbortController();
    creationTaskAbortControllerMap.set(id, ctrl);
    set({
      creationTasks: [
        ...get().creationTasks,
        { id, user, filter, status: 'waiting', completeCount: 0, skipCount: 0 },
      ],
    });
    logFn('info', `任务已入队: ${user.screenName}`);
  },
  removeCreationTask: (id) => {
    const ctrl = creationTaskAbortControllerMap.get(id);
    if (ctrl) {
      ctrl.abort();
      creationTaskAbortControllerMap.delete(id);
    }
    set({ creationTasks: get().creationTasks.filter((v) => v.id !== id) });
  },
  updateCreationTask: (task) => {
    set({
      creationTasks: get().creationTasks.map((o) =>
        o.id === task.id ? task : o,
      ),
    });
  },
  batchProgress: null,
  setBatchProgress: (p) => set({ batchProgress: p }),
}));

// ================= 核心下载流程 =================
const MAX_ACTIVE_TASKS = 1;
const MIN_API_INTERVAL_MS = 1000;   // 基础等待 1 秒
const MAX_ADDITIONAL_DELAY_MS = 2000; // 额外最多 2 秒，总间隔 1~3 秒
const RATE_LIMIT_WAIT_MS = 15000;    // 遇到限流时等待 15 秒

async function runCreationTask(task: CreationTask, abortSignal: AbortSignal) {
  let currentSource: 'medias' | 'tweets' = task.filter.source;
  let triedSwitching = false;

  const executeWithSource: (source: 'medias' | 'tweets') => Promise<void> = async (source) => {
    const { filter, user } = task;
    const store = useDownloadStore.getState();
    const settings = useSettingsStore.getState();
    const getListFn = source === 'medias' ? getUserMedias : getUserTweets;

    logFn('info', `开始处理用户: ${user.screenName} (源: ${source})`);

    let completeCount = 0,
      skipCount = 0;
    let now = dayjs();
    const since = filter.dateRange?.[0] || dayjs.unix(0);
    const until = filter.dateRange?.[1] || now.clone();
    let nextCursor: string | undefined | null = undefined;
    let consecutiveSkippedPosts = 0,
      retriedInitialEmpty = false;

    while (nextCursor !== null && now.isAfter(since)) {
      if (abortSignal.aborted) break;

      const delayMs =
        MIN_API_INTERVAL_MS +
        Math.floor(Math.random() * MAX_ADDITIONAL_DELAY_MS);
      logFn('info', `等待 ${delayMs}ms 后发起下一次请求...`);
      await delay(delayMs);

      logFn('info', `--- API 请求: userId=${user.id}, cursor=${nextCursor} ---`);
      let resp;
      try {
        resp = await getListFn(user.id, nextCursor);
      } catch (apiErr: any) {
        const errMsg =
          typeof apiErr?.message === 'string' ? apiErr.message : String(apiErr);
        logFn('error', `API请求失败: ${errMsg}`);
        // 限流或解码错误 -> 尝试切换源
        if (
          errMsg.includes('expected value at line 1 column 1') ||
          errMsg.includes('status=429')
        ) {
          logFn('warn', `检测到 API 限流，等待 ${RATE_LIMIT_WAIT_MS / 1000} 秒后重试...`);
          antNotification.warning({
            message: '检测到 API 限流',
            description: `任务 ${user.screenName} 将在 ${
              RATE_LIMIT_WAIT_MS / 1000
            } 秒后重试`,
          });
          await delay(RATE_LIMIT_WAIT_MS);
          if (!triedSwitching) {
            triedSwitching = true;
            const fallbackSource = source === 'tweets' ? 'medias' : 'tweets';
            logFn('warn', `切换到源: ${fallbackSource} 进行重试`);
            return executeWithSource(fallbackSource);
          }
        }
        throw apiErr;
      }
      if (abortSignal.aborted) break;
      const { twitterPosts, cursor } = resp;
      logFn(
        'info',
        `获得 ${twitterPosts.length} 条帖子, cursor=${cursor}`,
      );

      if (!nextCursor && twitterPosts.length === 0 && !retriedInitialEmpty) {
        logFn('warn', '首次获取为空，重试');
        await delay(2000);
        retriedInitialEmpty = true;
        const retry = await getListFn(user.id, undefined);
        if (retry.twitterPosts.length === 0) {
          // 重试仍为空 -> 切换源
          if (!triedSwitching) {
            triedSwitching = true;
            const fallbackSource = source === 'tweets' ? 'medias' : 'tweets';
            logFn('warn', `初始源 ${source} 无结果，切换到 ${fallbackSource} 重试`);
            return executeWithSource(fallbackSource);
          }
          const errMsg = `用户 ${user.screenName} 无帖子`;
          logFn('error', errMsg);
          throw new Error(errMsg);
        }
        nextCursor = retry.cursor;
        now = R.last(retry.twitterPosts)?.createdAt || now;
        continue;
      }

      nextCursor = cursor;
      now = R.last(twitterPosts)?.createdAt || now;
      const filteredPosts = twitterPosts.filter(
        (p) =>
          p.medias?.length &&
          (!since || !p.createdAt || p.createdAt.isAfter(since)) &&
          (!until || !p.createdAt || p.createdAt.isBefore(until)),
      );
      skipCount += twitterPosts.length - filteredPosts.length;

      if (filteredPosts.length === 0) {
        store.updateCreationTask({ ...task, completeCount, skipCount });
        continue;
      }

      const paramsList: CreateDownloadTaskParams[] = [];
      for (const post of filteredPosts) {
        let postAdded = false;
        for (const media of post.medias!) {
          if (filter.mediaTypes && !filter.mediaTypes.includes(media.type)) continue;
          try {
            const dlTask = await prepareDownloadTask({ post, media });
            const filePath = await path.join(dlTask.dir, dlTask.fileName);
            if (settings.download.sameFileSkip && (await fs.exists(filePath))) {
              skipCount++;
              continue;
            }
            paramsList.push({ media, post });
            postAdded = true;
          } catch (e: any) {
            logFn('error', `准备失败: ${e.message}`);
            skipCount++;
          }
        }
        if (!postAdded) {
          consecutiveSkippedPosts++;
          if (consecutiveSkippedPosts >= 10) {
            logFn('info', '连续跳过帖子达到阈值，提前结束');
            store.updateCreationTask({ ...task, completeCount, skipCount });
            return;
          }
        } else {
          consecutiveSkippedPosts = 0;
        }
      }

      if (paramsList.length) {
        await store.batchCreateDownloadTask(paramsList);
        completeCount += paramsList.length;
      }
      store.updateCreationTask({ ...task, completeCount, skipCount });
    }

    logFn(
      'info',
      `用户 ${user.screenName} 完成: 下载 ${completeCount}, 跳过 ${skipCount}`,
    );
    antNotification.success({
      message: `${user.screenName} 完成`,
      description: `下载 ${completeCount}, 跳过 ${skipCount}`,
    });
  };

  try {
    await executeWithSource(currentSource);
  } catch (err: any) {
    const errMsg =
      typeof err?.message === 'string' ? err.message : String(err);
    logFn('error', `用户 ${task.user.screenName} 异常: ${errMsg}`);
    throw err;
  }
}

// ================= 调度器 =================
async function scheduleCreationTasks() {
  const state = useDownloadStore.getState();
  const { creationTasks } = state;
  const active = creationTasks.filter((t) => t.status === 'active').length;
  if (active >= MAX_ACTIVE_TASKS) {
    setTimeout(scheduleCreationTasks, 1000);
    return;
  }
  const nextTask = creationTasks.find((t) => t.status === 'waiting');
  if (!nextTask) {
    setTimeout(scheduleCreationTasks, 1000);
    return;
  }
  const ctrl = creationTaskAbortControllerMap.get(nextTask.id);
  if (!ctrl || ctrl.signal.aborted) {
    state.removeCreationTask(nextTask.id);
    setTimeout(scheduleCreationTasks, 500);
    return;
  }
  state.updateCreationTask({ ...nextTask, status: 'active' });
  try {
    await runCreationTask(nextTask, ctrl.signal);
  } catch (err: any) {
    const errMsg =
      typeof err?.message === 'string' ? err.message : String(err);
    logFn('error', `任务最终失败: ${errMsg}`);
    antNotification.error({ message: '任务失败', description: errMsg });
  } finally {
    state.removeCreationTask(nextTask.id);
  }
  setTimeout(scheduleCreationTasks, 500);
}
setTimeout(scheduleCreationTasks, 10);

// ================= 自动同步 =================
(async function autoSync() {
  while (true) {
    await delay(1000);
    const ids = useDownloadStore.getState().autoSyncTaskIds;
    if (!ids.length) continue;
    try {
      const now = Date.now();
      const resultMap = await aria2.tellStatus(ids);
      const { downloadTasks, batchUpdateDownloadTasks } =
        useDownloadStore.getState();
      const updated = await Promise.all(
        downloadTasks.map(async (old) => {
          if (old.updatedAt > now || !resultMap[old.gid]) return old;
          return mergeAriaStatusToDownloadTask(resultMap[old.gid], old, now);
        }),
      );
      batchUpdateDownloadTasks(updated);
    } catch (e) {
      logFn('error', 'sync error', e);
    }
  }
})();