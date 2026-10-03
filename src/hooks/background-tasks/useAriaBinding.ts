import { useEffect } from 'react';
import { useResolvedProxyUrl } from '../useResolvedProxyUrl';
import { aria2 } from '../../utils/aria2';
import { useDownloadStore } from '../../stores/download';

/**
 * Aria 和 Store 双向绑定
 * 组件卸载时正确解绑所有事件，避免后台事件污染其他页面
 * 
 * 优化点：
 * 1. updateProxy 增加了 catch 保护，避免未处理的 Promise rejection
 * 2. 事件监听增加了 100ms 微批处理，用 Set 去重，极大降低 IPC 请求频率
 * 3. 增加 try-catch 保护，单个任务同步失败不影响其他任务
 */
export function useAriaBinding() {
  const proxyUrl = useResolvedProxyUrl();

  useEffect(() => {
    // 增加 catch 保护，防止未处理的 Promise 错误
    aria2.updateProxy(proxyUrl).catch((err) => {
      if (typeof window !== 'undefined' && window.log?.category) {
        window.log.category('ARIA').warn('更新代理失败', err);
      }
    });
  }, [proxyUrl]);

  const syncDownloadTaskStatus = useDownloadStore(
    (state) => state.syncDownloadTaskStatus,
  );

  useEffect(() => {
    // 使用 Set 收集短时间内触发的 gid，避免同一 gid 频繁请求
    const pendingGids = new Set<string>();
    let timer: ReturnType<typeof setTimeout> | null = null;

    const flushPending = async () => {
      timer = null;
      const gids = Array.from(pendingGids);
      pendingGids.clear();

      if (gids.length === 0) return;

      // 顺序处理收集到的 gid，降低 aria2 压力
      for (const gid of gids) {
        try {
          await syncDownloadTaskStatus(gid);
        } catch (err) {
          // 忽略单个任务同步失败（例如任务已被移除）
          if (typeof window !== 'undefined' && window.log?.category) {
            window.log.category('ARIA').debug(`同步任务 ${gid} 状态失败`, err);
          }
        }
      }
    };

    const onAria2StatusChanged = (gid: string) => {
      pendingGids.add(gid);
      if (timer === null) {
        // 延迟 100ms 汇聚一批事件，减少 IPC 查询次数
        timer = setTimeout(flushPending, 100);
      }
    };

    // 绑定事件
    const unlistenComplete = aria2.onDownloadComplete.listen(onAria2StatusChanged);
    const unlistenError = aria2.onDownloadError.listen(onAria2StatusChanged);
    const unlistenPause = aria2.onDownloadPause.listen(onAria2StatusChanged);
    const unlistenStart = aria2.onDownloadStart.listen(onAria2StatusChanged);
    const unlistenStop = aria2.onDownloadStop.listen(onAria2StatusChanged);

    // 返回清理函数，组件卸载时解绑
    return () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      unlistenComplete();
      unlistenError();
      unlistenPause();
      unlistenStart();
      unlistenStop();
    };
  }, [syncDownloadTaskStatus]); // 确保 syncDownloadTaskStatus 引用稳定
}