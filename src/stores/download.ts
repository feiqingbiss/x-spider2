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

// ================= 强日志系统（直接写文件） =================
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

async function writeDebugLog(message: string) {
  try {
    const filePath = await ensureDebugLogPath();
    const timestamp = new Date().toISOString();
    const line = `${timestamp} ${message}\n`;
    await fs.writeTextFile(filePath, line, { append: true });
  } catch (e) {
    // 静默失败，避免循环
  }
}

function logFn(level: string, ...args: any[]) {
  const msg = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
  const fullMsg = `[DL] [${level.toUpperCase()}] ${msg}`;
  // 写入文件
  writeDebugLog(fullMsg);
  // 同时输出到原始 log（如果可用）
  try {
    if (window.log && window.log.category) {
      const logger = window.log.category('DL');
      if (level === 'error') logger.error(...args);
      else if (level === 'warn') logger.warn(...args);
      else logger.info(...args);
    }
  } catch (_) {}
}

export interface CreateDownloadTaskParams {
  post: TwitterPost;
  media: TwitterMedia;
}

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
  logFn('info', `  目录: ${dir}, 文件名: ${fileName}`);
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

export interface BatchProgress {
  total: number;
  completed: number;
  currentUser: string;
}

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
    const gid = await aria2.invoke('aria2.addUri', [task.downloadUrl], { dir: task.dir, out: task.fileName });
    task.gid = gid;
    task.status = (await aria2.tellStatus(gid)).status;
    set({ downloadTasks: get().downloadTasks.concat(task) });
    logFn('info', `已添加到 Aria2: ${task.fileName}`);
  },
  updateDownloadTask: (task, now = Date.now()) => {
    const oldTasks = get().downloadTasks;
    const idx = oldTasks.findIndex(t => t.gid === task.gid);
    if (idx === -1 || oldTasks[idx].updatedAt > now) return;
    set({ downloadTasks: R.adjust(idx, R.always(task))(oldTasks) });
  },
  batchUpdateDownloadTasks: (tasks) => {
    const { downloadTasks: old } = get();
    const map = R.fromPairs(tasks.map(t => [t.gid, t] as [string, DownloadTask]));
    set({ downloadTasks: old.map(o => (map[o.gid]?.updatedAt >= o.updatedAt ? map[o.gid] : o)) });
  },
  batchCreateDownloadTask: async (paramsList) => {
    logFn('info', `批量创建 ${paramsList.length} 个下载任务`);
    const tasks: DownloadTask[] = [];
    for (const p of paramsList) {
      try {
        tasks.push(await prepareDownloadTask(p));
      } catch (e: any) {
        logFn('error', `准备任务失败: ${e.message}`, p.media);
      }
    }
    if (tasks.length === 0) return;
    const gids = (await aria2.batchInvoke(tasks.map(t => ({
      methodName: 'aria2.addUri',
      params: [[t.downloadUrl], { dir: t.dir, out: t.fileName }],
    })))).flat();
    const statusMap = await aria2.tellStatus(gids);
    tasks.forEach((t, i) => { t.gid = gids[i]; t.status = statusMap[t.gid].status; });
    set({ downloadTasks: get().downloadTasks.concat(tasks) });
  },
  pauseDownloadTask: async (gid) => { await aria2.invoke('aria2.pause', gid); },
  pauseAllDownloadTask: async () => { await aria2.invoke('aria2.pauseAll'); },
  unpauseDownloadTask: async (gid) => { await aria2.invoke('aria2.unpause', gid); },
  unpauseAllDownloadTask: async () => { await aria2.invoke('aria2.unpauseAll'); },
  removeDownloadTask: async (gid) => {
    aria2.invoke('aria2.remove', gid).catch(e => logFn('warn', '移除下载任务失败', gid, e));
    const s = get();
    set({ downloadTasks: s.downloadTasks.filter(v => v.gid !== gid), autoSyncTaskIds: s.autoSyncTaskIds.filter(v => v !== gid) });
  },
  batchRemoveDownloadTasks: async (gids) => {
    aria2.batchInvoke(gids.map(g => ({ methodName: 'aria2.remove', params: [g] }))).catch(e => logFn('error', gids, e));
    set({ downloadTasks: get().downloadTasks.filter(v => !gids.includes(v.gid)) });
  },
  redownloadTask: async (gid) => {
    const s = get();
    const old = s.downloadTasks.find(t => t.gid === gid);
    if (!old) throw new Error('task not found');
    await s.removeDownloadTask(gid);
    await s.createDownloadTask({ post: old.post, media: old.media });
  },
  batchRedownloadTask: async (gids) => {
    const s = get();
    const olds = s.downloadTasks.filter(t => gids.includes(t.gid));
    if (!olds.length) throw new Error('no tasks');
    await s.batchRemoveDownloadTasks(gids);
    await s.batchCreateDownloadTask(olds.map(t => ({ media: t.media, post: t.post })));
  },
  syncDownloadTaskStatus: async (gid) => {
    const { downloadTasks, updateDownloadTask, removeDownloadTask } = get();
    const task = downloadTasks.find(v => v.gid === gid);
    if (!task) return;
    const now = Date.now();
    const status = await aria2.tellStatus(gid);
    if (status.status === 'error') {
      if (task.ariaRetryCountRemains > 0) {
        logFn('warn', `重试下载 ${task.ariaRetryCountRemains}`);
        removeDownloadTask(gid);
        const newTask = await prepareDownloadTask({ post: task.post, media: task.media });
        newTask.ariaRetryCountRemains = task.ariaRetryCountRemains - 1;
        const newGid = await aria2.invoke('aria2.addUri', [task.downloadUrl], { dir: newTask.dir, out: newTask.fileName });
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
    const id = crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
    const ctrl = new AbortController();
    creationTaskAbortControllerMap.set(id, ctrl);
    logFn('info', `新建下载任务: ${user.screenName}, 源: ${filter.source}`);
    set({
      creationTasks: [...get().creationTasks, { id, user, filter, status: 'waiting', completeCount: 0, skipCount: 0 }],
    });
  },
  removeCreationTask: (id) => {
    const ctrl = creationTaskAbortControllerMap.get(id);
    if (ctrl) { ctrl.abort(); creationTaskAbortControllerMap.delete(id); }
    set({ creationTasks: get().creationTasks.filter(v => v.id !== id) });
  },
  updateCreationTask: (task) => {
    set({ creationTasks: get().creationTasks.map(o => (o.id === task.id ? task : o)) });
  },
  batchProgress: null,
  setBatchProgress: (p) => set({ batchProgress: p }),
}));

// ================= 核心下载流程 =================
const CONSECUTIVE_POSTS_SKIP_THRESHOLD = 10;
const INITIAL_EMPTY_RETRY_DELAY = 2000;

async function runCreationTask(task: CreationTask, abortSignal: AbortSignal) {
  const { filter, user } = task;
  const store = useDownloadStore.getState();
  const { batchCreateDownloadTask, updateCreationTask } = store;
  const settings = useSettingsStore.getState();

  logFn('info', `========== 开始处理用户: ${user.screenName} (源: ${filter.source}) ==========`);
  const startTime = Date.now();
  let completeCount = 0;
  let skipCount = 0;
  let now = dayjs();
  const since = filter.dateRange?.[0] || dayjs.unix(0);
  const until = filter.dateRange?.[1] || now.clone();
  let nextCursor: string | undefined | null = undefined;
  const getListFn = filter.source === 'medias' ? getUserMedias : getUserTweets;
  let consecutiveSkippedPosts = 0;
  let retriedInitialEmpty = false;

  try {
    while (nextCursor !== null && now.isAfter(since)) {
      if (abortSignal.aborted) { logFn('warn', '任务被取消'); break; }

      logFn('info', `--- 请求API: userId=${user.id}, cursor=${nextCursor} ---`);
      const reqStart = Date.now();
      let resp;
      try {
        resp = await getListFn(user.id, nextCursor);
      } catch (apiErr: any) {
        logFn('error', `API请求失败: ${apiErr.message || apiErr}`);
        throw apiErr;
      }
      logFn('info', `API响应耗时: ${Date.now() - reqStart}ms, 帖子数: ${resp.twitterPosts.length}, cursor: ${resp.cursor}`);

      if (abortSignal.aborted) break;
      const { twitterPosts, cursor } = resp;

      if (!nextCursor && twitterPosts.length === 0 && !retriedInitialEmpty) {
        logFn('warn', `首次获取为空，${INITIAL_EMPTY_RETRY_DELAY}ms后重试`);
        await delay(INITIAL_EMPTY_RETRY_DELAY);
        retriedInitialEmpty = true;
        const retry = await getListFn(user.id, undefined);
        logFn('info', `重试结果: ${retry.twitterPosts.length} 条帖子`);
        if (retry.twitterPosts.length === 0) {
          logFn('error', '重试后仍无帖子');
          const errMsg = `用户 ${user.screenName} 无法获取任何帖子（API返回空列表）`;
          antNotification.error({ message: '下载失败', description: errMsg });
          throw new Error(errMsg);
        }
        nextCursor = retry.cursor;
        now = R.last(retry.twitterPosts)?.createdAt || now;
        continue;
      }

      nextCursor = cursor;
      now = R.last(twitterPosts)?.createdAt || now;
      logFn('info', `最新帖子时间: ${now.format('YYYY-MM-DD HH:mm')}`);

      const filteredPosts = twitterPosts.filter(p => {
        const hasMedia = p.medias && p.medias.length > 0;
        if (!hasMedia) return false;
        let dateOk = true;
        if (p.createdAt) {
          if (since && p.createdAt.isBefore(since)) dateOk = false;
          if (until && p.createdAt.isAfter(until)) dateOk = false;
        }
        return dateOk;
      });

      const skippedCountInBatch = twitterPosts.length - filteredPosts.length;
      skipCount += skippedCountInBatch;
      logFn('info', `过滤后: ${filteredPosts.length} 条帖子 (跳过 ${skippedCountInBatch} 条)`);

      if (filteredPosts.length === 0) {
        updateCreationTask({ ...task, completeCount, skipCount });
        continue;
      }

      const paramsList: CreateDownloadTaskParams[] = [];
      for (const post of filteredPosts) {
        const medias = post.medias!;
        let postAdded = false;
        for (const media of medias) {
          if (filter.mediaTypes && !filter.mediaTypes.includes(media.type)) continue;
          try {
            const dlTask = await prepareDownloadTask({ post, media });
            const filePath = await path.join(dlTask.dir, dlTask.fileName);
            if (settings.download.sameFileSkip && (await fs.exists(filePath))) {
              skipCount++;
              logFn('info', `文件已存在跳过: ${filePath}`);
              continue;
            }
            paramsList.push({ media, post });
            postAdded = true;
          } catch (err: any) {
            logFn('error', `准备下载失败 (${media.url}): ${err.message}`);
            skipCount++;
          }
        }
        if (!postAdded) {
          consecutiveSkippedPosts++;
          if (consecutiveSkippedPosts >= CONSECUTIVE_POSTS_SKIP_THRESHOLD) {
            logFn('info', `连续 ${consecutiveSkippedPosts} 个帖子无新内容，提前结束`);
            updateCreationTask({ ...task, completeCount, skipCount });
            return;
          }
        } else {
          consecutiveSkippedPosts = 0;
        }
      }

      if (paramsList.length > 0) {
        logFn('info', `本批次需下载 ${paramsList.length} 个文件`);
        await batchCreateDownloadTask(paramsList);
        completeCount += paramsList.length;
      }
      updateCreationTask({ ...task, completeCount, skipCount });
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    logFn('info', `用户 ${user.screenName} 处理完成: 下载 ${completeCount}, 跳过 ${skipCount}, 耗时 ${elapsed}s`);
    antNotification.success({
      message: `${user.screenName} 完成`,
      description: `下载 ${completeCount}, 跳过 ${skipCount}`,
    });
  } catch (err: any) {
    logFn('error', `用户 ${user.screenName} 任务异常: ${err.message || err}`);
    throw err;
  }
}

async function scheduleCreationTasks() {
  const state = useDownloadStore.getState();
  const { creationTasks, removeCreationTask, updateCreationTask } = state;

  if (R.isEmpty(creationTasks)) {
    setTimeout(scheduleCreationTasks, 300);
    return;
  }
  if (creationTasks.some(t => t.status === 'active')) {
    setTimeout(scheduleCreationTasks, 300);
    return;
  }
  const nextTask = creationTasks[0];
  const ctrl = creationTaskAbortControllerMap.get(nextTask.id);
  if (!ctrl || ctrl.signal.aborted) {
    removeCreationTask(nextTask.id);
    setTimeout(scheduleCreationTasks, 300);
    return;
  }
  nextTask.status = 'active';
  updateCreationTask(nextTask);
  try {
    await runCreationTask(nextTask, ctrl.signal);
    logFn('info', `任务完成，移除: ${nextTask.id}`);
    removeCreationTask(nextTask.id);
  } catch (err: any) {
    logFn('error', `任务失败: ${nextTask.id}, ${err.message}`);
    removeCreationTask(nextTask.id);
    antNotification.error({ message: '任务失败', description: err.message });
  }
  setTimeout(scheduleCreationTasks, 300);
}

setTimeout(scheduleCreationTasks, 10);

// ================= 自动同步 =================
(async function autoSync() {
  while (true) {
    await delay(500);
    const ids = useDownloadStore.getState().autoSyncTaskIds;
    if (!ids.length) continue;
    try {
      const now = Date.now();
      const resultMap = await aria2.tellStatus(ids);
      const { downloadTasks, batchUpdateDownloadTasks } = useDownloadStore.getState();
      const updated = await Promise.all(downloadTasks.map(async old => {
        if (old.updatedAt > now) return old;
        if (!resultMap[old.gid]) return old;
        return mergeAriaStatusToDownloadTask(resultMap[old.gid], old, now);
      }));
      batchUpdateDownloadTasks(updated);
    } catch (e) { logFn('error', 'autoSync error', e); }
  }
})();