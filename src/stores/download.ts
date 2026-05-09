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
  batchCreateDownloadTask: (
    paramsList: CreateDownloadTaskParams[],
  ) => Promise<void>;
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
    const oldTaskIndex = oldTasks.findIndex((t) => t.gid === task.gid);
    if (oldTaskIndex === -1) return;
    if (oldTasks[oldTaskIndex].updatedAt > now) return;
    const newTasks = R.adjust(oldTaskIndex, R.always(task))(oldTasks);
    set({ downloadTasks: newTasks });
  },
  batchUpdateDownloadTasks: (tasks) => {
    const { downloadTasks: oldTasks } = get();
    const pairs = tasks.map((t): [string, DownloadTask] => [t.gid, t]);
    const newTaskMap: Record<string, DownloadTask> = R.fromPairs(pairs);
    const newTasks = oldTasks.map((old) => {
      const n = newTaskMap[old.gid];
      if (!n || n.updatedAt < old.updatedAt) return old;
      return n;
    });
    set({ downloadTasks: newTasks });
  },
  batchCreateDownloadTask: async (paramsList) => {
    const tasks: DownloadTask[] = [];
    for (const params of paramsList) {
      try {
        tasks.push(await prepareDownloadTask(params));
      } catch (err: any) {
        log().error('准备下载任务失败，跳过', params.media, err);
      }
    }
    if (tasks.length === 0) return;

    const gids: string[] = (
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
    aria2.invoke('aria2.remove', gid).catch((err) => {
      log().warn('Remove aria2 task failed', { gid, err });
    });
    const state = get();
    set({
      downloadTasks: state.downloadTasks.filter((v) => v.gid !== gid),
      autoSyncTaskIds: state.autoSyncTaskIds.filter((v) => v !== gid),
    });
  },
  batchRemoveDownloadTasks: async (gids) => {
    aria2
      .batchInvoke(
        gids.map((gid) => ({ methodName: 'aria2.remove', params: [gid] })),
      )
      .catch((err) => {
        log().error({ gids, err });
      });
    set({
      downloadTasks: get().downloadTasks.filter(
        (v: DownloadTask) => !gids.includes(v.gid),
      ),
    });
  },
  redownloadTask: async (gid) => {
    const store = get();
    const oldTask = store.downloadTasks.find((t) => t.gid === gid);
    if (!oldTask) throw new Error('找不到旧的下载任务');
    await store.removeDownloadTask(oldTask.gid);
    await store.createDownloadTask({ post: oldTask.post, media: oldTask.media });
  },
  batchRedownloadTask: async (gids) => {
    const store = get();
    const oldTasks = store.downloadTasks.filter((t) => gids.includes(t.gid));
    if (oldTasks.length === 0) throw new Error('找不到旧的下载任务');
    await store.batchRemoveDownloadTasks(gids);
    await store.batchCreateDownloadTask(
      oldTasks.map((t) => ({ media: t.media, post: t.post })),
    );
  },
  syncDownloadTaskStatus: async (gid) => {
    const { downloadTasks, updateDownloadTask, removeDownloadTask } = get();
    const index = downloadTasks.findIndex((v) => v.gid === gid);
    if (index === -1) return;
    const task = downloadTasks[index];
    const now = Date.now();
    const status = await aria2.tellStatus(gid);

    if (status.status === 'error') {
      if (task.ariaRetryCountRemains > 0) {
        log().warn(
          `Task download failed, retry it. RetryCountRemains: ${task.ariaRetryCountRemains}`,
          task,
        );
        removeDownloadTask(task.gid);

        const newTask = await prepareDownloadTask({
          post: task.post,
          media: task.media,
        });
        newTask.ariaRetryCountRemains = task.ariaRetryCountRemains - 1;

        const gid = await aria2.invoke('aria2.addUri', [task.downloadUrl], {
          dir: newTask.dir,
          out: newTask.fileName,
        });
        newTask.gid = gid;

        const status = await aria2.tellStatus(task.gid);
        newTask.status = status.status;

        set({
          downloadTasks: get().downloadTasks.concat(newTask),
        });
      } else {
        const newTask = await mergeAriaStatusToDownloadTask(status, task);
        const msg = '任务下载失败';
        const desc = `${newTask.fileName}\n${newTask.error || '未知原因'}`;
        log().error('Task download failed', newTask);
        antNotification.error({ message: msg, description: desc });
        notification.sendNotification({ title: msg, body: desc });
      }
    } else {
      const newTask = await mergeAriaStatusToDownloadTask(status, task);
      updateDownloadTask(newTask, now);
    }
  },

  creationTasks: [],
  createCreationTask: (user, filter) => {
    const id = crypto.randomUUID?.() ?? (Date.now().toString(36) + Math.random().toString(36).slice(2));
    const abortController = new AbortController();
    creationTaskAbortControllerMap.set(id, abortController);
    set({
      creationTasks: [
        ...get().creationTasks,
        {
          id,
          user,
          filter,
          status: 'waiting' as const,
          completeCount: 0,
          skipCount: 0,
        },
      ],
    });
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
      creationTasks: get().creationTasks.map((old) =>
        old.id === task.id ? task : old,
      ),
    });
  },

  batchProgress: null,
  setBatchProgress: (progress) => set({ batchProgress: progress }),
}));

// ==================== 核心下载流程 ====================
const CONSECUTIVE_POSTS_SKIP_THRESHOLD = 10;
const INITIAL_EMPTY_RETRY_DELAY = 2000;

async function runCreationTask(task: CreationTask, abortSignal: AbortSignal) {
  log().info('========== 开始创建下载任务 ==========', {
    user: task.user.screenName,
    filter: task.filter,
  });
  const { filter, user } = task;
  const { batchCreateDownloadTask, updateCreationTask } =
    useDownloadStore.getState();
  const settings = useSettingsStore.getState();

  let completeCount = 0;
  let skipCount = 0;
  let now = dayjs();
  const since = filter.dateRange?.[0] || dayjs.unix(0);
  const until = filter.dateRange?.[1] || now.clone();
  log().info(
    `日期范围: ${since.format('YYYY-MM-DD')} ~ ${until.format('YYYY-MM-DD')}, 源: ${filter.source}`,
  );

  let nextCursor: string | undefined | null = undefined;
  const getListFn = filter.source === 'medias' ? getUserMedias : getUserTweets;
  const getMediaCounts = R.reduce(
    (acc: number, p: TwitterPost) => acc + (p.medias?.length || 0),
    0,
  );

  let consecutiveSkippedPosts = 0;
  let retriedInitialEmpty = false;

  while (nextCursor !== null && now.isAfter(since)) {
    if (abortSignal.aborted) {
      log().info('任务被取消');
      return;
    }

    log().info(`发起API请求: userId=${user.id}, cursor=${nextCursor}`);
    const { twitterPosts, cursor } = await getListFn(user.id, nextCursor);
    if (abortSignal.aborted) break;
    log().info(`获得 ${twitterPosts.length} 条帖子, cursor=${cursor}`);

    // 首次获取为空的特殊重试
    if (!nextCursor && twitterPosts.length === 0 && !retriedInitialEmpty) {
      log().warn(`首次API返回空，${INITIAL_EMPTY_RETRY_DELAY}ms后重试...`);
      await delay(INITIAL_EMPTY_RETRY_DELAY);
      retriedInitialEmpty = true;
      const retry = await getListFn(user.id, undefined);
      if (retry.twitterPosts.length === 0) {
        log().error('重试后仍无帖子');
        const errMsg = `用户 ${user.screenName} 无法获取帖子（API返回空列表）`;
        antNotification.error({ message: '下载失败', description: errMsg });
        throw new Error(errMsg);
      }
      log().info('重试成功，继续处理');
      // 直接使用重试结果继续本轮循环
      nextCursor = retry.cursor;
      now = R.last(retry.twitterPosts)?.createdAt || now;
      // 下面将重试结果赋值给 twitterPosts 和 cursor，跳过原来的赋值部分
      // 为简化，直接 continue，让下一次循环重新获取
      continue;
    }

    nextCursor = cursor;
    now = R.last(twitterPosts)?.createdAt || now;
    log().info(`当前最新帖子时间: ${now.format('YYYY-MM-DD HH:mm')}`);

    // 过滤帖子
    const filteredPosts = twitterPosts.filter(
      R.allPass([
        (p: TwitterPost) => (p.medias ? p.medias.length >= 0 : false),
        (p: TwitterPost) =>
          !p.createdAt ? true : until ? p.createdAt.isBefore(until) : true,
        (p: TwitterPost) =>
          !p.createdAt ? true : since ? p.createdAt.isAfter(since) : true,
      ]),
    );

    const skippedCountInBatch =
      getMediaCounts(twitterPosts) - getMediaCounts(filteredPosts);
    skipCount += skippedCountInBatch;
    log().info(
      `过滤后剩余 ${filteredPosts.length} 条帖子（跳过 ${skippedCountInBatch} 个媒体）`,
    );

    if (filteredPosts.length === 0) {
      updateCreationTask({ ...task, completeCount, skipCount });
      continue;
    }

    const paramsList: CreateDownloadTaskParams[] = [];

    for (const post of filteredPosts) {
      const filteredMedias = post.medias!.filter(
        R.allPass([
          (m: TwitterMedia) =>
            filter.mediaTypes ? filter.mediaTypes.includes(m.type) : true,
        ]),
      );

      log().info(`处理帖子 ${post.id}: 媒体数量 ${filteredMedias.length}`);

      let allExistingSkipped = true;
      let hasError = false;

      for (const media of filteredMedias) {
        try {
          const dlTask = await prepareDownloadTask({ post, media });
          const filePath = await path.join(dlTask.dir, dlTask.fileName);
          if (settings.download.sameFileSkip && (await fs.exists(filePath))) {
            skipCount++;
            log().info(`跳过已存在文件: ${filePath}`);
          } else {
            allExistingSkipped = false;
            paramsList.push({ media, post });
          }
        } catch (err: any) {
          log().error(`准备下载失败: ${err.message}`, media);
          skipCount++;
          hasError = true;
          allExistingSkipped = false;
        }
      }

      if (allExistingSkipped && !hasError) {
        consecutiveSkippedPosts++;
        log().info(`连续跳过帖子 ${consecutiveSkippedPosts}`);
        if (consecutiveSkippedPosts >= CONSECUTIVE_POSTS_SKIP_THRESHOLD) {
          log().info(`连续跳过达到阈值，提前结束用户 ${user.screenName}`);
          updateCreationTask({ ...task, completeCount, skipCount });
          return;
        }
      } else {
        consecutiveSkippedPosts = 0;
      }
    }

    if (paramsList.length > 0) {
      log().info(`批量创建 ${paramsList.length} 个下载任务`);
      await batchCreateDownloadTask(paramsList);
      completeCount += paramsList.length;
    }

    updateCreationTask({ ...task, completeCount, skipCount });

    if (abortSignal.aborted) break;
  }

  log().info(
    `任务正常结束: 用户 ${user.screenName}, 下载 ${completeCount}, 跳过 ${skipCount}`,
  );
}

// ==================== 任务调度 ====================
async function scheduleCreationTasks() {
  const { creationTasks, removeCreationTask, updateCreationTask } =
    useDownloadStore.getState();

  if (R.isEmpty(creationTasks)) {
    requestIdleCallback(scheduleCreationTasks);
    return;
  }

  const runningTask = creationTasks.find((t) => t.status === 'active');
  if (runningTask) {
    requestIdleCallback(scheduleCreationTasks);
    return;
  }

  const nextTask = R.head(creationTasks) as CreationTask;
  const abortController = creationTaskAbortControllerMap.get(nextTask.id);
  if (abortController?.signal.aborted) {
    removeCreationTask(nextTask.id);
    requestIdleCallback(scheduleCreationTasks);
    return;
  }

  nextTask.status = 'active';
  updateCreationTask(nextTask);

  try {
    await runCreationTask(nextTask, abortController!.signal);
    removeCreationTask(nextTask.id);
  } catch (err: any) {
    log().error('runCreationTask失败', err);
    removeCreationTask(nextTask.id);
    const reason = typeof err === 'string' ? err : err?.message || '未知原因';
    notification.sendNotification({ title: '爬虫任务运行失败', body: reason });
    antNotification.error({
      message: '爬虫任务运行失败',
      description: reason,
    });
  }

  requestIdleCallback(scheduleCreationTasks);
}

scheduleCreationTasks();

// ==================== 自动同步 ====================
const INTERVAL = 500;
async function scheduleAutoSyncTasks() {
  const ids = useDownloadStore.getState().autoSyncTaskIds;
  if (ids.length === 0) {
    setTimeout(scheduleAutoSyncTasks, INTERVAL);
    return;
  }

  const now = Date.now();
  const resultMap = await aria2.tellStatus(ids);
  const { downloadTasks, batchUpdateDownloadTasks } =
    useDownloadStore.getState();
  const newTasks = await Promise.all(
    downloadTasks.map(async (old) => {
      if (old.updatedAt > now) return old;
      if (!resultMap[old.gid]) return old;
      return mergeAriaStatusToDownloadTask(resultMap[old.gid], old, now);
    }),
  );
  batchUpdateDownloadTasks(newTasks);

  setTimeout(scheduleAutoSyncTasks, INTERVAL);
}
scheduleAutoSyncTasks();