/* eslint-disable react/prop-types */
import { dialog } from '@tauri-apps/api';
import { Button } from 'antd';
import {
  PlayCircleOutlined,
  PauseCircleOutlined,
  RedoOutlined,
  DeleteOutlined,
} from '@ant-design/icons';
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

  const disabled = tasks.length === 0;

  return (
    <div className="flex flex-col grow h-full overflow-hidden pb-4">
      <CreationTasks />
      <section className="flex items-center gap-2">
        <span className="text-sm text-gray-500">
          共 <b className="text-gray-700">{tasks.length}</b> 个下载任务。
        </span>
      </section>

      {/* ✅ 批量操作按钮：带图标 + 彩色悬停 */}
      <ul className="flex flex-wrap gap-2 mt-3">
        {batchActions?.includes('unpauseAll') && (
          <li>
            <Button
              onClick={unpauseAll}
              disabled={disabled}
              icon={<PlayCircleOutlined />}
              className="!text-green-600 !border-green-300 hover:!bg-green-50 hover:!text-green-700 hover:!border-green-400"
            >
              全部开始
            </Button>
          </li>
        )}
        {batchActions?.includes('pauseAll') && (
          <li>
            <Button
              onClick={pauseAll}
              disabled={disabled}
              icon={<PauseCircleOutlined />}
              className="!text-orange-600 !border-orange-300 hover:!bg-orange-50 hover:!text-orange-700 hover:!border-orange-400"
            >
              全部暂停
            </Button>
          </li>
        )}
        {batchActions?.includes('redownloadAll') && (
          <li>
            <Button
              onClick={redownloadAll}
              disabled={disabled}
              icon={<RedoOutlined />}
              className="!text-blue-600 !border-blue-300 hover:!bg-blue-50 hover:!text-blue-700 hover:!border-blue-400"
            >
              全部重下
            </Button>
          </li>
        )}
        {batchActions?.includes('deleteAll') && (
          <li>
            <Button
              onClick={deleteAll}
              disabled={disabled}
              icon={<DeleteOutlined />}
              danger
              className="hover:!bg-red-50"
            >
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