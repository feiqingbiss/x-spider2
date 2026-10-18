/* eslint-disable react/prop-types */
import React, { useEffect, useMemo } from 'react';
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

const RING_SIZE = 64;
const RING_STROKE = 10;

function phaseText(t: CreationTask): string {
  switch (t.phase) {
    case 'waiting': return '等待调度';
    case 'precheck': return '预检 · 拉取前 20 条';
    case 'index': return `媒体索引 · 已 ${t.indexedPosts ?? 0} 条`;
    case 'tweets': return `帖子索引 · 已 ${t.indexedPosts ?? 0} 条`;
    case 'creating': return '生成下载任务';
    case 'done': return '已完成';
    default: return '处理中...';
  }
}

function getPhasePercent(phase: CreationPhase | undefined, indexedPosts: number = 0): number {
  switch (phase) {
    case 'waiting': return 0;
    case 'precheck': return 5;
    case 'index': {
      const base = 10;
      return Math.min(55, Math.round(base + (indexedPosts / 2000) * 45));
    }
    case 'tweets': {
      const base = 55;
      return Math.min(99, Math.round(base + (indexedPosts / 2000) * 44));
    }
    case 'creating': return 99;
    case 'done': return 100;
    default: return 0;
  }
}

export const Tabs: React.FC<TabsProps> = ({ tabs }) => {
  const {
    currentTab,
    setCurrentTab,
    creationTasks,
    batchProgress,
    downloadTasks,
    completedUsers,
    sessionUserNames,
  } = useDownloadStore(
    useShallow((s) => ({
      currentTab: s.currentTab,
      setCurrentTab: s.setCurrentTab,
      creationTasks: s.creationTasks,
      batchProgress: s.batchProgress,
      downloadTasks: s.downloadTasks,
      completedUsers: s.completedUsers,
      sessionUserNames: s.sessionUserNames,
    })),
  );

  useEffect(() => {
    if (!currentTab) setCurrentTab(tabs[0].name);
  }, [currentTab, tabs, setCurrentTab]);

  const currentTabChildren = tabs.find((t) => t.name === currentTab)?.children;

  // ============ 核心：在这里集中计算统计，但仅限于依赖项变化时 ============
  const stats = useMemo(() => {
    const counts: Record<string, number> = {};
    const creatingSet = new Set<string>();
    
    for (const t of creationTasks) {
      if (t.user?.screenName) creatingSet.add(t.user.screenName.toLowerCase());
    }

    const userMap = new Map<string, { total: number; done: number }>();
    let downloadingCount = 0;
    let completedCount = 0;
    let erroredCount = 0;

    for (const t of downloadTasks) {
      // Tab 计数
      tabs.forEach((tab) => {
        if (tab.countStatus.includes(t.status)) {
          counts[tab.name] = (counts[tab.name] || 0) + 1;
        }
      });

      // 状态计数
      if (['active', 'waiting', 'paused'].includes(t.status)) downloadingCount++;
      else if (t.status === 'complete') completedCount++;
      else if (t.status === 'error') erroredCount++;

      // 用户进度聚合
      const u = t.post.user?.screenName?.toLowerCase();
      if (u) {
        let e = userMap.get(u);
        if (!e) { e = { total: 0, done: 0 }; userMap.set(u, e); }
        e.total++;
        if (t.status === 'complete' || t.status === 'error') e.done++;
      }
    }

    const sessionSet = new Set(sessionUserNames.map((n) => n.toLowerCase()));
    const completedSet = new Set(completedUsers.map((n) => n.toLowerCase()));
    let doneUsersCount = 0;

    for (const name of sessionSet) {
      if (creatingSet.has(name)) continue;
      if (completedSet.has(name)) { doneUsersCount++; continue; }
      const e = userMap.get(name);
      if (e && e.total > 0 && e.done >= e.total) doneUsersCount++;
    }

    const activeCreation = creationTasks.find((t) => t.status === 'active');

    return {
      counts,
      downloadingCount,
      completedCount,
      erroredCount,
      doneUsers: doneUsersCount,
      activeCreation,
    };
  }, [downloadTasks, creationTasks, sessionUserNames, completedUsers, tabs]);

  const activeCreation = stats.activeCreation;
  
  // 左环
  const leftRing = useMemo(() => {
    if (activeCreation) {
      return {
        percent: getPhasePercent(activeCreation.phase, activeCreation.indexedPosts ?? 0),
        strokeColor: '#722ed1',
        status: 'active' as const,
        label: '预检/索引',
        tooltip: phaseText(activeCreation),
      };
    }
    return { percent: 100, strokeColor: '#52c41a', status: 'normal' as const, label: '预检/索引', tooltip: '预检/索引 已完成' };
  }, [activeCreation]);

  // 中环
  const creatingCount = creationTasks.length;
  const middleRing = useMemo(() => ({
    count: creatingCount,
    strokeColor: creatingCount > 0 ? '#1d9bf0' : '#52c41a',
    status: (creatingCount > 0 ? 'active' : 'normal') as 'active' | 'normal',
    label: '任务创建',
    tooltip: creatingCount > 0 ? `正在创建 ${creatingCount} 个任务` : '暂无创建任务',
  }), [creatingCount]);

  // 右环
  const sessionTotal = sessionUserNames.length;
  const rightRing = useMemo(() => {
    const total = sessionTotal;
    const done = stats.doneUsers;
    const percent = total > 0 ? Math.round((done / total) * 100) : 100;
    const isActive = total > 0 && done < total;
    return {
      percent, done, total,
      strokeColor: isActive ? '#1d9bf0' : '#52c41a',
      status: (isActive ? 'active' : 'normal') as 'active' | 'normal',
      label: '下载进度',
      tooltip: total > 0 ? `${done} / ${total} 个用户完成（${percent}%）` : '暂无下载任务',
    };
  }, [stats.doneUsers, sessionTotal]);

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-4 mb-3 flex-wrap">
        <ul role="tablist" className="flex gap-2 shrink-0">
          {tabs.map((tab) => {
            const active = tab.name === currentTab;
            const count = stats.counts[tab.name] || 0;
            return (
              <li key={tab.name}>
                <button
                  role="tab"
                  aria-selected={active}
                  onClick={() => setCurrentTab(tab.name)}
                  className={clsx(
                    'relative flex flex-col items-center px-5 py-2.5 rounded-md transition-all border min-w-[72px]',
                    active ? 'bg-white border-blue-200 shadow-sm' : 'bg-gray-50 border-gray-200 hover:bg-gray-100',
                  )}
                >
                  <span className={clsx('text-2xl font-bold leading-none', active ? 'text-ant-color-primary' : 'text-gray-700')}>{count}</span>
                  <span className={clsx('text-xs mt-1', active ? 'text-gray-700 font-medium' : 'text-gray-500')}>{tab.name}</span>
                  {active && <span className="absolute -bottom-[3px] left-2 right-2 h-[3px] bg-ant-color-primary rounded-full" />}
                </button>
              </li>
            );
          })}
        </ul>

        <div className="flex items-center gap-4 shrink-0">
          <div className="flex flex-col items-center" title={leftRing.tooltip}>
            <Progress type="circle" size={RING_SIZE} strokeWidth={RING_STROKE} percent={leftRing.percent} strokeColor={leftRing.strokeColor} status={leftRing.status} format={(p) => <span className="text-[12px] font-bold text-gray-700">{p}%</span>} />
            <span className="text-[10px] text-gray-500 mt-1 leading-none">{leftRing.label}</span>
          </div>
          <div className="flex flex-col items-center" title={middleRing.tooltip}>
            <Progress type="circle" size={RING_SIZE} strokeWidth={RING_STROKE} percent={100} strokeColor={middleRing.strokeColor} status={middleRing.status} format={() => <span className="text-[14px] font-bold text-gray-700">{middleRing.count > 0 ? middleRing.count : ''}</span>} />
            <span className="text-[10px] text-gray-500 mt-1 leading-none">{middleRing.label}</span>
          </div>
          <div className="flex flex-col items-center" title={rightRing.tooltip}>
            <Progress type="circle" size={RING_SIZE} strokeWidth={RING_STROKE} percent={rightRing.percent} strokeColor={rightRing.strokeColor} status={rightRing.status} format={() => <span className="text-[13px] font-bold text-gray-700 leading-none">{rightRing.total > 0 ? `${rightRing.done}/${rightRing.total}` : '—'}</span>} />
            <span className="text-[10px] text-gray-500 mt-1 leading-none">{rightRing.label}</span>
          </div>
        </div>
      </div>

      <div role="tabpanel" aria-label={currentTab} className="grow relative overflow-hidden">
        {currentTabChildren}
      </div>
    </div>
  );
};