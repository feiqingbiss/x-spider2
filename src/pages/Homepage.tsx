/* eslint-disable react/prop-types */
import {
  Avatar,
  Button,
  Input,
  Space,
  App,
  Card,
  Progress,
  Switch,
  Tooltip,
} from 'antd';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  HistoryOutlined,
  DownOutlined,
  UpOutlined,
  FileTextOutlined,
  CloudDownloadOutlined,
  ThunderboltFilled,
  CloseCircleOutlined,
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
import { drainInactiveUsers } from '../stores/download/creation';
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

const WAIT_CREATION_TASKS_MAX_MS = 60000;

const FAILED_USERS_FILE = 'failed_users.txt';

const userFriendlyError = (err: any): string => {
  const msg = (err?.message || err?.toString() || '').toLowerCase();
  if (
    msg.includes('status=429') ||
    msg.includes('rate limit') ||
    msg.includes('too many requests')
  ) {
    return '请求过于频繁，请稍后再试';
  }
  if (msg.includes('status=404') || msg.includes('找不到该用户')) {
    return '用户不存在或访问受限';
  }
  if (msg.includes('超时') || msg.includes('timeout')) {
    return '网络请求超时';
  }
  if (
    msg.includes('tls handshake') ||
    msg.includes('error decoding response body') ||
    msg.includes('error sending request') ||
    msg.includes('network') ||
    msg.includes('eof') ||
    msg.includes('10053')
  ) {
    return '网络连接异常，请检查代理配置';
  }
  return '加载失败，请稍后重试';
};

const shuffleArray = <T,>(arr: T[]): T[] => {
  const shuffled = [...arr];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
};

const withTimeout = <T,>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> => {
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

  // ✅ H：批量取消控制
  const batchAbortRef = useRef<AbortController | null>(null);

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
    forceFullScan,
    setForceFullScan,
  } = useAppStateStore((s) => ({
    searchHistory: s.searchHistory,
    addSearchHistory: s.addSearchHistory,
    clearSearchHistory: s.clearSearchHistory,
    cookieString: s.cookieString,
    forceFullScan: s.forceFullScan,
    setForceFullScan: s.setForceFullScan,
  }));

  const searchTokenRef = useRef(0);
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

    const myToken = ++searchTokenRef.current;
    setKeyword(cleanedSn);
    clearUser();
    clearMediaList();

    try {
      await loadUser(cleanedSn);
      if (myToken !== searchTokenRef.current) return;
      addSearchHistory(cleanedSn);
    } catch (err: any) {
      if (myToken !== searchTokenRef.current) return;
      message.error('加载失败，请检查用户 ID 是否正确');
    }
  };

  // ✅ H：加 signal 支持取消
  const processOneUser = async (
    name: string,
    successCounter: { count: number },
    timeoutCounter: { count: number },
    signal: AbortSignal,
  ): Promise<boolean> => {
    const downloadStore = useDownloadStore.getState();
    const userLog = window.log.category('USER');

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      if (signal.aborted) return false;

      try {
        const user = await withTimeout(getUser(name), TIMEOUT_MS);
        if (signal.aborted) return false;
        downloadStore.createCreationTask(user, filter);
        successCounter.count++;
        return true;
      } catch (err: any) {
        if (signal.aborted) return false;

        const errMsg = err?.message || String(err);
        userLog.warn(`用户 ${name} 加载失败 (尝试 ${attempt}/${MAX_RETRIES})`, {
          message: errMsg,
        });

        if (isRateLimitError(err)) {
          // ✅ E：去掉了"请求过于频繁"弹窗提示
          const waitMs = RETRY_DELAY_MS * attempt * 2;
          await delay(waitMs);
          continue;
        }

        if (attempt < MAX_RETRIES) {
          await delay(RETRY_DELAY_MS);
          continue;
        }

        if (errMsg.includes('超时')) {
          timeoutCounter.count++;
        }
        userLog.error(`用户 ${name} 最终失败`, {
          message: errMsg,
          friendly: userFriendlyError(err),
        });
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
    signal: AbortSignal,
  ): Promise<string[]> => {
    const failed: string[] = [];

    for (let i = 0; i < usernames.length; i += BATCH_SIZE) {
      if (signal.aborted) break;

      const batch = usernames.slice(
        i,
        Math.min(i + BATCH_SIZE, usernames.length),
      );

      await Promise.all(
        batch.map(async (name, j) => {
          const index = i + j;
          setBatchProgress({
            total: progressTotal,
            completed: progressBase + index,
            currentUser: name,
          });

          const ok = await processOneUser(
            name,
            successCounter,
            timeoutCounter,
            signal,
          );
          if (!ok && !signal.aborted) failed.push(name);

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

  const writeFailedUsersFile = async (failed: string[]): Promise<void> => {
    if (!saveDirBase) {
      console.warn('未配置下载目录，跳过写入 failed_users.txt');
      return;
    }
    try {
      const filePath = await path.join(saveDirBase, FAILED_USERS_FILE);
      if (failed.length === 0) {
        try {
          if (await fs.exists(filePath)) {
            await fs.removeFile(filePath);
          }
        } catch (e) {
          console.warn('删除旧 failed_users.txt 失败', e);
        }
        return;
      }
      await fs.writeTextFile(filePath, failed.join('\n'));
      console.log(`已写入 ${failed.length} 个用户名到 ${filePath}`);
    } catch (err) {
      console.error('写入失败用户文件失败:', err);
    }
  };

  const waitForCreationTasksDone = async (): Promise<void> => {
    await delay(500);
    const startTs = Date.now();
    while (
      useDownloadStore.getState().creationTasks.length > 0 &&
      Date.now() - startTs < WAIT_CREATION_TASKS_MAX_MS
    ) {
      await delay(1000);
    }
  };

  // ✅ H：取消批量下载
  const cancelBatch = () => {
    if (batchAbortRef.current) {
      batchAbortRef.current.abort();
      message.info('正在取消批量下载...');
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
      const ctrl = new AbortController();
      batchAbortRef.current = ctrl;
      const signal = ctrl.signal;

      const total = usernames.length;
      setBatchProgress({
        total,
        completed: 0,
        currentUser: '',
      });

      const successCounter = { count: 0 };
      const timeoutCounter = { count: 0 };

      // ✅ E：去掉了"已开启完整遍历"的提示

      let pending = await processBatch(
        usernames,
        successCounter,
        timeoutCounter,
        0,
        total,
        signal,
      );

      for (
        let round = 1;
        round <= RETRY_ROUNDS && pending.length > 0 && !signal.aborted;
        round++
      ) {
        // ✅ E：去掉了"第 N 轮重试"的弹窗提示
        await delay(ROUND_DELAY_MS);
        if (signal.aborted) break;

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
          signal,
        );
        pending = stillFailed;
      }

      if (signal.aborted) {
        // 用户取消 → 只清理状态，不写文件、不弹汇总
        notification.info({
          message: '批量下载已取消',
          description: `已完成 ${successCounter.count} 个用户`,
          duration: 3,
          placement: 'topRight',
        });
        return;
      }

      setBatchProgress({
        total,
        completed: total,
        currentUser: '等待任务收尾...',
      });
      await waitForCreationTasksDone();

      await fetchUserListCount();

      const inactiveUsers = drainInactiveUsers();

      const finalList = Array.from(new Set([...pending, ...inactiveUsers]));
      await writeFailedUsersFile(finalList);

      const extras: string[] = [];
      if (timeoutCounter.count > 0) {
        extras.push(`超时 ${timeoutCounter.count} 个`);
      }
      if (pending.length > 0) {
        extras.push(`失败 ${pending.length} 个`);
      }
      if (inactiveUsers.length > 0) {
        extras.push(`不活跃 ${inactiveUsers.length} 个`);
      }
      const extraMsg = extras.length > 0 ? `（${extras.join('，')}）` : '';

      // ✅ E：只保留最终一次汇总弹窗
      if (finalList.length > 0) {
        notification.warning({
          message: '批量下载任务创建完成',
          description: `成功 ${successCounter.count}，${extraMsg}。名单已保存到 ${FAILED_USERS_FILE}`,
          duration: 6,
          placement: 'topRight',
        });
      } else {
        notification.success({
          message: '批量下载任务创建完成',
          description: `成功 ${successCounter.count}${extraMsg}`,
          duration: 4,
          placement: 'topRight',
        });
      }
    } catch (err: any) {
      if (batchAbortRef.current?.signal.aborted) {
        // 已取消，不报错
        return;
      }
      window.log.error('批量下载失败', err);
      message.error(`批量下载失败：${err?.message || '未知错误'}`);
    } finally {
      batchAbortRef.current = null;
      setBatchProgress(null);
      setIsBatchRunning(false);
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
              placeholder={
                cookieString ? '请输入用户 ID 或主页链接' : '请先登录'
              }
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

              <Space size="middle" align="center">
                <Button
                  icon={<FileTextOutlined />}
                  onClick={() => setManageModalVisible(true)}
                >
                  管理名单
                </Button>

                <Tooltip
                  title={
                    forceFullScan
                      ? '当前：完整遍历。将忽略预检结果，遍历用户所有历史帖子（速度较慢，但最全）'
                      : '当前：快速补全。前 20 条已下载 ≥ 15% 时仅补缺失；< 15% 时全量遍历'
                  }
                >
                  <div
                    className="flex items-center cursor-pointer select-none px-2"
                    onClick={() => setForceFullScan(!forceFullScan)}
                  >
                    <Switch
                      size="small"
                      checked={forceFullScan}
                      onChange={(v) => setForceFullScan(v)}
                    />
                    <span
                      className={
                        forceFullScan
                          ? 'ml-2 text-orange-500 font-bold text-xs'
                          : 'ml-2 text-gray-400 text-xs'
                      }
                    >
                      {forceFullScan ? (
                        <>
                          <ThunderboltFilled className="mr-1" />
                          完整遍历
                        </>
                      ) : (
                        '快速补全'
                      )}
                    </span>
                  </div>
                </Tooltip>

                {/* ✅ H：批量下载中显示"取消批量下载" */}
                <Button
                  type="primary"
                  danger
                  icon={
                    isBatchRunning ? (
                      <CloseCircleOutlined />
                    ) : (
                      <CloudDownloadOutlined />
                    )
                  }
                  onClick={isBatchRunning ? cancelBatch : batchDownload}
                  disabled={!isBatchRunning && !!batchProgress}
                  className="font-bold px-6"
                >
                  {isBatchRunning ? '取消批量下载' : '一键批量下载'}
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