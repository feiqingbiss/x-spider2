import { useEffect } from 'react';
import { useResolvedProxyUrl } from '../useResolvedProxyUrl';
import { aria2 } from '../../utils/aria2';
import { useDownloadStore } from '../../stores/download';

/**
 * Aria 和 Store 双向绑定
 * 组件卸载时正确解绑所有事件，避免后台事件污染其他页面
 */
export function useAriaBinding() {
  const proxyUrl = useResolvedProxyUrl();
  useEffect(() => {
    aria2.updateProxy(proxyUrl);
  }, [proxyUrl]);

  const syncDownloadTaskStatus = useDownloadStore((state) => state.syncDownloadTaskStatus);

  useEffect(() => {
    const onAria2StatusChanged = (gid: string) => {
      syncDownloadTaskStatus(gid);
    };

    // 绑定事件
    const unlistenComplete = aria2.onDownloadComplete.listen(onAria2StatusChanged);
    const unlistenError = aria2.onDownloadError.listen(onAria2StatusChanged);
    const unlistenPause = aria2.onDownloadPause.listen(onAria2StatusChanged);
    const unlistenStart = aria2.onDownloadStart.listen(onAria2StatusChanged);
    const unlistenStop = aria2.onDownloadStop.listen(onAria2StatusChanged);

    // 返回清理函数，组件卸载时解绑
    return () => {
      unlistenComplete();
      unlistenError();
      unlistenPause();
      unlistenStart();
      unlistenStop();
    };
  }, [syncDownloadTaskStatus]); // 确保 syncDownloadTaskStatus 引用稳定
}