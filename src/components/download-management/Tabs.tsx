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

function phasePercent(t: CreationTask): number {
  const idx = t.indexedPosts ?? 0;
  switch (t.phase) {
    case 'precheck':
      return 10;
    case 'index':
      return Math.round(20 + Math.min((idx / 100) * 35, 35));
    case 'tweets':
      return Math.round(60 + Math.min((idx / 100) * 25, 25));
    case 'creating':
      return 92;
    case 'done':
      return 100;
    default:
      return 5;
  }
}

type DashboardMode = 'idle' | 'batch' | 'creating' | 'downloading';

const RING_SIZE = 44;
const RING_STROKE = 10;

export const Tabs: React.FC<TabsProps> = ({ tabs }) => {
  const {
    currentTab,
    setCurrentTab,
    creationTasks,
    batchProgress,
    // ✅ 独立订阅计数，避免因 downloadTasks 数组引用变化触发重渲染
    downloadingCount,
    completedCount,
    erroredCount,
    tabCounts,
  } = useDownloadStore(
    useShallow((s) => {
      const downloading = s.downloadTasks.filter((t) =>
        ['active', 'waiting', 'paused'].includes(t.status),
      ).length;
      const completed = s.downloadTasks.filter((t) => t.status === 'complete').length;
      const errored = s.downloadTasks.filter((t) => t.status === 'error').length;

      // 提前计算好每个 tab 的计数，避免在渲染时遍历
      const counts: Record<string, number> = {};
      tabs.forEach((tab) => {
        counts[tab.name] = s.downloadTasks.filter((t) =>
          tab.countStatus.includes(t.status),
        ).length;
      });

      return {
        currentTab: s.currentTab,
        setCurrentTab: s.setCurrentTab,
        creationTasks: s.creationTasks,
        batchProgress: s.batchProgress,
        downloadingCount: downloading,
        completedCount: completed,
        erroredCount: errored,
        tabCounts: counts,
      };
    }),
  );

  useEffect(() => {
    if (!currentTab) {
      setCurrentTab(tabs[0].name);
    }
  }, [currentTab, tabs, setCurrentTab]);

  const currentTabChildren = tabs.find((tab) => tab.name === currentTab)?.children;

  const stats = useMemo(() => {
    return {
      creating: creationTasks.length,
      downloading: downloadingCount,
      completed: completedCount,
      errored: erroredCount,
    };
  }, [creationTasks.length, downloadingCount, completedCount, erroredCount]);

  const activeCreation = useMemo(
    () => creationTasks.find((t) => t.status === 'active'),
    [creationTasks],
  );

  const mode = useMemo<DashboardMode>(() => {
    if (batchProgress && batchProgress.total > 0) return 'batch';
    if (activeCreation) return 'creating';
    if (stats.downloading > 0) return 'downloading';
    return 'idle';
  }, [batchProgress, activeCreation, stats.downloading]);

  const dashboard = useMemo(() => {
    const hasError = stats.errored > 0;
    const errorColor = '#ff4d4f';
    const activeColor = '#1d9bf0';
    const successColor = '#52c41a';

    if (mode === 'batch' && batchProgress) {
      const p = Math.round((batchProgress.completed / batchProgress.total) * 100);
      return {
        percent: Math.max(0, Math.min(100, p)),
        strokeColor: hasError ? errorColor : activeColor,
        progressStatus: 'active' as const,
        line1: `正在处理 @${batchProgress.currentUser || '...'}`,
        line2: `${batchProgress.completed} / ${batchProgress.total} 个用户已处理`,
      };
    }

    if (mode === 'creating' && activeCreation) {
      return {
        percent: phasePercent(activeCreation),
        strokeColor: hasError ? errorColor : activeColor,
        progressStatus: 'active' as const,
        line1: `正在处理 @${activeCreation.user.screenName}`,
        line2: phaseText(activeCreation),
      };
    }

    if (mode === 'downloading') {
      const denom = stats.downloading + stats.completed + stats.errored;
      const p = denom > 0 ? Math.round((stats.completed / denom) * 100) : 0;
      return {
        percent: p,
        strokeColor: hasError ? errorColor : activeColor,
        progressStatus: 'active' as const,
        line1: '文件下载中',
        line2: `${stats.completed} / ${denom} 已完成`,
      };
    }

    const hasErrorIdle = stats.errored > 0;
    return {
      percent: 100,
      strokeColor: hasErrorIdle ? errorColor : successColor,
      progressStatus: 'normal' as const,
      line1: '',
      line2: hasErrorIdle ? `${stats.errored} 个任务失败` : '',
    };
  }, [mode, batchProgress, activeCreation, stats]);

  const phasePercentValue = activeCreation ? phasePercent(activeCreation) : 100;
  const phaseLabel = activeCreation ? phaseText(activeCreation) : '预检/索引 已完成';
  const phaseColor = activeCreation ? '#722ed1' : '#52c41a';
  const phaseStatus = activeCreation ? ('active' as const) : ('normal' as const);

  const showTextBlock = dashboard.line1 || dashboard.line2;

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-4 mb-3 flex-wrap">
        {/* Tab 卡片 */}
        <ul role="tablist" className="flex gap-2 shrink-0">
          {tabs.map((tab) => {
            const active = tab.name === currentTab;
            const count = tabCounts[tab.name] || 0;
            return (
              <li key={tab.name}>
                <button
                  role="tab"
                  aria-selected={active}
                  onClick={() => setCurrentTab(tab.name)}
                  className={clsx(
                    'relative flex flex-col items-center px-5 py-2.5 rounded-md transition-all border min-w-[72px]',
                    active
                      ? 'bg-white border-blue-200 shadow-sm'
                      : 'bg-gray-50 border-gray-200 hover:bg-gray-100',
                  )}
                >
                  <span
                    className={clsx(
                      'text-2xl font-bold leading-none',
                      active ? 'text-ant-color-primary' : 'text-gray-700',
                    )}
                  >
                    {count}
                  </span>
                  <span
                    className={clsx(
                      'text-xs mt-1',
                      active ? 'text-gray-700 font-medium' : 'text-gray-500',
                    )}
                  >
                    {tab.name}
                  </span>
                  {active && (
                    <span className="absolute -bottom-[3px] left-2 right-2 h-[3px] bg-ant-color-primary rounded-full" />
                  )}
                </button>
              </li>
            );
          })}
        </ul>

        {/* 两个圆环固定在 tab 卡片后面 */}
        <div className="flex items-center gap-3 shrink-0">
          <div className="flex flex-col items-center" title={phaseLabel}>
            <Progress
              type="circle"
              size={RING_SIZE}
              strokeWidth={RING_STROKE}
              percent={phasePercentValue}
              strokeColor={phaseColor}
              status={phaseStatus}
              format={(p) => (
                <span className="text-[10px] font-bold text-gray-700">{p}%</span>
              )}
            />
            <span className="text-[9px] text-gray-500 mt-0.5 leading-none">
              预检/索引
            </span>
          </div>
          <div className="flex flex-col items-center" title={dashboard.line2}>
            <Progress
              type="circle"
              size={RING_SIZE}
              strokeWidth={RING_STROKE}
              percent={dashboard.percent}
              strokeColor={dashboard.strokeColor}
              status={dashboard.progressStatus}
              format={(p) => (
                <span className="text-[10px] font-bold text-gray-700">{p}%</span>
              )}
            />
            <span className="text-[9px] text-gray-500 mt-0.5 leading-none">
              总进度
            </span>
          </div>
        </div>

        {/* 右侧文字描述 */}
        {showTextBlock ? (
          <div className="flex-1 min-w-0">
            <div className="text-sm font-bold text-gray-800 truncate">
              {dashboard.line1}
            </div>
            {dashboard.line2 && (
              <div className="text-xs text-gray-500 truncate mt-0.5">
                {dashboard.line2}
              </div>
            )}
          </div>
        ) : (
          <div className="flex-1 min-w-0" />
        )}
      </div>

      <div
        role="tabpanel"
        aria-label={currentTab}
        className="grow relative overflow-hidden"
      >
        {currentTabChildren}
      </div>
    </div>
  );
};