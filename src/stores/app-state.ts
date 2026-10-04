import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { createTauriFileStorage } from './persist/tauri-file-storage';
import { writeTextFile, readTextFile } from '@tauri-apps/api/fs';
import { appDataDir, join } from '@tauri-apps/api/path';
import { useSettingsStore } from './settings';
import { normalizeUsername, parseUsernames } from '../utils/homepage-helpers';

export interface AppStateStore {
  cookieString: string;
  setCookieString: (cookieString: string) => void;
  searchHistory: string[];
  addSearchHistory: (keyword: string) => void;
  clearSearchHistory: () => void;
  importHistoryFromFile: () => Promise<void>;
  latestVersion: string;
  latestUrl: string;
  lastCheckUpdateTime: number;
  setLatestVersion: (version: string) => void;
  setLastCheckUpdateTime: (time: number) => void;
  setLatestUrl: (url: string) => void;
  forceFullScan: boolean;
  setForceFullScan: (v: boolean) => void;
}

async function getListFilePath(): Promise<string> {
  const settings = useSettingsStore.getState();
  const baseDir = settings.download.saveDirBase || (await appDataDir());
  return await join(baseDir, 'search-user-name.txt');
}

const syncHistoryToFile = async (names: string[]) => {
  try {
    if (names.length === 0) return;
    const filePath = await getListFilePath();
    let existingContent = '';
    try {
      existingContent = await readTextFile(filePath);
    } catch (e) {
      // ignore
    }

    // ✅ 读取已有名单时归一化 + 去重
    const existingNames = parseUsernames(existingContent);
    const newNames = names
      .map((n) => normalizeUsername(n))
      .filter((n) => n.length > 0);
    const combined = Array.from(new Set([...existingNames, ...newNames]));

    let content = '';
    for (const name of combined) {
      content += `https://x.com/${name}\n`;
    }
    await writeTextFile(filePath, content.trim());
  } catch (err) {
    console.error('[Sync] Error:', err);
  }
};

export const useAppStateStore = create(
  persist<AppStateStore>(
    (set, get) => ({
      cookieString: '',
      setCookieString: (cookieString) => set({ cookieString }),
      searchHistory: [],
      addSearchHistory: (keyword) => {
        // ✅ 归一化为小写
        const targetKeyword = normalizeUsername(keyword);
        if (!targetKeyword) return;
        let history = [...get().searchHistory];
        const existsIndex = history.findIndex((v) => v === targetKeyword);
        if (existsIndex >= 0) history.splice(existsIndex, 1);
        history.unshift(targetKeyword);
        if (history.length > 10) history = history.slice(0, 10);
        set({ searchHistory: history });
        syncHistoryToFile([targetKeyword]);
      },
      clearSearchHistory: () => set({ searchHistory: [] }),
      importHistoryFromFile: async () => {
        try {
          const filePath = await getListFilePath();
          const content = await readTextFile(filePath);
          // ✅ 归一化 + 去重
          const importedNames = parseUsernames(content);
          set({
            searchHistory: importedNames.slice(0, 10),
          });
        } catch (err) {
          // ignore
        }
      },
      latestVersion: PACKAGE_JSON_VERSION,
      lastCheckUpdateTime: 0,
      latestUrl: '',
      setLastCheckUpdateTime: (time) => set({ lastCheckUpdateTime: time }),
      setLatestVersion: (version) => set({ latestVersion: version }),
      setLatestUrl: (url) => set({ latestUrl: url }),
      forceFullScan: false,
      setForceFullScan: (v) => set({ forceFullScan: v }),
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