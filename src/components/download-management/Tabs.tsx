/* eslint-disable react/prop-types */
import React, { useEffect, useMemo, useState } from 'react';
import { Progress } from 'antd';
import { useShallow } from 'zustand/react/shallow';
import { useDownloadStore } from '../../stores/download';
import clsx from 'clsx';
import { AriaStatus } from '../../utils/aria2';
import { CreationPhase, CreationTask } from '../../interfaces/CreationTask';

export interface Tab {
  name: string;
  children: React.ReactNode;
  countStatus: AriaStatus[];
}

export interface TabsProps {
  tabs: Tab[];
}

const RING_SIZE = 44;
const RING_STROKE = 10;

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

/**
 * 左环的百分比：基于"经过了多少 tick"来推演视觉进度。
 * 每 tick = 200ms，不同阶段对应不同上限。
 * 目的是给用户"正在工作"的视觉反馈，即使真实进度无法精确获知。
 */
function getPhasePercent(
  phase: CreationPhase | undefined,
  tick: number,
): number {
  switch (phase) {
    case 'waiting':
      return 0;
    case 'precheck':
      // 3 秒内到 10%
      return Math.min(10, Math.round(tick * 0.7));
    case 'index':
      // 8 秒内从 10% 到 50%
      return Math.min(50, Math.round(10 + tick * 1));
    case 'tweets':
      // 8 秒内从 50% 到 90%
      return Math.min(90, Math.round(50 + tick * 1));
    case 'creating':
      // 3 秒内从 90% 到 95%
      return Math.min(95, Math.round(90 + tick * 0.4));
    case 'done':
      return 100;
    default:
      return 0;
  }
}

export const Tabs: React.FC<TabsProps> = ({ tabs }) => {
  const tabNames = useMemo(() => tabs.map((t) => t.name), [tabs]);
  const tabCountStatusMap = useMemo(() => {
    const map: Record<string, AriaStatus[]> = {};
    tabs.forEach((t) => {
      map[t.name] = t.countStatus;
    });
    return map;
  }, [tabs]);

  const {
    currentTab,
    setCurrentTab,
    creationTasks,
    batchProgress,
    tabCounts,
    userProgress,
    activeCreation,
  } = useDownloadStore(
    useShallow((s) => {
      const counts: Record<string, number> = {};
      for (const name of tabNames) {
        const countStatus = tabCountStatusMap[name] || [];
        counts[name] = s.downloadTasks.filter((t) =>
          countStatus.includes(t.status),
        ).length;
      }

      // 按用户聚合：一个用户的所有任务都是 complete/error 时才算该用户完成
      const userMap = new Map<string, { total: number; done: number }>();
      for (const t of s.downloadTasks) {
        const u = t.post.user?.screenName || '__unknown__';
        let e = userMap.get(u);
        if (!e) {
          e = { total: 0, done: 0 };
          userMap.set(u, e);
        }
        e.total++;
        if (t.status === 'complete' || t.status === 'error') {
          e.done++;
        }
      }
      let totalUsers = 0;
      let doneUsers = 0;
      for (const [, e] of userMap) {
        totalUsers++;
        if (e.total > 0 && e.done >= e.total) doneUsers++;
      }

      const active = s.creationTasks.find((t) => t.status === 'active');

      return {
        currentTab: s.currentTab,
        setCurrentTab: s.setCurrentTab,
        creationTasks: s.creationTasks,
        batchProgress: s.batchProgress,
        tabCounts: counts,
        userProgress: { totalUsers, doneUsers },
        activeCreation: active,
      };
    }),
  );

  useEffect(() => {
    if (!currentTab) {
      setCurrentTab(tabs[0].name);
    }
  }, [currentTab, tabs, setCurrentTab]);

  const currentTabChildren = tabs.find(
    (tab) => tab.name === currentTab,
  )?.children;

  // ============ 左环：预检/索引的时间驱动进度 ============
  const [leftTick, setLeftTick] = useState(0);

  useEffect(() => {
    if (!activeCreation) {
      setLeftTick(0);
      return;
    }
    setLeftTick(0);
    const timer = setInterval(() => {
      setLeftTick((t) => t + 1);
    }, 200);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeCreation?.id, activeCreation?.phase]);

  const leftRing = useMemo(() => {
    if (activeCreation) {
      const percent = getPhasePercent(activeCreation.phase, leftTick);
      return {
        percent,
        strokeColor: '#722ed1',
        status: 'active' as const,
        label: '预检/索引',
        tooltip: phaseText(activeCreation),
      };
    }
    return {
      percent: 100,
      strokeColor: '#52c41a',
      status: 'normal' as const,
      label: '预检/索引',
      tooltip: '预检/索引 已完成',
    };
  }, [activeCreation, leftTick]);

  // ============ 中环：正在创建的任务数量 ============
  const creatingCount = creationTasks.length;
  const middleRing = useMemo(() => {
    return {
      count: creatingCount,
      strokeColor: creatingCount > 0 ? '#1d9bf0' : '#52c41a',
      status: (creatingCount > 0 ? 'active' : 'normal') as
        | 'active'
        | 'normal',
      label: '任务创建',
      tooltip:
        creatingCount > 0
          ? `正在创建 ${creatingCount} 个任务`
          : '暂无创建任务',
    };
  }, [creatingCount]);

  // ============ 右环：用户级别的下载完成进度 ============
  const rightRing = useMemo(() => {
    const { totalUsers, doneUsers } = userProgress;
    const percent =
      totalUsers > 0 ? Math.round((doneUsers / totalUsers) * 100) : 100;
    const isActive = totalUsers > 0 && doneUsers < totalUsers;
    return {
      percent,
      strokeColor: isActive ? '#1d9bf0' : '#52c41a',
      status: (isActive ? 'active' : 'normal') as 'active' | 'normal',
      label: '下载进度',
      tooltip:
        totalUsers > 0
          ? `${doneUsers} / ${totalUsers} 个用户完成`
          : '暂无下载任务',
    };
  }, [userProgress]);

  // ============ 右侧文字区 ============
  const textLine1 = useMemo(() => {
    if (activeCreation) {
      return `正在处理 @${activeCreation.user.screenName}`;
    }
    if (batchProgress && batchProgress.currentUser) {
      return `正在处理 @${batchProgress.currentUser}`;
    }
    return '';
  }, [activeCreation, batchProgress]);

  const textLine2 = useMemo(() => {
    if (activeCreation) {
      return phaseText(activeCreation);
    }
    if (batchProgress) {
      return `${batchProgress.completed} / ${batchProgress.total} 个用户已处理`;
    }
    return '';
  }, [activeCreation, batchProgress]);

  const showTextBlock = textLine1 || textLine2;

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

        {/* 三个圆环 */}
        <div className="flex items-center gap-3 shrink-0">
          {/* 左环：预检/索引（时间驱动动画） */}
          <div className="flex flex-col items-center" title={leftRing.tooltip}>
            <Progress
              type="circle"
              size={RING_SIZE}
              strokeWidth={RING_STROKE}
              percent={leftRing.percent}
              strokeColor={leftRing.strokeColor}
              status={leftRing.status}
              format={(p) => (
                <span className="text-[10px] font-bold text-gray-700">
                  {p}%
                </span>
              )}
            />
            <span className="text-[9px] text-gray-500 mt-0.5 leading-none">
              {leftRing.label}
            </span>
          </div>

          {/* 中环：创建任务数量 */}
          <div
            className="flex flex-col items-center"
            title={middleRing.tooltip}
          >
            <Progress
              type="circle"
              size={RING_SIZE}
              strokeWidth={RING_STROKE}
              percent={100}
              strokeColor={middleRing.strokeColor}
              status={middleRing.status}
              format={() => (
                <span className="text-[11px] font-bold text-gray-700">
                  {middleRing.count > 0 ? middleRing.count : ''}
                </span>
              )}
            />
            <span className="text-[9px] text-gray-500 mt-0.5 leading-none">
              {middleRing.label}
            </span>
          </div>

          {/* 右环：用户下载完成比例 */}
          <div className="flex flex-col items-center" title={rightRing.tooltip}>
            <Progress
              type="circle"
              size={RING_SIZE}
              strokeWidth={RING_STROKE}
              percent={rightRing.percent}
              strokeColor={rightRing.strokeColor}
              status={rightRing.status}
              format={(p) => (
                <span className="text-[10px] font-bold text-gray-700">
                  {p}%
                </span>
              )}
            />
            <span className="text-[9px] text-gray-500 mt-0.5 leading-none">
              {rightRing.label}
            </span>
          </div>
        </div>

        {/* 右侧文字区 */}
        {showTextBlock ? (
          <div className="flex-1 min-w-0">
            <div className="text-sm font-bold text-gray-800 truncate">
              {textLine1}
            </div>
            {textLine2 && (
              <div className="text-xs text-gray-500 truncate mt-0.5">
                {textLine2}
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