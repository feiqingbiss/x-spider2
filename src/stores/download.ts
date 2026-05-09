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

let _log: ICategoriedLogger;

function log() {
  if (_log) return _log;
  _log = window.log.category('DL');
  return _log;
}

// 强制刷新日志缓冲区到文件（Logger 内部有 500ms 延迟）
function flushLog() {
  // 通过发送一条紧急日志触发写入
  setTimeout(() => {
    log().info('--- 强制刷新日志 ---');
  }, 0);
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
  log().info('downloadUrl', downloadUrl);
  const templateData: FileNameTemplateData = { media, post };
  const resolvedDirName = settings.download.dirTemplate
    ? resolveVariables(settings.download.dirTemplate, templateData)
    : '';
  log().info('resolved dirName', resolvedDirName);
  const dir = await path.join(settings.download.saveDirBase, resolvedDirName);
  log().info('resolved dir', dir);
  const fileName = resolveVariables(settings.download.fileNameTemplate, templateData);
  log().info('resolved fileName', fileName);

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
  return task;
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
    const status = await aria2.tellStatus(task.gid);
    task.status = status.status;
    set({ downloadTasks: get().downloadTasks.concat(task) });
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
    const tasks: DownloadTask[] = [];
    for (const p of paramsList) {
      try { tasks.push(await prepareDownloadTask(p)); }
      catch (e: any) { log().error('prepare failed', p.media, e); }
    }
    if (!tasks.length) return;
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
    aria2.invoke('aria2.remove', gid).catch(e => log().warn('remove failed', gid, e));
    const s = get();
    set({ downloadTasks: s.downloadTasks.filter(v => v.gid !== gid), autoSyncTaskIds: s.autoSyncTaskIds.filter(v => v !== gid) });
  },
  batchRemoveDownloadTasks: async (gids) => {
    aria2.batchInvoke(gids.map(g => ({ methodName: 'aria2.remove', params: [g] }))).catch(e => log().error(gids, e));
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
        log().warn(`Retry download ${task.ariaRetryCountRemains}`, task);
        removeDownloadTask(gid);
        const newTask = await prepareDownloadTask({ post: task.post, media: task.media });
        newTask.ariaRetryCountRemains = task.ariaRetryCountRemains - 1;
        const newGid = await aria2.invoke('aria2.addUri', [task.downloadUrl], { dir: newTask.dir, out: newTask.fileName });
        newTask.gid = newGid;
        newTask.status = (await aria2.tellStatus(newGid)).status;
        set({ downloadTasks: get().downloadTasks.concat(newTask) });
      } else {
        const merged = await mergeAriaStatusToDownloadTask(status, task);
        log().error('Download failed', merged);
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
    log().info(`创建下载任务: ${user.screenName}, source=${filter.source}`);
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

// ================= 核心下载流程（带实时通知） =================
const CONSECUTIVE_POSTS_SKIP_THRESHOLD = 10;
const INITIAL_EMPTY_RETRY_DELAY = 2000;

async function runCreationTask(task: CreationTask, abortSignal: AbortSignal) {
  const { filter, user } = task;
  const store = useDownloadStore.getState();
  const { batchCreateDownloadTask, updateCreationTask } = store;
  const settings = useSettingsStore.getState();

  // 强制刷新日志，确保开始日志写入文件
  flushLog();

  // 开始通知
  antNotification.info({
    message: `开始处理 ${user.screenName}`,
    description: `源: ${filter.source === 'medias' ? '媒体' : '帖子'}`,
    key: `start-${user.screenName}`,
  });

  let completeCount = 0;
  let skipCount = 0;
  let now = dayjs();
  const since = filter.dateRange?.[0] || dayjs.unix(0);
  const until = filter.dateRange?.[1] || now.clone();
  let nextCursor: string | undefined | null = undefined;
  const getListFn = filter.source === 'medias' ? getUserMedias : getUserTweets;

  let consecutiveSkippedPosts = 0;
  let retriedInitialEmpty = false;
  let totalPosts = 0; // 本次任务总共获取到的帖子数（用于通知）

  try {
    while (nextCursor !== null && now.isAfter(since)) {
      if (abortSignal.aborted) break;

      log().info(`API请求: ${user.id}, cursor: ${nextCursor}`);
      const { twitterPosts, cursor } = await getListFn(user.id, nextCursor);
      if (abortSignal.aborted) break;
      totalPosts += twitterPosts.length;

      // 首次空列表重试
      if (!nextCursor && twitterPosts.length === 0 && !retriedInitialEmpty) {
        log().warn(`首次API返回空，${INITIAL_EMPTY_RETRY_DELAY}ms后重试`);
        await delay(INITIAL_EMPTY_RETRY_DELAY);
        retriedInitialEmpty = true;
        const retry = await getListFn(user.id, undefined);
        if (retry.twitterPosts.length === 0) {
          const errMsg = `API 返回空列表，可能该用户的媒体源无数据，请尝试切换到“帖子”源`;
          log().error(errMsg);
          antNotification.error({ message: `下载中止: ${user.screenName}`, description: errMsg });
          throw new Error(errMsg);
        }
        log().info('重试获得帖子，继续');
        // 将重试结果赋值给当前变量，继续循环
        nextCursor = retry.cursor;
        now = R.last(retry.twitterPosts)?.createdAt || now;
        // 直接跳过本次循环剩余部分，用重试结果重新进入循环
        continue;
      }

      nextCursor = cursor;
      now = R.last(twitterPosts)?.createdAt || now;

      // 过滤
      const filteredPosts = twitterPosts.filter(p => {
        if (!p.medias?.length) return false;
        let dateOk = true;
        if (p.createdAt) {
          if (since && p.createdAt.isBefore(since)) dateOk = false;
          if (until && p.createdAt.isAfter(until)) dateOk = false;
        }
        return dateOk;
      }).filter(p => {
        if (!filter.mediaTypes?.length) return true;
        return p.medias!.some(m => filter.mediaTypes!.includes(m.type));
      });

      const skipped = twitterPosts.length - filteredPosts.length;
      skipCount += skipped;
      log().info(`帖子数: ${twitterPosts.length}, 过滤后: ${filteredPosts.length}`);

      if (filteredPosts.length === 0) {
        updateCreationTask({ ...task, completeCount, skipCount });
        continue;
      }

      const paramsList: CreateDownloadTaskParams[] = [];
      for (const post of filteredPosts) {
        for (const media of post.medias!) {
          if (filter.mediaTypes && !filter.mediaTypes.includes(media.type)) continue;
          try {
            const dlTask = await prepareDownloadTask({ post, media });
            const fp = await path.join(dlTask.dir, dlTask.fileName);
            if (settings.download.sameFileSkip && (await fs.exists(fp))) {
              skipCount++;
              log().info(`已存在: ${fp}`);
              // 文件已存在，不计入连续跳过帖子的逻辑在下面
            } else {
              paramsList.push({ media, post });
            }
          } catch (e: any) {
            log().error('prepare error', media, e);
            skipCount++;
          }
        }
      }

      // 连续跳过帖子检测
      // （简化：仅当整个 batch 都没有新增下载时累加）
      if (paramsList.length === 0) {
        consecutiveSkippedPosts++;
        if (consecutiveSkippedPosts >= CONSECUTIVE_POSTS_SKIP_THRESHOLD) {
          log().info(`连续${consecutiveSkippedPosts}批无新内容，提前结束`);
          updateCreationTask({ ...task, completeCount, skipCount });
          break;
        }
      } else {
        consecutiveSkippedPosts = 0;
      }

      if (paramsList.length) {
        await batchCreateDownloadTask(paramsList);
        completeCount += paramsList.length;
      }
      updateCreationTask({ ...task, completeCount, skipCount });
    }

    flushLog();
    const resultMsg = `下载了 ${completeCount} 个文件，跳过 ${skipCount} 个`;
    log().info(`任务结束: ${user.screenName} ${resultMsg}`);
    antNotification.success({
      message: `${user.screenName} 处理完成`,
      description: resultMsg + (totalPosts === 0 ? ' (未获取到任何帖子，请尝试切换下载源)' : ''),
      key: `finish-${user.screenName}`,
    });
  } catch (err: any) {
    log().error(`任务异常: ${user.screenName}`, err);
    throw err;
  }
}

// ================= 调度器（使用 setTimeout 提高响应） =================
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
    removeCreationTask(nextTask.id);
  } catch (err: any) {
    log().error(`任务最终失败: ${nextTask.id}`, err);
    removeCreationTask(nextTask.id);
    antNotification.error({
      message: `任务失败: ${nextTask.user.screenName}`,
      description: err.message || '未知错误',
    });
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
    } catch (e) { log().error('autoSync error', e); }
  }
})();