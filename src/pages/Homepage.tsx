/* eslint-disable react/prop-types */
import { Avatar, Button, Input, Space, App, Card, Progress } from 'antd';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  HistoryOutlined,
  DownOutlined,
  UpOutlined,
  FileTextOutlined,
  SyncOutlined,
  CloudDownloadOutlined,
} from '@ant-design/icons';
import { PageHeader } from '../components/PageHeader';
import { PostListGridView } from '../components/homepage/PostListGridView';
import { DownloadController } from '../components/homepage/DownloadController';
import { useAppStateStore } from '../stores/app-state';
import { useHomepageStore } from '../stores/homepage';
import { buildUserUrl } from '../twitter/url';
import { path, fs } from '@tauri-apps/api';
import { getUser } from '../twitter/api';
import { useDownloadStore } from '../stores/download';
import { UserListManager } from '../components/homepage/UserListManager';
import { useSettingsStore } from '../stores/settings';

const TIMEOUT_MS = 30000;

// 辅助函数：随机打乱数组
const shuffleArray = <T,>(arr: T[]): T[] => {
  const shuffled = [...arr];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
};

// 带超时的请求封装
const withTimeout = <T,>(promise: Promise<T>, timeoutMs: number): Promise<T> => {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`请求超时（超过${timeoutMs / 1000}秒）`));
    }, timeoutMs);
    promise.then((result) => { clearTimeout(timer); resolve(result); }).catch((err) => { clearTimeout(timer); reject(err); });
  });
};

// 判断错误是否为“用户不存在”
const isUserNotFoundError = (err: any): boolean => {
  const msg = (err?.message || err?.toString() || '').toLowerCase();
  return (
    msg.includes('找不到该用户') ||
    msg.includes('status=404') ||
    msg.includes('status=400') ||
    msg.includes('status=403')
  );
};

export const Homepage: React.FC = () => {
  const { message, notification } = App.useApp();
  const [historyVisible, setHistoryVisible] = useState(true);
  const [manageModalVisible, setManageModalVisible] = useState(false);
  const [userListCount, setUserListCount] = useState(0);

  const batchProgress = useDownloadStore((s) => s.batchProgress);
  const setBatchProgress = useDownloadStore((s) => s.setBatchProgress);

  const {
    keyword,
    setKeyword,
    userInfo,
    clearUser,
    loadUser,
    clearPostList: clearMediaList,
  } = useHomepageStore();

  const {
    searchHistory,
    addSearchHistory,
    clearSearchHistory,
    cookieString,
  } = useAppStateStore((s) => ({
    searchHistory: s.searchHistory,
    addSearchHistory: s.addSearchHistory,
    clearSearchHistory: s.clearSearchHistory,
    cookieString: s.cookieString,
  }));

  const searchAbortControllerRef = useRef<AbortController>();
  const saveDirBase = useSettingsStore((s) => s.download.saveDirBase);

  const getListFilePath = async (): Promise<string> => {
    const baseDir = saveDirBase || await path.appDataDir();
    return await path.join(baseDir, 'search-user-name.txt');
  };

  const readUsernamesFromFile = async (): Promise<string[]> => {
    try {
      const filePath = await getListFilePath();
      const content = await fs.readTextFile(filePath);
      return content
        .split('\n')
        .map((line) =>
          line
            .replace(/^https?:\/\/x\.com\/?/i, '')
            .replace(/^@/, '')
            .trim(),
        )
        .filter((n) => n.length > 0);
    } catch {
      return [];
    }
  };

  const fetchUserListCount = useCallback(async () => {
    const names = await readUsernamesFromFile();
    setUserListCount(names.length);
  }, [saveDirBase]);

  useEffect(() => {
    fetchUserListCount();
  }, [fetchUserListCount]);

  // 手动刷新：只更新数字，不影响搜索历史
  const handleRefresh = async () => {
    await fetchUserListCount();
    message.success('列表已刷新（搜索历史不变）');
  };

  // 更新 invalid_folders.txt
  const updateInvalidFolders = async () => {
    if (!saveDirBase) return;
    try {
      if (!(await fs.exists(saveDirBase))) return;

      const entries = await fs.readDir(saveDirBase);
      const folderNames = entries
        .filter((entry) => entry.children !== undefined)
        .map((entry) => entry.name)
        .filter((name): name is string => !!name && name !== 'undefined');

      const uniqueFolders = Array.from(new Set(folderNames));
      if (uniqueFolders.length === 0) return;

      const listUsernames = await readUsernamesFromFile();
      const usernameSet = new Set(listUsernames);

      const invalidFolders = uniqueFolders.filter(
        (folder) => !usernameSet.has(folder),
      );

      const outputPath = await path.join(saveDirBase, 'invalid_folders.txt');
      await fs.writeTextFile(outputPath, invalidFolders.join('\n'));
    } catch (err) {
      console.error('更新 invalid_folders.txt 失败', err);
    }
  };

  const cleanUsername = (input: string): string => {
    let text = input.trim();
    if (!text) return '';
    try {
      if (text.includes('x.com') || text.includes('twitter.com')) {
        const urlString = text.startsWith('http') ? text : `https://${text}`;
        const url = new URL(urlString);
        const pathParts = url.pathname.split('/').filter((p) => p.length > 0);
        if (pathParts.length > 0) return pathParts[0];
      }
      if (text.startsWith('@')) return text.substring(1);
    } catch (e) {
      console.error('识别用户名失败:', e);
    }
    return text;
  };

  const startSearch = async (sn: string) => {
    const cleanedSn = cleanUsername(sn);
    if (!cleanedSn) return;
    setKeyword(cleanedSn);
    if (searchAbortControllerRef.current) {
      searchAbortControllerRef.current.abort('Another search');
    }
    clearUser();
    clearMediaList();
    try {
      await loadUser(cleanedSn);
      addSearchHistory(cleanedSn);
    } catch (err: any) {
      message.error('加载失败，请检查用户 ID 是否正确');
    }
  };

  const homepageFilter = useHomepageStore((s) => s.filter);

  const removeUserFromList = async (username: string) => {
    try {
      const filePath = await getListFilePath();
      let content = '';
      try {
        content = await fs.readTextFile(filePath);
      } catch (e) {}
      const names = content
        .split('\n')
        .map((line) =>
          line
            .replace(/^https?:\/\/x\.com\/?/i, '')
            .replace(/^@/, '')
            .trim(),
        )
        .filter((n) => n.length > 0 && n !== username);
      const newContent = names.map((u) => `https://x.com/${u}`).join('\n');
      await fs.writeTextFile(filePath, newContent);
      await fetchUserListCount();
    } catch (err) {
      console.error('移除用户失败:', err);
    }
  };

  // 一键批量下载
  const batchDownload = async () => {
    if (!cookieString) {
      message.error('请先登录');
      return;
    }
    try {
      const filePath = await getListFilePath();
      let content = '';
      try {
        content = await fs.readTextFile(filePath);
      } catch (e) {}
      let usernames = content
        .split('\n')
        .map((line) =>
          line
            .replace(/^https?:\/\/x\.com\/?/i, '')
            .replace(/^@/, '')
            .trim(),
        )
        .filter((n) => n.length > 0);
      if (usernames.length === 0) {
        message.warning('名单为空，请先添加用户');
        return;
      }

      // 随机打乱
      usernames = shuffleArray(usernames);

      setBatchProgress({
        total: usernames.length,
        completed: 0,
        currentUser: '',
      });

      const downloadStore = useDownloadStore.getState();
      let successCount = 0;
      let failCount = 0;
      let timeoutCount = 0;

      for (let i = 0; i < usernames.length; i++) {
        const name = usernames[i];
        setBatchProgress({
          total: usernames.length,
          completed: i,
          currentUser: name,
        });
        try {
          const user = await withTimeout(getUser(name), TIMEOUT_MS);
          downloadStore.createCreationTask(user, homepageFilter);
          successCount++;
        } catch (err: any) {
          console.error(`获取用户 ${name} 失败:`, err);
          failCount++;
          if (err?.message?.includes('超时')) {
            timeoutCount++;
            notification.warning({
              message: `用户 ${name} 请求超时，已暂时跳过`,
              description: err.message,
            });
          } else if (isUserNotFoundError(err)) {
            await removeUserFromList(name);
            notification.warning({
              message: `用户 ${name} 不存在，已自动移除`,
            });
          } else {
            notification.warning({
              message: `用户 ${name} 加载失败`,
              description: err?.message || '未知错误',
            });
          }
        }
        setBatchProgress({
          total: usernames.length,
          completed: i + 1,
          currentUser: name,
        });
      }

      await updateInvalidFolders();

      setBatchProgress(null);
      const extraMsg = timeoutCount > 0 ? `，超时跳过 ${timeoutCount} 个` : '';
      message.success(
        `批量下载任务创建完成：成功 ${successCount}，失败 ${failCount}${extraMsg}`,
      );
    } catch (err) {
      console.error('批量下载出错:', err);
      setBatchProgress(null);
      message.error('批量下载发生未知错误');
      await updateInvalidFolders().catch(() => {});
    }
  };

  return (
    <div className="flex flex-col h-screen overflow-hidden bg-white">
      <PageHeader />

      <div className="shrink-0 px-4 pb-2">
        {/* 搜索区域 */}
        <section aria-label="搜索用户">
          <Space.Compact block>
            <Input
              disabled={userInfo.loading || !cookieString}
              onPressEnter={() => startSearch(keyword)}
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder={cookieString ? '请输入用户 ID 或主页链接' : '请先登录'}
              className="text-center"
            />
            <Button
              disabled={!keyword || !cookieString}
              loading={userInfo.loading}
              onClick={() => startSearch(keyword)}
              type="primary"
            >
              加载
            </Button>
          </Space.Compact>

          {searchHistory.length > 0 && (
            <div className="mt-1">
              <div className="flex items-center justify-between h-5">
                <Button
                  type="text"
                  size="small"
                  className="text-gray-400 !p-0 flex items-center"
                  onClick={() => setHistoryVisible(!historyVisible)}
                >
                  <HistoryOutlined className="mr-1 text-xs" />
                  <span className="text-[11px]">搜索历史 ({searchHistory.length})</span>
                  {historyVisible ? (
                    <UpOutlined className="ml-1 text-[9px]" />
                  ) : (
                    <DownOutlined className="ml-1 text-[9px]" />
                  )}
                </Button>
                {historyVisible && (
                  <Button
                    type="link"
                    size="small"
                    onClick={clearSearchHistory}
                    className="!p-0 text-[11px] text-gray-400/60 hover:text-red-400"
                  >
                    清空
                  </Button>
                )}
              </div>

              {historyVisible && (
                <div className="mt-1 overflow-x-auto scrollbar-hide bg-gray-50/50 p-1 rounded">
                  <div className="flex flex-nowrap gap-x-4 items-center min-w-max">
                    {searchHistory.map((sn) => (
                      <Button
                        key={sn}
                        type="link"
                        size="small"
                        className="!p-0 text-[12px] text-blue-400 hover:text-blue-600 whitespace-nowrap"
                        onClick={() => {
                          setKeyword(sn);
                          startSearch(sn);
                        }}
                      >
                        {sn}
                      </Button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </section>

        {/* 管理条 */}
        <section className="mt-3">
          <Card
            size="small"
            className="bg-blue-50/20 border-blue-100/50 shadow-sm"
            bodyStyle={{ padding: '10px 16px' }}
          >
            <div className="flex items-center justify-between">
              <div className="flex-1">
                <span className="text-gray-400 text-sm">已就绪：</span>
                <b className="text-lg text-blue-500 ml-1">{userListCount}</b>
              </div>

              <Space size="middle">
                <Button
                  icon={<FileTextOutlined />}
                  onClick={() => setManageModalVisible(true)}
                >
                  管理名单
                </Button>
                <Button icon={<SyncOutlined />} onClick={handleRefresh}>
                  刷新列表
                </Button>
                <Button
                  type="primary"
                  danger
                  icon={<CloudDownloadOutlined />}
                  onClick={batchDownload}
                  disabled={!!batchProgress}
                  className="font-bold px-6"
                >
                  一键批量下载
                </Button>
              </Space>
            </div>
            {batchProgress && (
              <div className="mt-3">
                <Progress
                  percent={Math.round(
                    (batchProgress.completed / batchProgress.total) * 100,
                  )}
                  format={() =>
                    `${batchProgress.completed}/${batchProgress.total}`
                  }
                  status="active"
                />
                <div className="text-xs text-gray-500 mt-1">
                  正在处理：{batchProgress.currentUser}
                </div>
              </div>
            )}
          </Card>
        </section>

        {/* 用户信息 & 下载配置 */}
        {userInfo.data && (
          <div className="mt-4">
            <DownloadController />
            <section
              aria-label="用户信息"
              className="bg-white border-[1px] border-gray-300 rounded-md mt-4 p-4"
            >
              <a
                className="flex items-center"
                href={
                  userInfo.data.screenName
                    ? buildUserUrl(userInfo.data.screenName)
                    : '#'
                }
                target="_blank"
                rel="noreferrer"
              >
                <Avatar src={userInfo.data.avatar} size={50} />
                <div className="ml-3">
                  <p className="text-base font-bold mb-0">
                    {userInfo.data.name || '未知用户'}
                    <span className="text-gray-400 font-normal ml-2 text-xs">
                      ({userInfo.data.mediaCount || 0} 媒体)
                    </span>
                  </p>
                  <p className="text-gray-400 text-sm">
                    @{userInfo.data.screenName}
                  </p>
                </div>
              </a>
            </section>
          </div>
        )}
      </div>

      {/* 图墙 */}
      {userInfo.data && (
        <section className="relative grow overflow-hidden bg-gray-50 border-t border-gray-100">
          <PostListGridView />
        </section>
      )}

      {/* 管理名单弹窗 */}
      <UserListManager
        visible={manageModalVisible}
        onClose={() => setManageModalVisible(false)}
        onChanged={fetchUserListCount}
      />
    </div>
  );
};