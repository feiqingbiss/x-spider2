/* eslint-disable react/prop-types */
import React, { useEffect, useMemo } from 'react';
import { Progress } from 'antd';
import { useShallow } from 'zustand/react/shallow';
import { useDownloadStore } from '../../stores/download';
import clsx from 'clsx';
import { AriaStatus } from '../../utils/aria2';
import * as R from 'ramda';
import { DownloadTask } from '../../interfaces/DownloadTask';
import { CreationTask } from '../../interfaces/CreationTask';

export interface Tab {
  name: string;
  children: React.ReactNode;
  countStatus: AriaStatus[];
}

export interface TabsProps {
  tabs: Tab[];
}

// ✅ 阶段文字
function phaseText(t: CreationTask): string {
  switch (t.phase) {
    case 'waiting':
      return '等待调度';
    case 'precheck':
      return '预检 · 拉取前 20 条';
    case 'index':
      return `媒体索引 · 已 ${t.indexedPosts ?? 0} 条`;
    case 'tweets':
      return `帖子索引 · 已 ${t.indexedPosts ?? 0} 条`;
    case 'creating':
      return '生成下载任务';
    case 'done':
      return '已完成';
    default:
      return '处理中...';
  }
}

// ✅ 根据阶段估算环状百分比（没有 batchProgress 时用）
function phasePercent(t: CreationTask): number {
  const idx = t.indexedPosts ?? 0;
  switch (t.phase) {
    case 'precheck':
      return 10;
    case 'index':
      // 20% ~ 55%
      return Math.round(20 + Math.min((idx / 100) * 35, 35));
    case 'tweets':
      // 60% ~ 85%
      return Math.round(60 + Math.min((idx / 100) * 25, 25));
    case 'creating':
      return 92;
    case 'done':
      return 100;
    default:
      return 5;
  }
}

export const Tabs: React.FC<TabsProps> = ({ tabs }) => {
  const {
    currentTab,
    setCurrentTab,
    downloadTasks,
    creationTasks,
    batchProgress,
  } = useDownloadStore(
    useShallow((s) => ({
      currentTab: s.currentTab,
      setCurrentTab: s.setCurrentTab,
      downloadTasks: s.downloadTasks,
      creationTasks: s.creationTasks,
      batchProgress: s.batchProgress,
    })),
  );

  useEffect(() => {
    if (!currentTab) {
      setCurrentTab(tabs[0].name);
    }
  }, [currentTab, tabs, setCurrentTab]);

  const currentTabChildren = tabs.find(
    (tab) => tab.name === currentTab,
  )?.children;

  // ✅ 统计各项数量
  const stats = useMemo(() => {
    const creating = creationTasks.length;
    const downloading = downloadTasks.filter((t) =>
      ['active', 'waiting', 'paused'].includes(t.status),
    ).length;
    const completed = downloadTasks.filter(
      (t) => t.status === 'complete',
    ).length;
    const errored = downloadTasks.filter(
      (t) => t.status === 'error',
    ).length;
    return { creating, downloading, completed, errored };
  }, [creationTasks.length, downloadTasks]);

  // ✅ 当前活跃的 creation 任务
  const activeCreation = useMemo(
    () => creationTasks.find((t) => t.status === 'active'),
    [creationTasks],
  );

  // ✅ 计算进度百分比与状态
  const { percent, strokeColor, progressStatus } = useMemo(() => {
    // 1. 有批量进度优先用它
    if (batchProgress && batchProgress.total > 0) {
      const p = Math.round(
        (batchProgress.completed / batchProgress.total) * 100,
      );
      return {
        percent: Math.max(0, Math.min(100, p)),
        strokeColor: '#1d9bf0',
        progressStatus: 'active' as const,
      };
    }
    // 2. 有活跃 creation 任务，根据阶段估算
    if (activeCreation) {
      return {
        percent: phasePercent(activeCreation),
        strokeColor: '#1d9bf0',
        progressStatus: 'active' as const,
      };
    }
    // 3. 空闲：用完成占比
    const denom = stats.downloading + stats.completed + stats.errored;
    const p = denom > 0 ? Math.round((stats.completed / denom) * 100) : 0;
    return {
      percent: p,
      strokeColor: stats.errored > 0 ? '#ff4d4f' : '#1d9bf0',
      progressStatus: 'normal' as const,
    };
  }, [batchProgress, activeCreation, stats]);

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between">
        <ul role="tablist" className="flex space-x-6">
          {tabs.map((tab) => (
            <li key={tab.name} className="w-">
              <div className="relative">
                {tab.name === currentTab && (
                  <div className="absolute w-full h-2 rounded-full bg-ant-color-primary left-0 bottom-0" />
                )}
                <button
                  aria-selected={tab.name === currentTab}
                  role="tab"
                  onClick={() => setCurrentTab(tab.name)}
                  className={clsx(
                    'bg-transparent text-xl relative transition-colors hover:text-ant-color-primary',
                    tab.name === currentTab && 'font-bold !text-black',
                  )}
                >
                  {tab.name}
                  <span>
                    (
                    {R.count<DownloadTask>((t) =>
                      tab.countStatus.includes(t.status),
                    )(downloadTasks)}
                    )
                  </span>
                </button>
              </div>
            </li>
          ))}
        </ul>

        {/* ✅ 右侧进度指示器 */}
        <div className="flex items-center gap-3 pr-2 select-none">
          <Progress
            type="circle"
            size={44}
            strokeWidth={10}
            percent={percent}
            strokeColor={strokeColor}
            status={progressStatus}
            format={(p) => (
              <span className="text-[10px] font-bold text-gray-700">
                {p}%
              </span>
            )}
          />
          <div className="text-[11px] text-gray-500 leading-snug min-w-[160px]">
            {batchProgress ? (
              <>
                <div className="text-gray-700 font-bold">
                  批量检索 {batchProgress.completed}/{batchProgress.total}
                </div>
                <div className="truncate max-w-[200px]">
                  当前：{batchProgress.currentUser || '...'}
                </div>
              </>
            ) : activeCreation ? (
              <>
                <div className="text-gray-700 font-bold truncate max-w-[200px]">
                  正在处理 @{activeCreation.user.screenName}
                </div>
                <div className="truncate max-w-[200px]">
                  {phaseText(activeCreation)}
                </div>
              </>
            ) : (
              <>
                <div>
                  <span className="text-blue-500 font-bold">
                    {stats.creating}
                  </span>{' '}
                  检索中
                  <span className="mx-1 text-gray-300">·</span>
                  <span className="text-orange-500 font-bold">
                    {stats.downloading}
                  </span>{' '}
                  下载中
                </div>
                <div>
                  <span className="text-green-600 font-bold">
                    {stats.completed}
                  </span>{' '}
                  已完成
                  {stats.errored > 0 && (
                    <>
                      <span className="mx-1 text-gray-300">·</span>
                      <span className="text-red-500 font-bold">
                        {stats.errored}
                      </span>{' '}
                      失败
                    </>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
      <div
        role="tabpanel"
        aria-label={currentTab}
        className="mt-4 grow relative overflow-hidden"
      >
        {currentTabChildren}
      </div>
    </div>
  );
};