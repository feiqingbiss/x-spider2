import { App } from 'antd';
import { useCallback, useRef } from 'react';
import { useHomepageStore } from '../stores/homepage';
import { useAppStateStore } from '../stores/app-state';
import { cleanUsername } from '../utils/homepage-helpers';

/**
 * 封装"搜索用户"逻辑：
 * - 用递增 token 避免旧请求结果污染新搜索
 * - 成功后写入搜索历史
 */
export function useUserSearch() {
  const { message } = App.useApp();
  const searchTokenRef = useRef(0);

  const setKeyword = useHomepageStore((s) => s.setKeyword);
  const clearUser = useHomepageStore((s) => s.clearUser);
  const loadUser = useHomepageStore((s) => s.loadUser);
  const clearPostList = useHomepageStore((s) => s.clearPostList);
  const addSearchHistory = useAppStateStore((s) => s.addSearchHistory);

  const startSearch = useCallback(
    async (sn: string) => {
      const cleanedSn = cleanUsername(sn);
      if (!cleanedSn) return;

      const myToken = ++searchTokenRef.current;
      setKeyword(cleanedSn);
      clearUser();
      clearPostList();

      try {
        await loadUser(cleanedSn);
        if (myToken !== searchTokenRef.current) return;
        addSearchHistory(cleanedSn);
      } catch (err) {
        if (myToken !== searchTokenRef.current) return;
        message.error('加载失败，请检查用户 ID 是否正确');
      }
    },
    [setKeyword, clearUser, clearPostList, loadUser, addSearchHistory, message],
  );

  return { startSearch };
}