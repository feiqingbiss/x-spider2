/* eslint-disable react/prop-types */
import { dialog } from '@tauri-apps/api';
import { Button } from 'antd';
import * as R from 'ramda';
import React, { useCallback, useMemo, useRef, useState, useDeferredValue, useTransition } from 'react';
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
  } = useDownloadStore((s) => ({
    downloadTasks: s.downloadTasks,
    pauseAllDownloadTask: s.pauseAllDownloadTask,
    unpauseAllDownloadTask: s.unpauseAllDownloadTask,
    batchRemoveDownloadTasks: s.batchRemoveDownloadTasks,
    batchRedownloadTask: s.batchRedownloadTask,
  }));
  const [listHeight, setListHeight] = useState(600);
  const listRef = useRef<HTMLDivElement>(null);

  const updateListHeight = useCallback(() => {
    if (!listRef.current) return;
    setListHeight(listRef.current?.clientHeight);
  }, []);

  useMount(() => {
    updateListHeight();
  });

  useEventListener('resize', updateListHeight);

  const filterTasks = useCallback(
    R.pipe<[DownloadTask[]], DownloadTask[], DownloadTask[]>(
      R.filter(filter),
      sort ? R.sort(sort) : R.identity,
    ),
    [sort, filter],
  );

  const tasks = useMemo(() => {
    return filterTasks(downloadTasks);
  }, [downloadTasks, filterTasks]);

  // 使用 useDeferredValue 让列表更新延后，避免阻塞主线程
  const deferredTasks = useDeferredValue(tasks);
  // 使用 useTransition 标记更新为低优先级
  const [isPending, startTransition] = useTransition();

  // 当任务数量变化时，用 transition 包裹更新（实际上 useDeferredValue 已经做了类似工作，但结合 useTransition 可以更明确）
  // 但我们直接使用 deferredTasks 即可

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
        {isPending && <span className="ml-2 text-gray-400">（更新中...）</span>}
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
          overscanCount={5} // 预渲染上下各5项，减少滚动时的空白
          onItemsRendered={({ visibleStartIndex, visibleStopIndex }) => {
            onInScreenTasksChanged?.(
              deferredTasks.slice(visibleStartIndex, visibleStopIndex),
            );
          }}
        >
          {({ index, style, data }) => (
            <div
              style={{
                ...style,
              }}
            >
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