import { useEffect } from 'react';
import { useResolvedProxyUrl } from '../useResolvedProxyUrl';
import { aria2, AriaStatus } from '../../utils/aria2';
import { useDownloadStore } from '../../stores/download';

// 识别因为休眠/断网引起的错误
function isNetworkError(msg: string = '') {
  const m = msg.toLowerCase();
  return (
    m.includes('timeout') ||
    m.includes('network') ||
    m.includes('connection') ||
    m.includes('reset') ||
    m.includes('eof') ||
    m.includes('10053') || // Windows 常见的网络强制断开错误码
    m.includes('disconnected')
  );
}

export function useAriaBinding() {
  const proxyUrl = useResolvedProxyUrl();

  useEffect(() => {
    aria2.updateProxy(proxyUrl).catch((err) => {
      if (typeof window !== 'undefined' && window.log?.category) {
        window.log.category('ARIA').warn('更新代理失败', err);
      }
    });
  }, [proxyUrl]);

  const syncDownloadTaskStatus = useDownloadStore((state) => state.syncDownloadTaskStatus);

  // 监听 Aria2 常规事件
  useEffect(() => {
    const pendingGids = new Set<string>();
    let timer: ReturnType<typeof setTimeout> | null = null;

    const flushPending = async () => {
      timer = null;
      const gids = Array.from(pendingGids);
      pendingGids.clear();
      if (gids.length === 0) return;
      for (const gid of gids) {
        try { await syncDownloadTaskStatus(gid); } catch (err) {}
      }
    };

    const onAria2StatusChanged = (gid: string) => {
      pendingGids.add(gid);
      if (timer === null) timer = setTimeout(flushPending, 100);
    };

    const unlistenComplete = aria2.onDownloadComplete.listen(onAria2StatusChanged);
    const unlistenError = aria2.onDownloadError.listen(onAria2StatusChanged);
    const unlistenPause = aria2.onDownloadPause.listen(onAria2StatusChanged);
    const unlistenStart = aria2.onDownloadStart.listen(onAria2StatusChanged);
    const unlistenStop = aria2.onDownloadStop.listen(onAria2StatusChanged);

    return () => {
      if (timer !== null) clearTimeout(timer);
      unlistenComplete();
      unlistenError();
      unlistenPause();
      unlistenStart();
      unlistenStop();
    };
  }, [syncDownloadTaskStatus]);

  // ✅ 新增：监听系统唤醒/窗口重新获得焦点
  useEffect(() => {
    const handleWakeUp = async () => {
      // 如果文档处于隐藏状态，忽略（主要是防止切换到其他标签页时触发）
      if (document.visibilityState === 'hidden') return;

      const state = useDownloadStore.getState();
      
      // 找出所有因为网络断开导致报错的任务
      const networkErrorTasks = state.downloadTasks.filter(
        (t) => t.status === AriaStatus.Error && isNetworkError(t.error)
      );

      if (networkErrorTasks.length === 0) return;

      window.log?.info(`[Aria] 检测到系统唤醒，正在自动恢复 ${networkErrorTasks.length} 个断网任务...`);

      // 批量发送 unpause 指令唤醒它们
      for (const t of networkErrorTasks) {
        try {
          await aria2.invoke('aria2.unpause', t.gid);
          // 稍微延迟一下，防止瞬间发送太多 RPC 导致拥堵
          await new Promise(r => setTimeout(r, 100)); 
        } catch (e) {
          // 如果 unpause 失败（比如 Aria 重启了找不到 gid），可能说明任务彻底死了，这里暂不做深度重试
        }
      }
      
      // 触发一次全局同步，刷新 UI 状态
      state.downloadTasks.forEach(t => {
        syncDownloadTaskStatus(t.gid).catch(() => {});
      });
    };

    // 监听窗口获得焦点和系统唤醒
    window.addEventListener('focus', handleWakeUp);
    document.addEventListener('visibilitychange', handleWakeUp);
    
    // 还可以监听 aria 自己的重连成功事件
    const unlistenReady = aria2.onReady.listen(handleWakeUp);

    return () => {
      window.removeEventListener('focus', handleWakeUp);
      document.removeEventListener('visibilitychange', handleWakeUp);
      unlistenReady();
    };
  }, [syncDownloadTaskStatus]);
}