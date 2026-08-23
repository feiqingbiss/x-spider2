import { create } from 'zustand';
import * as R from 'ramda';
import { aria2, AriaStatus } from '../../utils/aria2';
import { DownloadTask } from '../../interfaces/DownloadTask';
import { notification } from '@tauri-apps/api';
import { notification as antNotification } from 'antd';
import { DownloadStore } from './types';
import { prepareDownloadTask, mergeAriaStatusToDownloadTask, logFn } from './utils';
import { creationTaskAbortControllerMap } from './creation';
import { delay } from '../../utils';
import { perf } from './performance';

export const useDownloadStore = create<DownloadStore>((set, get) => ({
  currentTab: '',
  setCurrentTab: (tab) => set({ currentTab: tab }),

  autoSyncTaskIds: [],
  setAutoSyncTaskIds: (ids) => set({ autoSyncTaskIds: ids }),

  downloadTasks: [],
  createDownloadTask: async (params) => {
    perf.mark('createDownload-start');
    const task = await prepareDownloadTask(params);
    const gid = await aria2.invoke('aria2.addUri', [task.downloadUrl], {
      dir: task.dir,
      out: task.fileName,
    });
    task.gid = gid;
    const status = await aria2.tellStatus(task.gid);
    task.status = status.status;
    set({ downloadTasks: get().downloadTasks.concat(task) });
    perf.measure('createDownload', 'createDownload-start', 'createDownload-end');
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
      // 检查 SSL/证书错误特殊处理
      const errorMsg = status.errorMessage || '';
      const isSslError = errorMsg.includes('SSL') || errorMsg.includes('证书') || errorMsg.includes('certificate');

      if (task.ariaRetryCountRemains > 0) {
        logFn('warn', `重试下载 ${task.ariaRetryCountRemains} (剩余重试次数: ${task.ariaRetryCountRemains - 1})`);

        // 优化：不删除任务，直接重新添加下载，并复用原有任务信息
        let newGid: string;
        try {
          newGid = await aria2.invoke('aria2.addUri', [task.downloadUrl], {
            dir: task.dir,
            out: task.fileName,
            // 对 SSL 错误，添加额外参数跳过证书验证（aria2 已配置 --check-certificate=false）
            // 但这里无需额外处理，aria2 启动时已配置
          });
        } catch (err: any) {
          logFn('error', `重试添加下载失败: ${err.message}`);
          // 如果添加失败，移除任务并标记为错误
          const merged = await mergeAriaStatusToDownloadTask(status, task);
          updateDownloadTask({ ...merged, error: `重试失败: ${err.message}` }, now);
          return;
        }

        // 创建新任务（复用原有信息，更新 gid 和重试次数）
        const newTask: DownloadTask = {
          ...task,
          gid: newGid,
          status: AriaStatus.Waiting,
          ariaRetryCountRemains: task.ariaRetryCountRemains - 1,
          updatedAt: now,
        };

        // 移除旧任务，添加新任务
        await removeDownloadTask(gid);
        set({ downloadTasks: get().downloadTasks.concat(newTask) });
        logFn('info', `重试成功，新任务 gid: ${newGid}`);

        // 立即获取新任务状态
        try {
          const newStatus = await aria2.tellStatus(newGid);
          if (newStatus.status !== 'error') {
            updateDownloadTask(await mergeAriaStatusToDownloadTask(newStatus, newTask), now);
          }
        } catch (e) {
          // ignore
        }
      } else {
        // 最终失败
        const merged = await mergeAriaStatusToDownloadTask(status, task);
        logFn('error', '下载失败（重试耗尽）', merged);
        antNotification.error({
          message: `下载失败: ${merged.fileName}`,
          description: isSslError ? 'SSL/证书错误，请检查网络代理或证书设置' : (merged.error || '未知错误'),
          duration: 5,
        });
        notification.sendNotification({
          title: '下载失败',
          body: `${merged.fileName} - ${isSslError ? 'SSL/证书错误' : (merged.error || '未知错误')}`,
        });
        updateDownloadTask(merged, now);
      }
    } else {
      // 正常状态更新
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

// ================= 自动同步（优化版，间隔3秒） =================
(async function autoSync() {
  while (true) {
    await delay(3000);
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
          const merged = await mergeAriaStatusToDownloadTask(resultMap[old.gid], old, now);
          if (
            merged.status === old.status &&
            merged.completeSize === old.completeSize &&
            merged.totalSize === old.totalSize &&
            merged.error === old.error
          ) {
            return old;
          }
          return merged;
        })
      );
      batchUpdateDownloadTasks(updated);
    } catch (e) {
      logFn('error', 'sync error', e);
    }
  }
})();