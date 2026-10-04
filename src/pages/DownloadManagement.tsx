/* eslint-disable react/prop-types */
import React, { useEffect } from 'react';
import { fs, path } from '@tauri-apps/api';
import { PageHeader } from '../components/PageHeader';
import { Tabs } from '../components/download-management/Tabs';
import { TabDownloading } from '../components/download-management/TabDownloading';
import { TabError } from '../components/download-management/TabError';
import { TabComplete } from '../components/download-management/TabComplete';
import { AriaStatus } from '../utils/aria2';
import { useAppStateStore } from '../stores/app-state';
import { useSettingsStore } from '../stores/settings';
import { parseUsernames } from '../utils/homepage-helpers';

export const DownloadManagement: React.FC = () => {
  const saveDirBase = useSettingsStore((s) => s.download.saveDirBase);
  const setUserListTotal = useAppStateStore((s) => s.setUserListTotal);

  // ✅ 挂载时刷新名单总数，保证右环分母正确
  useEffect(() => {
    (async () => {
      try {
        const baseDir = saveDirBase || (await path.appDataDir());
        const filePath = await path.join(baseDir, 'search-user-name.txt');
        const content = await fs.readTextFile(filePath);
        const names = parseUsernames(content);
        setUserListTotal(names.length);
      } catch {
        setUserListTotal(0);
      }
    })();
  }, [saveDirBase, setUserListTotal]);

  return (
    <div className="flex flex-col h-screen overflow-hidden relative">
      <PageHeader />
      <div className="relative grow h-full overflow-hidden">
        <Tabs
          tabs={[
            {
              name: '下载中',
              children: <TabDownloading />,
              countStatus: [
                AriaStatus.Active,
                AriaStatus.Waiting,
                AriaStatus.Paused,
              ],
            },
            {
              name: '错误',
              children: <TabError />,
              countStatus: [AriaStatus.Error],
            },
            {
              name: '已完成',
              children: <TabComplete />,
              countStatus: [AriaStatus.Complete],
            },
          ]}
        />
      </div>
    </div>
  );
};