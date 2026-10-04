import { App } from 'antd';
import { useCallback } from 'react';
import { fs, path } from '@tauri-apps/api';
import { useAppStateStore } from '../stores/app-state';
import { useDownloadStore } from '../stores/download';
import { drainInactiveUsers } from '../stores/download/creation';
import { useHomepageStore } from '../stores/homepage';
import { useSettingsStore } from '../stores/settings';
import { getUser } from '../twitter/api';
import { delay } from '../utils';
import {
  BATCH_DELAY_MS,
  BATCH_SIZE,
  FAILED_USERS_FILE,
  MAX_RETRIES,
  RETRY_DELAY_MS,
  RETRY_ROUNDS,
  ROUND_DELAY_MS,
  TIMEOUT_MS,
  WAIT_CREATION_TASKS_MAX_MS,
  isRateLimitError,
  shuffleArray,
  userFriendlyError,
  withTimeout,
} from '../utils/homepage-helpers';

export interface UseBatchDownloadOptions {
  /** 批量完成后回调，用于刷新名单数等 */
  onFinished?: () => Promise<void> | void;
}

/**
 * 封装"一键批量下载"的完整流程。
 *
 * ✅ 关键修复：isBatchRunning 和 AbortController 提升到 Zustand store，
 *    避免切换左侧菜单导致 Homepage 组件卸载后状态丢失。
 */
export function useBatchDownload(opts: UseBatchDownloadOptions = {}) {
  const { message, notification } = App.useApp();

  // ✅ 从 store 读取全局状态
  const isBatchRunning = useDownloadStore((s) => s.isBatchRunning);
  const setIsBatchRunning = useDownloadStore((s) => s.setIsBatchRunning);
  const setBatchAbortController = useDownloadStore(
    (s) => s.setBatchAbortController,
  );

  const batchProgress = useDownloadStore((s) => s.batchProgress);
  const setBatchProgress = useDownloadStore((s) => s.setBatchProgress);
  const saveDirBase = useSettingsStore((s) => s.download.saveDirBase);
  const cookieString = useAppStateStore((s) => s.cookieString);
  const filter = useHomepageStore((s) => s.filter);

  const getListFilePath = useCallback(async (): Promise<string> => {
    const baseDir = saveDirBase || (await path.appDataDir());
    return await path.join(baseDir, 'search-user-name.txt');
  }, [saveDirBase]);

  const processOneUser = useCallback(
    async (
      name: string,
      successCounter: { count: number },
      timeoutCounter: { count: number },
      signal: AbortSignal,
    ): Promise<boolean> => {
      const downloadStore = useDownloadStore.getState();
      const userLog = window.log.category('USER');

      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        if (signal.aborted) return false;

        try {
          const user = await withTimeout(getUser(name), TIMEOUT_MS);
          if (signal.aborted) return false;
          downloadStore.createCreationTask(user, filter);
          successCounter.count++;
          return true;
        } catch (err: any) {
          if (signal.aborted) return false;

          const errMsg = err?.message || String(err);
          userLog.warn(
            `用户 ${name} 加载失败 (尝试 ${attempt}/${MAX_RETRIES})`,
            { message: errMsg },
          );

          if (isRateLimitError(err)) {
            const waitMs = RETRY_DELAY_MS * attempt * 2;
            await delay(waitMs);
            continue;
          }

          if (attempt < MAX_RETRIES) {
            await delay(RETRY_DELAY_MS);
            continue;
          }

          if (errMsg.includes('超时')) {
            timeoutCounter.count++;
          }
          userLog.error(`用户 ${name} 最终失败`, {
            message: errMsg,
            friendly: userFriendlyError(err),
          });
        }
      }
      return false;
    },
    [filter],
  );

  const processBatch = useCallback(
    async (
      usernames: string[],
      successCounter: { count: number },
      timeoutCounter: { count: number },
      progressBase: number,
      progressTotal: number,
      signal: AbortSignal,
    ): Promise<string[]> => {
      const failed: string[] = [];

      for (let i = 0; i < usernames.length; i += BATCH_SIZE) {
        if (signal.aborted) break;

        const batch = usernames.slice(
          i,
          Math.min(i + BATCH_SIZE, usernames.length),
        );

        await Promise.all(
          batch.map(async (name, j) => {
            const index = i + j;
            setBatchProgress({
              total: progressTotal,
              completed: progressBase + index,
              currentUser: name,
            });

            const ok = await processOneUser(
              name,
              successCounter,
              timeoutCounter,
              signal,
            );
            if (!ok && !signal.aborted) failed.push(name);

            setBatchProgress({
              total: progressTotal,
              completed: progressBase + index + 1,
              currentUser: name,
            });
          }),
        );

        if (i + BATCH_SIZE < usernames.length) {
          await delay(BATCH_DELAY_MS);
        }
      }

      return failed;
    },
    [processOneUser, setBatchProgress],
  );

  const writeFailedUsersFile = useCallback(
    async (failed: string[]): Promise<void> => {
      if (!saveDirBase) {
        console.warn('未配置下载目录，跳过写入 failed_users.txt');
        return;
      }
      try {
        const filePath = await path.join(saveDirBase, FAILED_USERS_FILE);
        if (failed.length === 0) {
          try {
            if (await fs.exists(filePath)) {
              await fs.removeFile(filePath);
            }
          } catch (e) {
            console.warn('删除旧 failed_users.txt 失败', e);
          }
          return;
        }
        await fs.writeTextFile(filePath, failed.join('\n'));
        console.log(`已写入 ${failed.length} 个用户名到 ${filePath}`);
      } catch (err) {
        console.error('写入失败用户文件失败:', err);
      }
    },
    [saveDirBase],
  );

  const waitForCreationTasksDone = useCallback(async (): Promise<void> => {
    await delay(500);
    const startTs = Date.now();
    while (
      useDownloadStore.getState().creationTasks.length > 0 &&
      Date.now() - startTs < WAIT_CREATION_TASKS_MAX_MS
    ) {
      await delay(1000);
    }
  }, []);

  const cancelBatch = useCallback(() => {
    // ✅ 从 store 读取 AbortController
    const ctrl = useDownloadStore.getState().batchAbortController;
    if (ctrl) {
      ctrl.abort();
      message.info('正在取消批量下载...');
    }
  }, [message]);

  const batchDownload = useCallback(async () => {
    // ✅ 从 store 检查是否已在运行
    if (useDownloadStore.getState().isBatchRunning) {
      message.warning('已有批量任务正在运行，请耐心等待');
      return;
    }

    if (!cookieString) {
      message.error('请先登录');
      return;
    }

    try {
      const filePath = await getListFilePath();
      let content = '';
      try {
        content = await fs.readTextFile(filePath);
      } catch (e) {
        // ignore
      }
      let usernames = content
        .split('\n')
        .map((line) =>
          line
            .replace(/^https?:\/\/x\.com\/?/i, '')
            .replace(/^@/, '')
            .trim(),
        )
        .filter((n) => n.length > 0);

      if (usernames.length === 0) {
        message.warning('名单为空，请先添加用户');
        return;
      }

      usernames = shuffleArray(usernames);

      // ✅ 写入 store，切换路由也不丢失
      setIsBatchRunning(true);
      const ctrl = new AbortController();
      setBatchAbortController(ctrl);
      const signal = ctrl.signal;

      const total = usernames.length;
      setBatchProgress({
        total,
        completed: 0,
        currentUser: '',
      });

      const successCounter = { count: 0 };
      const timeoutCounter = { count: 0 };

      let pending = await processBatch(
        usernames,
        successCounter,
        timeoutCounter,
        0,
        total,
        signal,
      );

      for (
        let round = 1;
        round <= RETRY_ROUNDS && pending.length > 0 && !signal.aborted;
        round++
      ) {
        await delay(ROUND_DELAY_MS);
        if (signal.aborted) break;

        setBatchProgress({
          total,
          completed: total - pending.length,
          currentUser: `重试第 ${round} 轮`,
        });

        const stillFailed = await processBatch(
          pending,
          successCounter,
          timeoutCounter,
          total - pending.length,
          total,
          signal,
        );
        pending = stillFailed;
      }

      if (signal.aborted) {
        notification.info({
          message: '批量下载已取消',
          description: `已完成 ${successCounter.count} 个用户`,
          duration: 3,
          placement: 'topRight',
        });
        return;
      }

      setBatchProgress({
        total,
        completed: total,
        currentUser: '等待任务收尾...',
      });
      await waitForCreationTasksDone();

      await opts.onFinished?.();

      const inactiveUsers = drainInactiveUsers();
      const finalList = Array.from(new Set([...pending, ...inactiveUsers]));
      await writeFailedUsersFile(finalList);

      const extras: string[] = [];
      if (timeoutCounter.count > 0) {
        extras.push(`超时 ${timeoutCounter.count} 个`);
      }
      if (pending.length > 0) {
        extras.push(`失败 ${pending.length} 个`);
      }
      if (inactiveUsers.length > 0) {
        extras.push(`不活跃 ${inactiveUsers.length} 个`);
      }
      const extraMsg = extras.length > 0 ? `（${extras.join('，')}）` : '';

      if (finalList.length > 0) {
        notification.warning({
          message: '批量下载任务创建完成',
          description: `成功 ${successCounter.count}，${extraMsg}。名单已保存到 ${FAILED_USERS_FILE}`,
          duration: 6,
          placement: 'topRight',
        });
      } else {
        notification.success({
          message: '批量下载任务创建完成',
          description: `成功 ${successCounter.count}${extraMsg}`,
          duration: 4,
          placement: 'topRight',
        });
      }
    } catch (err: any) {
      const ctrl = useDownloadStore.getState().batchAbortController;
      if (ctrl?.signal.aborted) {
        return;
      }
      window.log.error('批量下载失败', err);
      message.error(`批量下载失败：${err?.message || '未知错误'}`);
    } finally {
      // ✅ 清理全局状态
      setBatchAbortController(null);
      setBatchProgress(null);
      setIsBatchRunning(false);
    }
  }, [
    cookieString,
    message,
    notification,
    getListFilePath,
    processBatch,
    waitForCreationTasksDone,
    writeFailedUsersFile,
    setBatchProgress,
    setIsBatchRunning,
    setBatchAbortController,
    opts,
  ]);

  return {
    isBatchRunning,
    batchProgress,
    batchDownload,
    cancelBatch,
  };
}