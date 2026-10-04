/* eslint-disable react/prop-types */
import { App } from 'antd';
import React, { useCallback, useEffect, useState } from 'react';
import { fs, path } from '@tauri-apps/api';
import { PageHeader } from '../components/PageHeader';
import { PostListGridView } from '../components/homepage/PostListGridView';
import { DownloadController } from '../components/homepage/DownloadController';
import { UserListManager } from '../components/homepage/UserListManager';
import { SearchSection } from '../components/homepage/SearchSection';
import { BatchDownloadCard } from '../components/homepage/BatchDownloadCard';
import { UserInfoCard } from '../components/homepage/UserInfoCard';
import { useAppStateStore } from '../stores/app-state';
import { useHomepageStore } from '../stores/homepage';
import { useSettingsStore } from '../stores/settings';
import { useUserSearch } from '../hooks/useUserSearch';
import { useBatchDownload } from '../hooks/useBatchDownload';
import { parseUsernames } from '../utils/homepage-helpers';

export const Homepage: React.FC = () => {
  const { message } = App.useApp();
  const [manageModalVisible, setManageModalVisible] = useState(false);
  const [userListCount, setUserListCount] = useState(0);

  const keyword = useHomepageStore((s) => s.keyword);
  const setKeyword = useHomepageStore((s) => s.setKeyword);
  const userInfo = useHomepageStore((s) => s.userInfo);

  const searchHistory = useAppStateStore((s) => s.searchHistory);
  const clearSearchHistory = useAppStateStore((s) => s.clearSearchHistory);
  const cookieString = useAppStateStore((s) => s.cookieString);
  const forceFullScan = useAppStateStore((s) => s.forceFullScan);
  const setForceFullScan = useAppStateStore((s) => s.setForceFullScan);
  const userListRevision = useAppStateStore((s) => s.userListRevision);
  // ✅ 同步到全局，供下载管理页使用
  const setUserListTotal = useAppStateStore((s) => s.setUserListTotal);

  const saveDirBase = useSettingsStore((s) => s.download.saveDirBase);

  const readUsernamesFromFile = useCallback(async (): Promise<string[]> => {
    try {
      const baseDir = saveDirBase || (await path.appDataDir());
      const filePath = await path.join(baseDir, 'search-user-name.txt');
      const content = await fs.readTextFile(filePath);
      return parseUsernames(content);
    } catch {
      return [];
    }
  }, [saveDirBase]);

  const fetchUserListCount = useCallback(async () => {
    const names = await readUsernamesFromFile();
    setUserListCount(names.length);
    setUserListTotal(names.length);
  }, [readUsernamesFromFile, setUserListTotal]);

  useEffect(() => {
    const timer = setTimeout(() => {
      fetchUserListCount();
    }, 200);
    return () => clearTimeout(timer);
  }, [fetchUserListCount, userListRevision]);

  const { startSearch } = useUserSearch();
  const { isBatchRunning, batchProgress, batchDownload, cancelBatch } =
    useBatchDownload({ onFinished: fetchUserListCount });

  const handleSearch = useCallback(
    (sn: string) => {
      startSearch(sn).catch(() => {
        message.error('加载失败，请检查用户 ID 是否正确');
      });
    },
    [startSearch, message],
  );

  return (
    <div className="flex flex-col h-screen overflow-hidden bg-white">
      <PageHeader />

      <div className="shrink-0 px-4 pb-2">
        <SearchSection
          keyword={keyword}
          setKeyword={setKeyword}
          onSearch={handleSearch}
          loading={userInfo.loading}
          disabled={userInfo.loading || !cookieString}
          placeholder={cookieString ? '请输入用户 ID 或主页链接' : '请先登录'}
          searchHistory={searchHistory}
          onClearHistory={clearSearchHistory}
        />

        <BatchDownloadCard
          userListCount={userListCount}
          onManageList={() => setManageModalVisible(true)}
          forceFullScan={forceFullScan}
          onToggleForceFullScan={setForceFullScan}
          isBatchRunning={isBatchRunning}
          batchProgress={batchProgress}
          onBatchDownload={batchDownload}
          onCancelBatch={cancelBatch}
        />

        {userInfo.data && (
          <div className="mt-4">
            <DownloadController />
            <UserInfoCard user={userInfo.data} />
          </div>
        )}
      </div>

      {userInfo.data && (
        <section className="relative grow overflow-hidden border-t border-gray-100">
          <PostListGridView />
        </section>
      )}

      <UserListManager
        visible={manageModalVisible}
        onClose={() => setManageModalVisible(false)}
        onChanged={fetchUserListCount}
      />
    </div>
  );
};