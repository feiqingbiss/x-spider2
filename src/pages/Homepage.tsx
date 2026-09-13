/* eslint-disable react/prop-types */
import { Avatar, Button, Input, Space, App, Card, Progress } from 'antd';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  HistoryOutlined,
  DownOutlined,
  UpOutlined,
  FileTextOutlined,
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
import { delay } from '../utils';

const TIMEOUT_MS = 60000;
const BATCH_SIZE = 2;
const BATCH_DELAY_MS = 2500;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 8000;
const ROUND_DELAY_MS = 30000;
const RETRY_ROUNDS = 2;

const shuffleArray = <T,>(arr: T[]): T[] => {
  const shuffled = [...arr];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
};

const withTimeout = <T,>(promise: Promise<T>, timeoutMs: number): Promise<T> => {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`请求超时（超过${timeoutMs / 1000}秒）`));
    }, timeoutMs);
    promise
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
};

const isRateLimitError = (err: any): boolean => {
  const msg = (err?.message || err?.toString() || '').toLowerCase();
  return (
    msg.includes('status=429') ||
    msg.includes('too many requests') ||
    msg.includes('rate limit')
  );
};

export const Homepage: React.FC = () => {
  const { message, notification } = App.useApp();
  const [historyVisible, setHistoryVisible] = useState(true);
  const [manageModalVisible, setManageModalVisible] = useState(false);
  const [userListCount, setUserListCount] = useState(0);
  const [isBatchRunning, setIsBatchRunning] = useState(false);

  const batchProgress = useDownloadStore((s) => s.batchProgress);
  const setBatchProgress = useDownloadStore((s) => s.setBatchProgress);

  const {
    keyword,
    setKeyword,
    userInfo,
    clearUser,
    loadUser,
    clearPostList: clearMediaList,
    filter,
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
    const baseDir = saveDirBase || (await path.appDataDir());
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
    const timer = setTimeout(() => {
      fetchUserListCount();
    }, 200);
    return () => clearTimeout(timer);
  }, [fetchUserListCount]);

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

  // 处理单个用户
  const processOneUser = async (
    name: string,
    successCounter: { count: number },
    timeoutCounter: { count: number },
  ): Promise<boolean> => {
    const downloadStore = useDownloadStore.getState();
    const userLog = window.log.category('USER');

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const user = await withTimeout(getUser(name), TIMEOUT_MS);
        downloadStore.createCreationTask(user, filter);
        successCounter.count++;
        return true;
      } catch (err: any) {
        const errMsg =
          err?.message ||
          (typeof err === 'string' ? err : '') ||
          (err?.name ? `${err.name}` : '') ||
          '未知错误';

        userLog.warn(
          `用户 ${name} 加载失败 (尝试 ${attempt}/${MAX_RETRIES})`,
          { message: errMsg, name: err?.name, stack: err?.stack },
        );

        if (isRateLimitError(err)) {
          const waitMs = RETRY_DELAY_MS * attempt * 2;
          notification.warning({
            message: `用户 ${name} 触发限流，等待 ${Math.round(waitMs / 1000)} 秒...`,
            description: errMsg,
          });
          await delay(waitMs);
          continue;
        }

        if (errMsg.includes('超时')) {
          if (attempt < MAX_RETRIES) {
            notification.warning({
              message: `用户 ${name} 请求超时 (尝试 ${attempt}/${MAX_RETRIES})，${RETRY_DELAY_MS / 1000}秒后重试...`,
              description: errMsg,
            });
            await delay(RETRY_DELAY_MS);
          } else {
            timeoutCounter.count++;
          }
        } else {
          if (attempt < MAX_RETRIES) {
            notification.warning({
              message: `用户 ${name} 加载失败 (尝试 ${attempt}/${MAX_RETRIES})，${RETRY_DELAY_MS / 1000}秒后重试...`,
              description: errMsg,
            });
            await delay(RETRY_DELAY_MS);
          } else {
            notification.warning({
              message: `用户 ${name} 加载失败，已跳过`,
              description: errMsg,
            });
          }
        }
      }
    }
    return false;
  };

  const processBatch = async (
    usernames: string[],
    successCounter: { count: number },
    timeoutCounter: { count: number },
    progressBase: number,
    progressTotal: number,
  ): Promise<string[]> => {
    const failed: string[] = [];

    for (let i = 0; i < usernames.length; i += BATCH_SIZE) {
      const batch = usernames.slice(
        i,
        Math.min(i + BATCH_SIZE, usernames.length),
      );

      await Promise.all(
        batch.map(async (name) => {
          const index = i + batch.indexOf(name);
          setBatchProgress({
            total: progressTotal,
            completed: progressBase + index,
            currentUser: name,
          });

          const ok = await processOneUser(name, successCounter, timeoutCounter);
          if (!ok) {
            failed.push(name);
          }

          setBatchProgress({
            total: progressTotal,
            completed: progressBase + index + 1,
            currentUser: name,
          });
        }),
      );

      if (i + BATCH_SIZE < usernames.length) {
        await delay(BATCH_DELAY_MS);
      }
    }

    return failed;
  };

  const writeFailedUsersFile = async (
    failed: string[],
  ): Promise<string | null> => {
    if (!saveDirBase) return null;
    try {
      const filePath = await path.join(saveDirBase, 'failed_users.txt');
      if (failed.length === 0) {
        try {
          if (await fs.exists(filePath)) {
            await fs.removeFile(filePath);
          }
        } catch (_) {}
        return null;
      }
      const content = failed.join('\n');
      await fs.writeTextFile(filePath, content);
      return filePath;
    } catch (err) {
      console.error('写入失败用户文件失败:', err);
      return null;
    }
  };

  const batchDownload = async () => {
    if (isBatchRunning) {
      message.warning('已有批量任务正在运行，请耐心等待');
      return;
    }

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

      usernames = shuffleArray(usernames);

      setIsBatchRunning(true);
      const total = usernames.length;
      setBatchProgress({
        total,
        completed: 0,
        currentUser: '',
      });

      const successCounter = { count: 0 };
      const timeoutCounter = { count: 0 };

      let pending = await processBatch(
        usernames,
        successCounter,
        timeoutCounter,
        0,
        total,
      );

      for (let round = 1; round <= RETRY_ROUNDS && pending.length > 0; round++) {
        message.info(
          `第 ${round} 轮重试，剩余 ${pending.length} 个用户（${ROUND_DELAY_MS / 1000}秒后开始）`,
        );
        await delay(ROUND_DELAY_MS);

        setBatchProgress({
          total,
          completed: total - pending.length,
          currentUser: `重试第 ${round} 轮`,
        });

        const stillFailed = await processBatch(
          pending,
          successCounter,
          timeoutCounter,
          total - pending.length,
          total,
        );
        pending = stillFailed;
      }

      setBatchProgress(null);
      setIsBatchRunning(false);
      await fetchUserListCount();

      const failedFilePath = await writeFailedUsersFile(pending);

      const extras: string[] = [];
      if (timeoutCounter.count > 0)
        extras.push(`超时 ${timeoutCounter.count} 个`);
      if (pending.length > 0) {
        extras.push(`重试后仍失败 ${pending.length} 个`);
      }
      const extraMsg = extras.length > 0 ? `（${extras.join('，')}）` : '';

      if (pending.length > 0) {
        message.warning(
          `批量下载完成：成功 ${successCounter.count}，失败 ${pending.length}${extraMsg}。失败用户已保存到 ${failedFilePath || '下载目录的 failed_users.txt'}。`,
        );
        console.warn('最终失败的用户（保留在名单中）:', pending);
      } else {
        message.success(
          `批量下载任务创建完成：成功 ${successCounter.count}${extraMsg}`,
        );
      }
    } catch (err) {
      console.error('批量下载出错:', err);
      setBatchProgress(null);
      setIsBatchRunning(false);
      message.error('批量下载发生未知错误');
    }
  };

  return (
    <div className="flex flex-col h-screen overflow-hidden bg-white">
      <PageHeader />

      <div className="shrink-0 px-4 pb-2">
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
                  <span className="text-[11px]">
                    搜索历史 ({searchHistory.length})
                  </span>
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

        <section className="mt-3">
          <Card
            size="small"
            className="bg-blue-50/20 border-blue-100/50 shadow-sm"
            bodyStyle={{ padding: '10px 16px' }}
          >
            <div className="flex items-center justify-between flex-wrap gap-y-2">
              <div className="flex items-center">
                <span className="text-gray-400 text-sm">名单用户：</span>
                <b className="text-lg text-blue-500 ml-1">{userListCount}</b>
              </div>

              <Space size="middle">
                <Button
                  icon={<FileTextOutlined />}
                  onClick={() => setManageModalVisible(true)}
                >
                  管理名单
                </Button>
                <Button
                  type="primary"
                  danger
                  icon={<CloudDownloadOutlined />}
                  onClick={batchDownload}
                  disabled={!!batchProgress || isBatchRunning}
                  className="font-bold px-6"
                >
                  {isBatchRunning ? '批量下载中...' : '一键批量下载'}
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

      {userInfo.data && (
        <section className="relative grow overflow-auto border-t border-gray-100">
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