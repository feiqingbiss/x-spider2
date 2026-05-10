/* eslint-disable react/prop-types */
import { Avatar, Button, Input, Space, App, Card, Progress } from 'antd';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  HistoryOutlined, DownOutlined, UpOutlined,
  FileTextOutlined, SyncOutlined, CloudDownloadOutlined,
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

export const Homepage: React.FC = () => {
  const { message, notification } = App.useApp();
  const [historyVisible, setHistoryVisible] = useState(true);
  const [manageModalVisible, setManageModalVisible] = useState(false);
  const [userListCount, setUserListCount] = useState(0);
  const batchProgress = useDownloadStore(s => s.batchProgress);
  const setBatchProgress = useDownloadStore(s => s.setBatchProgress);

  const {
    keyword, setKeyword, userInfo, clearUser, loadUser, clearPostList: clearMediaList,
  } = useHomepageStore();

  const {
    searchHistory, addSearchHistory, clearSearchHistory, cookieString,
  } = useAppStateStore(s => ({
    searchHistory: s.searchHistory, addSearchHistory: s.addSearchHistory,
    clearSearchHistory: s.clearSearchHistory, cookieString: s.cookieString,
  }));

  const searchAbortControllerRef = useRef<AbortController>();
  const saveDirBase = useSettingsStore(s => s.download.saveDirBase);

  const getListFilePath = async () => {
    const baseDir = saveDirBase || await path.appDataDir();
    return await path.join(baseDir, 'search-user-name.txt');
  };

  const readUsernamesFromFile = async (): Promise<string[]> => {
    try {
      const filePath = await getListFilePath();
      const content = await fs.readTextFile(filePath);
      return content.split('\n')
        .map(l => l.replace(/^https?:\/\/x\.com\/?/i, '').replace(/^@/, '').trim())
        .filter(n => n.length > 0);
    } catch { return []; }
  };

  const fetchUserListCount = useCallback(async () => {
    const names = await readUsernamesFromFile();
    setUserListCount(names.length);
  }, [saveDirBase]);

  useEffect(() => { fetchUserListCount(); }, [fetchUserListCount]);

  const handleRefresh = async () => {
    await fetchUserListCount();
    message.success('已就绪数量已更新');
  };

  // 随机打乱数组
  const shuffleArray = <T,>(arr: T[]): T[] => {
    const shuffled = [...arr];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
  };

  const batchDownload = async () => {
    if (!cookieString) { message.error('请先登录'); return; }
    try {
      const filePath = await getListFilePath();
      let content = '';
      try { content = await fs.readTextFile(filePath); } catch (_) {}
      let usernames = content.split('\n')
        .map(l => l.replace(/^https?:\/\/x\.com\/?/i, '').replace(/^@/, '').trim())
        .filter(n => n.length > 0);
      if (usernames.length === 0) { message.warning('名单为空'); return; }

      // 随机打乱顺序
      usernames = shuffleArray(usernames);

      setBatchProgress({ total: usernames.length, completed: 0, currentUser: '' });
      const downloadStore = useDownloadStore.getState();
      const homepageFilter = useHomepageStore.getState().filter;
      let successCount = 0, failCount = 0, timeoutCount = 0;

      for (let i = 0; i < usernames.length; i++) {
        const name = usernames[i];
        setBatchProgress(prev => prev ? { ...prev, currentUser: name, completed: i } : null);
        try {
          const user = await withTimeout(getUser(name), TIMEOUT_MS);
          downloadStore.createCreationTask(user, homepageFilter);
          successCount++;
        } catch (err: any) {
          console.error(`获取用户 ${name} 失败:`, err);
          failCount++;
          if (err?.message?.includes('超时')) {
            timeoutCount++;
            notification.warning({ message: `用户 ${name} 请求超时，已暂时跳过` });
          } else if (isUserNotFoundError(err)) {
            await removeUserFromList(name);
            notification.warning({ message: `用户 ${name} 不存在，已自动移除` });
          } else {
            notification.warning({ message: `用户 ${name} 加载失败`, description: err?.message || '未知错误' });
          }
        }
        setBatchProgress(prev => prev ? { ...prev, completed: i + 1 } : null);
      }
      setBatchProgress(null);
      const extra = timeoutCount ? `，超时跳过 ${timeoutCount} 个` : '';
      message.success(`批量下载完成：成功 ${successCount}，失败 ${failCount}${extra}`);
    } catch (err) {
      console.error('批量下载出错:', err);
      setBatchProgress(null);
      message.error('批量下载发生未知错误');
    }
  };

  // 省略部分重复代码，请确保函数中已有的 withTimeout, isUserNotFoundError, removeUserFromList 等均在文件内
  // ... (请使用之前提供的完整 Homepage.tsx，确保包含上述缺失函数)
};