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
import { useSettingsStore } from '../settings';
import { perf } from './performance';

function buildAddUriOptions(
  dir: string,
  fileName: string,
): Record<string, string> {
  const settings = useSettingsStore.getState();
  const skipSameFile = settings.download.sameFileSkip;
  return {
    dir,
    out: fileName,
    'auto-file-renaming': 'false',
    'allow-overwrite': skipSameFile ? 'false' : 'true',
    continue: 'true',
  };
}

function isFileAlreadyExistsError(
  errMsg: string,
  errCode?: number | string,
): boolean {
  if (errCode === 13 || errCode === '13') return true;
  const m = (errMsg || '').toLowerCase();
  return (
    m.includes('already exists') ||
    m.includes('file exists') ||
    m.includes('cannot overwrite')
  );
}

export const useDownloadStore = create<DownloadStore>((set, get) => ({
  currentTab: '',
  setCurrentTab: (tab) => set({ currentTab: tab }),

  autoSyncTaskIds: [],
  setAutoSyncTaskIds: (ids) => {
    const old = get().autoSyncTaskIds;
    if (old.length === ids.length && old.every((v, i) => v === ids[i])) {
      return;
    }
    set({ autoSyncTaskIds: ids });
  },

  downloadTasks: [],
  createDownloadTask: async (params) => {
    perf.mark('createDownload-start');
    const { task, thumbTask } = await prepareDownloadTask(params);

    let gid: string;
    try {
      gid = await aria2.invoke(
        'aria2.addUri',
        [task.downloadUrl],
        buildAddUriOptions(task.dir, task.fileName),
      );
    } catch (err: any) {
      const errMsg = err?.message || String(err);
      if (isFileAlreadyExistsError(errMsg)) {
        logFn('info', `文件已存在，跳过：${task.fileName}`);
        const skipTask: DownloadTask = {
          ...task,
          gid: `skip-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          status: AriaStatus.Complete,
          completeSize: 1,
          totalSize: 1,
          error: '',
          updatedAt: Date.now(),
        };
        set({ downloadTasks: get().downloadTasks.concat(skipTask) });
        perf.measure(
          'createDownload',
          'createDownload-start',
          'createDownload-end',
        );
        return;
      }
      throw err;
    }

    task.gid = gid;

    if (thumbTask) {
      aria2
        .invoke(
          'aria2.addUri',
          [thumbTask.url],
          buildAddUriOptions(thumbTask.dir, thumbTask.fileName),
        )
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
  batchUpdateDownloadTasks: (tasks) => {
    const { downloadTasks: old } = get();
    const map = R.fromPairs(
      tasks.map((t) => [t.gid, t] as [string, DownloadTask]),
    );
    let changed = false;
    const next = old.map((o) => {
      const n = map[o.gid];
      if (!n || n === o) return o;
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

    const goodTasks: DownloadTask[] = [];
    const skipTasks: DownloadTask[] = [];

    for (const t of tasks) {
      try {
        const gid = await aria2.invoke(
          'aria2.addUri',
          [t.downloadUrl],
          buildAddUriOptions(t.dir, t.fileName),
        );
        t.gid = gid;
        goodTasks.push(t);
      } catch (err: any) {
        const errMsg = err?.message || String(err);
        if (isFileAlreadyExistsError(errMsg)) {
          logFn('info', `文件已存在，跳过：${t.fileName}`);
          t.gid = `skip-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          t.status = AriaStatus.Complete;
          t.completeSize = 1;
          t.totalSize = 1;
          t.error = '';
          t.updatedAt = Date.now();
          skipTasks.push(t);
        } else {
          logFn('error', `添加下载失败: ${errMsg}`);
        }
      }
    }

    if (goodTasks.length > 0) {
      const statusMap = await aria2.tellStatus(goodTasks.map((t) => t.gid));
      goodTasks.forEach((t) => {
        t.status = statusMap[t.gid].status;
      });
    }

    if (thumbTasks.length) {
      for (const tt of thumbTasks) {
        aria2
          .invoke(
            'aria2.addUri',
            [tt.url],
            buildAddUriOptions(tt.dir, tt.fileName),
          )
          .catch((e) => {
            const msg = e?.message || String(e);
            if (!isFileAlreadyExistsError(msg)) {
              logFn('warn', `封面图下载任务发送失败: ${msg}`);
            }
          });
      }
    }

    set({
      downloadTasks: get().downloadTasks.concat(goodTasks).concat(skipTasks),
    });
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
    if (!gid.startsWith('skip-')) {
      aria2
        .invoke('aria2.remove', gid)
        .catch((e) => logFn('warn', 'remove fail', e));
    }
    const s = get();
    set({
      downloadTasks: s.downloadTasks.filter((v) => v.gid !== gid),
      autoSyncTaskIds: s.autoSyncTaskIds.filter((v) => v !== gid),
    });
  },
  batchRemoveDownloadTasks: async (gids) => {
    const realGids = gids.filter((g) => !g.startsWith('skip-'));
    if (realGids.length > 0) {
      aria2
        .batchInvoke(
          realGids.map((g) => ({ methodName: 'aria2.remove', params: [g] })),
        )
        .catch((e) => logFn('error', realGids, e));
    }
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
    if (gid.startsWith('skip-')) return;

    const { downloadTasks, updateDownloadTask, removeDownloadTask } = get();
    const task = downloadTasks.find((v) => v.gid === gid);
    if (!task) return;
    const now = Date.now();
    const status = await aria2.tellStatus(gid);

    if (status.status === 'error') {
      const errMsg = status.errorMessage || '';
      if (isFileAlreadyExistsError(errMsg, status.errorCode)) {
        logFn('info', `文件已存在，跳过：${task.fileName}`);
        updateDownloadTask(
          {
            ...task,
            status: AriaStatus.Complete,
            completeSize: 1,
            totalSize: 1,
            error: '',
            updatedAt: now,
          },
          now,
        );
        return;
      }

      if (task.ariaRetryCountRemains > 0) {
        logFn(
          'warn',
          `重试下载 ${task.ariaRetryCountRemains} (剩余重试次数: ${task.ariaRetryCountRemains - 1})`,
        );
        let newGid: string;
        try {
          newGid = await aria2.invoke(
            'aria2.addUri',
            [task.downloadUrl],
            buildAddUriOptions(task.dir, task.fileName),
          );
        } catch (err: any) {
          const retryMsg = err?.message || String(err);
          if (isFileAlreadyExistsError(retryMsg)) {
            logFn('info', `重试时文件已存在，跳过：${task.fileName}`);
            updateDownloadTask(
              {
                ...task,
                status: AriaStatus.Complete,
                completeSize: 1,
                totalSize: 1,
                error: '',
                updatedAt: now,
              },
              now,
            );
            return;
          }
          logFn('error', `重试添加下载失败: ${retryMsg}`);
          const merged = await mergeAriaStatusToDownloadTask(status, task);
          updateDownloadTask(
            { ...merged, error: `重试失败: ${retryMsg}` },
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

// ================= 自动同步（优化：只查询视口内任务） =================
let syncTimerId: ReturnType<typeof setInterval> | null = null;

async function doAutoSync() {
  const state = useDownloadStore.getState();
  const ids = state.autoSyncTaskIds;
  if (!ids.length) return;
  const realIds = ids.filter((g) => !g.startsWith('skip-'));
  if (!realIds.length) return;

  try {
    const now = Date.now();
    const resultMap = await aria2.tellStatus(realIds);

    // ✅ 优化：只遍历 realIds 对应的任务，而不是整个 downloadTasks
    const taskMap = new Map(state.downloadTasks.map((t) => [t.gid, t]));
    const updated: DownloadTask[] = [];

    for (const gid of realIds) {
      const old = taskMap.get(gid);
      if (!old) continue;
      if (old.updatedAt > now) continue;

      const raw = resultMap[gid];
      if (!raw) continue;

      const merged = await mergeAriaStatusToDownloadTask(raw, old, now);

      if (
        merged.status !== old.status ||
        merged.completeSize !== old.completeSize ||
        merged.totalSize !== old.totalSize ||
        merged.error !== old.error
      ) {
        updated.push(merged);
      }
    }

    if (updated.length > 0) {
      useDownloadStore.getState().batchUpdateDownloadTasks(updated);
    }
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