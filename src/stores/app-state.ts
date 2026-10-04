import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { createTauriFileStorage } from './persist/tauri-file-storage';
import { normalizeUsername } from '../utils/homepage-helpers';

export interface AppStateStore {
  cookieString: string;
  setCookieString: (cookieString: string) => void;
  searchHistory: string[];
  addSearchHistory: (keyword: string) => void;
  clearSearchHistory: () => void;
  latestVersion: string;
  latestUrl: string;
  lastCheckUpdateTime: number;
  setLatestVersion: (version: string) => void;
  setLastCheckUpdateTime: (time: number) => void;
  setLatestUrl: (url: string) => void;
  forceFullScan: boolean;
  setForceFullScan: (v: boolean) => void;
  // ✅ 名单变更信号：任何对 search-user-name.txt 的写操作后 +1
  userListRevision: number;
  bumpUserListRevision: () => void;
  // ✅ 名单用户总数，用于下载管理的右环显示
  userListTotal: number;
  setUserListTotal: (n: number) => void;
}

export const useAppStateStore = create(
  persist<AppStateStore>(
    (set, get) => ({
      cookieString: '',
      setCookieString: (cookieString) => set({ cookieString }),
      searchHistory: [],

      addSearchHistory: (keyword) => {
        const targetKeyword = normalizeUsername(keyword);
        if (!targetKeyword) return;
        let history = [...get().searchHistory];
        const existsIndex = history.findIndex((v) => v === targetKeyword);
        if (existsIndex >= 0) history.splice(existsIndex, 1);
        history.unshift(targetKeyword);
        if (history.length > 10) history = history.slice(0, 10);
        set({ searchHistory: history });
      },

      clearSearchHistory: () => set({ searchHistory: [] }),

      latestVersion: PACKAGE_JSON_VERSION,
      lastCheckUpdateTime: 0,
      latestUrl: '',
      setLastCheckUpdateTime: (time) => set({ lastCheckUpdateTime: time }),
      setLatestVersion: (version) => set({ latestVersion: version }),
      setLatestUrl: (url) => set({ latestUrl: url }),
      forceFullScan: false,
      setForceFullScan: (v) => set({ forceFullScan: v }),

      userListRevision: 0,
      bumpUserListRevision: () =>
        set((s) => ({ userListRevision: s.userListRevision + 1 })),

      userListTotal: 0,
      setUserListTotal: (n) => set({ userListTotal: n }),
    }),
    {
      name: 'app-state',
      storage: createTauriFileStorage(),
      version: 2,
      migrate(state: any, version) {
        if (version < 2) {
          if (state) {
            delete state.systemProxyUrl;
            delete state.setSystemProxyUrl;
            delete state.taskCount;
          }
        }
        return state;
      },
    },
  ),
);