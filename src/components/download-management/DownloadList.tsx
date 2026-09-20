/* eslint-disable react/prop-types */
import { dialog } from '@tauri-apps/api';
import { Button } from 'antd';
import * as R from 'ramda';
import React, {
  useCallback,
  useMemo,
  useRef,
  useState,
  useDeferredValue,
} from 'react';
import { useShallow } from 'zustand/react/shallow';
import { FixedSizeList } from 'react-window';
import { DownloadTask } from '../../interfaces/DownloadTask';
import { useDownloadStore } from '../../stores/download';
import { CreationTasks } from './CreationTasks';
import { DownloadListItem } from './DownloadListItem';
import { useEventListener, useMount } from 'ahooks';

export interface DownloadListProps {
  filter: (task: DownloadTask) => boolean;
  sort?: (taskA: DownloadTask, taskB: DownloadTask) => number;
  onInScreenTasksChanged?: (tasks: DownloadTask[]) => void;
  batchActions?: ('pauseAll' | 'unpauseAll' | 'deleteAll' | 'redownloadAll')[];
}
const ITEM_CLIENT_HEIGHT = 144;
const ITEM_GAP = 16;

// ✅ 新增：比较两个任务数组内容是否等价（按 gid + 关键字段）
function tasksEqual(a: DownloadTask[], b: DownloadTask[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (
      x.gid !== y.gid ||
      x.status !== y.status ||
      x.completeSize !== y.completeSize ||
      x.totalSize !== y.totalSize ||
      x.error !== y.error ||
      x.updatedAt !== y.updatedAt
    ) {
      return false;
    }
  }
  return true;
}

export const DownloadList: React.FC<DownloadListProps> = ({
  filter,
  sort,
  onInScreenTasksChanged,
  batchActions,
}) => {
  const {
    downloadTasks,
    pauseAllDownloadTask,
    unpauseAllDownloadTask,
    batchRemoveDownloadTasks,
    batchRedownloadTask,
  } = useDownloadStore(
    useShallow((s) => ({
      downloadTasks: s.downloadTasks,
      pauseAllDownloadTask: s.pauseAllDownloadTask,
      unpauseAllDownloadTask: s.unpauseAllDownloadTask,
      batchRemoveDownloadTasks: s.batchRemoveDownloadTasks,
      batchRedownloadTask: s.batchRedownloadTask,
    })),
  );
  const [listHeight, setListHeight] = useState(600);
  const listRef = useRef<HTMLDivElement>(null);

  // ✅ 新增：缓存上一帧的 tasks，内容一样就复用旧引用
  const lastTasksRef = useRef<DownloadTask[]>([]);

  const updateListHeight = useCallback(() => {
    if (!listRef.current) return;
    setListHeight(listRef.current?.clientHeight);
  }, []);

  useMount(() => {
    updateListHeight();
  });

  useEventListener('resize', updateListHeight);

  const filterTasks = useCallback(
    (tasks: DownloadTask[]) => {
      const filtered = R.filter(filter, tasks);
      return sort ? R.sort(sort, filtered) : filtered;
    },
    [sort, filter],
  );

  const tasks = useMemo(() => {
    const next = filterTasks(downloadTasks);
    // ✅ 如果内容和上一帧完全一样，复用旧引用
    if (tasksEqual(lastTasksRef.current, next)) {
      return lastTasksRef.current;
    }
    lastTasksRef.current = next;
    return next;
  }, [downloadTasks, filterTasks]);

  const deferredTasks = useDeferredValue(tasks);

  const pauseAll = async () => {
    await pauseAllDownloadTask();
  };

  const unpauseAll = async () => {
    await unpauseAllDownloadTask();
  };

  const deleteAll = async () => {
    if (
      await dialog.confirm('确认要删除所有任务？\n已下载的文件不会被删除。', {
        okLabel: '确认',
        cancelLabel: '取消',
        title: '警告',
      })
    ) {
      const tasks = filterTasks(useDownloadStore.getState().downloadTasks);
      await batchRemoveDownloadTasks(tasks.map((t) => t.gid));
    }
  };

  const redownloadAll = async () => {
    if (
      await dialog.confirm('确认要重新下载全部任务？', {
        okLabel: '确认',
        cancelLabel: '取消',
        title: '警告',
      })
    ) {
      const tasks = filterTasks(useDownloadStore.getState().downloadTasks);
      await batchRedownloadTask(tasks.map((t) => t.gid));
    }
  };

  return (
    <div className="flex flex-col grow h-full overflow-hidden pb-4">
      <CreationTasks />
      <section>
        <span>共 {tasks.length} 个下载任务。</span>
      </section>
      <ul className="flex space-x-2 mt-3">
        {batchActions?.includes('unpauseAll') && (
          <li>
            <Button onClick={unpauseAll} disabled={tasks.length === 0}>
              全部开始
            </Button>
          </li>
        )}
        {batchActions?.includes('pauseAll') && (
          <li>
            <Button onClick={pauseAll} disabled={tasks.length === 0}>
              全部暂停
            </Button>
          </li>
        )}
        {batchActions?.includes('redownloadAll') && (
          <li>
            <Button onClick={redownloadAll} disabled={tasks.length === 0}>
              全部重下
            </Button>
          </li>
        )}
        {batchActions?.includes('deleteAll') && (
          <li>
            <Button onClick={deleteAll} disabled={tasks.length === 0} danger>
              全部删除
            </Button>
          </li>
        )}
      </ul>
      <div
        role="list"
        className="grow pr-4 overflow-hidden relative h-full mt-4"
        ref={listRef}
      >
        <FixedSizeList
          height={listHeight}
          itemCount={deferredTasks.length}
          itemSize={ITEM_CLIENT_HEIGHT + ITEM_GAP}
          width={'100%'}
          itemData={deferredTasks}
          itemKey={(index, data) => data[index].gid}
          overscanCount={3}
          onItemsRendered={({ visibleStartIndex, visibleStopIndex }) => {
            onInScreenTasksChanged?.(
              deferredTasks.slice(visibleStartIndex, visibleStopIndex + 1),
            );
          }}
        >
          {({ index, style, data }) => (
            <div style={{ ...style }}>
              <DownloadListItem
                itemClientHeight={ITEM_CLIENT_HEIGHT}
                itemGap={ITEM_GAP}
                task={data[index]}
              />
            </div>
          )}
        </FixedSizeList>
      </div>
    </div>
  );
};