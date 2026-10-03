import { notification } from '@tauri-apps/api';
import { useUpdateEffect } from 'ahooks';
import { notification as antNotification } from 'antd';
import { useRef } from 'react';
import { useDownloadingItemCounts } from '../useDownloadingItemCounts';

export function useTaskNotifications() {
  const inQueueTasksCount = useDownloadingItemCounts();
  const hasHadTasksRef = useRef(false);

  useUpdateEffect(() => {
    // 只要曾经有过任务，就标记为 true
    if (inQueueTasksCount > 0) {
      hasHadTasksRef.current = true;
      return;
    }

    // 只有从“有任务”变为“0”时，才触发通知，避免初始状态或删除任务时误报
    if (inQueueTasksCount === 0 && hasHadTasksRef.current) {
      hasHadTasksRef.current = false;

      const msg = '任务下载完成';
      antNotification.success({
        message: msg,
      });
      notification.sendNotification({
        title: msg,
      });
    }
  }, [inQueueTasksCount]);
}