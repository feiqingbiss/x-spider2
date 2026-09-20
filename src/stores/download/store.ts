import { create } from 'zustand';
import * as R from 'ramda';
import { aria2, AriaStatus } from '../../utils/aria2';
import { DownloadTask } from '../../interfaces/DownloadTask';
import { notification } from '@tauri-apps/api';
import { notification as antNotification } from 'antd';
import { DownloadStore } from './types';
import {
  prepareDownloadTask,
  mergeAriaStatusToDownloadTask,
  logFn,
} from './utils';
import { creationTaskAbortControllerMap } from './creation';
import { perf } from './performance';

export const useDownloadStore = create<DownloadStore>((set, get) => ({
  currentTab: '',
  setCurrentTab: (tab) => set({ currentTab: tab }),

  autoSyncTaskIds: [],
  // ✅ 修复：ids 内容不变时不触发 set，避免 onItemsRendered 每帧都重渲染
  setAutoSyncTaskIds: (ids) => {
    const old = get().autoSyncTaskIds;
    if (
      old.length === ids.length &&
      old.every((v, i) => v === ids[i])
    ) {
      return;
    }
    set({ autoSyncTaskIds: ids });
  },

  downloadTasks: [],
  createDownloadTask: async (params) => {
    perf.mark('createDownload-start');
    const { task, thumbTask } = await prepareDownloadTask(params);

    const gid = await aria2.invoke('aria2.addUri', [task.downloadUrl], {
      dir: task.dir,
      out: task.fileName,
    });
    task.gid = gid;

    if (thumbTask) {
      aria2
        .invoke('aria2.addUri', [thumbTask.url], {
          dir: thumbTask.dir,
          out: thumbTask.fileName,
        })
        .catch((e) => logFn('warn', '封面图下载任务发送失败', e));
    }

    const status = await aria2.tellStatus(task.gid);
    task.status = status.status;
    set({ downloadTasks: get().downloadTasks.concat(task) });
    perf.measure(
      'createDownload',
      'createDownload-start',
      'createDownload-end',
    );
  },
  updateDownloadTask: (task, now = Date.now()) => {
    const oldTasks = get().downloadTasks;
    const idx = oldTasks.findIndex((t) => t.gid === task.gid);
    if (idx === -1 || oldTasks[idx].updatedAt > now) return;
    // ✅ 修复：如果新旧内容完全等价，不触发 set
    const old = oldTasks[idx];
    if (
      old.status === task.status &&
      old.completeSize === task.completeSize &&
      old.totalSize === task.totalSize &&
      old.error === task.error &&
      old.updatedAt === task.updatedAt
    ) {
      return;
    }
    set({ downloadTasks: R.adjust(idx, R.always(task))(oldTasks) });
  },
  // ✅ 修复：无实际变化时不 set，避免频繁重渲染
  batchUpdateDownloadTasks: (tasks) => {
    const { downloadTasks: old } = get();
    const map = R.fromPairs(
      tasks.map((t) => [t.gid, t] as [string, DownloadTask]),
    );
    let changed = false;
    const next = old.map((o) => {
      const n = map[o.gid];
      if (!n || n === o) return o;
      // 仅当内容真有变化（updatedAt 推进）才认为变了
      if (
        n.status !== o.status ||
        n.completeSize !== o.completeSize ||
        n.totalSize !== o.totalSize ||
        n.error !== o.error
      ) {
        changed = true;
        return n;
      }
      return o;
    });
    if (changed) set({ downloadTasks: next });
  },
  batchCreateDownloadTask: async (paramsList) => {
    const tasks: DownloadTask[] = [];
    const thumbTasks: Array<{ url: string; dir: string; fileName: string }> =
      [];

    for (const p of paramsList) {
      try {
        const { task, thumbTask } = await prepareDownloadTask(p);
        tasks.push(task);
        if (thumbTask) thumbTasks.push(thumbTask);
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

    if (thumbTasks.length) {
      aria2
        .batchInvoke(
          thumbTasks.map((t) => ({
            methodName: 'aria2.addUri',
            params: [[t.url], { dir: t.dir, out: t.fileName }],
          })),
        )
        .catch((e) => logFn('warn', '封面图批量下载任务发送失败', e));
    }

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
    aria2
      .invoke('aria2.remove', gid)
      .catch((e) => logFn('warn', 'remove fail', e));
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
    await s.batchCreateDownloadTask(
      olds.map((t) => ({ media: t.media, post: t.post })),
    );
  },
  syncDownloadTaskStatus: async (gid) => {
    const { downloadTasks, updateDownloadTask, removeDownloadTask } = get();
    const task = downloadTasks.find((v) => v.gid === gid);
    if (!task) return;
    const now = Date.now();
    const status = await aria2.tellStatus(gid);

    if (status.status === 'error') {
      if (task.ariaRetryCountRemains > 0) {
        logFn(
          'warn',
          `重试下载 ${task.ariaRetryCountRemains} (剩余重试次数: ${task.ariaRetryCountRemains - 1})`,
        );
        let newGid: string;
        try {
          newGid = await aria2.invoke('aria2.addUri', [task.downloadUrl], {
            dir: task.dir,
            out: task.fileName,
          });
        } catch (err: any) {
          logFn('error', `重试添加下载失败: ${err.message}`);
          const merged = await mergeAriaStatusToDownloadTask(status, task);
          updateDownloadTask(
            { ...merged, error: `重试失败: ${err.message}` },
            now,
          );
          return;
        }

        const newTask: DownloadTask = {
          ...task,
          gid: newGid,
          status: AriaStatus.Waiting,
          ariaRetryCountRemains: task.ariaRetryCountRemains - 1,
          updatedAt: now,
        };

        await removeDownloadTask(gid);
        set({ downloadTasks: get().downloadTasks.concat(newTask) });
        logFn('info', `重试成功，新任务 gid: ${newGid}`);

        try {
          const newStatus = await aria2.tellStatus(newGid);
          if (newStatus.status !== 'error') {
            updateDownloadTask(
              await mergeAriaStatusToDownloadTask(newStatus, newTask),
              now,
            );
          }
        } catch (e) {
          // ignore
        }
      } else {
        const merged = await mergeAriaStatusToDownloadTask(status, task);
        logFn('error', '下载失败（重试耗尽）', merged);
        antNotification.error({
          message: `下载失败: ${merged.fileName}`,
          description: merged.error || '未知错误',
          duration: 5,
        });
        notification.sendNotification({
          title: '下载失败',
          body: `${merged.fileName} - ${merged.error || '未知错误'}`,
        });
        updateDownloadTask(merged, now);
      }
    } else {
      updateDownloadTask(
        await mergeAriaStatusToDownloadTask(status, task),
        now,
      );
    }
  },
  creationTasks: [],
  createCreationTask: (user, filter) => {
    const id = crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
    const ctrl = new AbortController();
    creationTaskAbortControllerMap.set(id, ctrl);
    set({
      creationTasks: [
        ...get().creationTasks,
        {
          id,
          user,
          filter,
          status: 'waiting',
          completeCount: 0,
          skipCount: 0,
          phase: 'waiting',
          indexedPosts: 0,
        },
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

// ================= 自动同步（优化版） =================
let syncTimerId: ReturnType<typeof setInterval> | null = null;

async function doAutoSync() {
  const ids = useDownloadStore.getState().autoSyncTaskIds;
  if (!ids.length) return;
  try {
    const now = Date.now();
    const resultMap = await aria2.tellStatus(ids);
    const { downloadTasks, batchUpdateDownloadTasks } =
      useDownloadStore.getState();
    const updated = await Promise.all(
      downloadTasks.map(async (old) => {
        if (old.updatedAt > now || !resultMap[old.gid]) return old;
        const merged = await mergeAriaStatusToDownloadTask(
          resultMap[old.gid],
          old,
          now,
        );
        if (
          merged.status === old.status &&
          merged.completeSize === old.completeSize &&
          merged.totalSize === old.totalSize &&
          merged.error === old.error
        ) {
          return old;
        }
        return merged;
      }),
    );
    batchUpdateDownloadTasks(updated);
  } catch (e) {
    logFn('error', 'sync error', e);
  }
}

function startAutoSync() {
  if (syncTimerId !== null) return;
  syncTimerId = setInterval(doAutoSync, 5000);
}

function stopAutoSync() {
  if (syncTimerId !== null) {
    clearInterval(syncTimerId);
    syncTimerId = null;
  }
}

startAutoSync();

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    stopAutoSync();
  });
}