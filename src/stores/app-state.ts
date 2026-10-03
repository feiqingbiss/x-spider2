import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { createTauriFileStorage } from './persist/tauri-file-storage';
import { writeTextFile, readTextFile } from '@tauri-apps/api/fs';
import { appDataDir, join } from '@tauri-apps/api/path';
import { useSettingsStore } from './settings';

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
  // 强制完整遍历开关
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
    } catch (e) {}

    const existingNames = existingContent
      .split('\n')
      .map((line) => {
        let name = line.trim();
        name = name.replace(/^https?:\/\/x\.com\/?/i, '');
        name = name.replace(/^@/, '');
        return name.trim();
      })
      .filter((name) => name.length > 0);

    const combined = Array.from(new Set([...existingNames, ...names])).filter(
      (n) => n.length > 0,
    );
    let content = '';
    for (const name of combined) {
      content += `https://x.com/${name.trim()}\n`;
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
        const targetKeyword = keyword.toLowerCase().trim();
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
          const lines = content.split('\n');
          const importedNames: string[] = [];
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            let name = trimmed
              .replace(/^https?:\/\/x\.com\/?/i, '')
              .replace(/^@/, '')
              .trim();
            if (name) importedNames.push(name);
          }
          set({
            searchHistory: Array.from(new Set(importedNames)).slice(0, 10),
          });
        } catch (err) {}
      },
      latestVersion: PACKAGE_JSON_VERSION,
      lastCheckUpdateTime: 0,
      latestUrl: '',
      setLastCheckUpdateTime: (time) => set({ lastCheckUpdateTime: time }),
      setLatestVersion: (version) => set({ latestVersion: version }),
      setLatestUrl: (url) => set({ latestUrl: url }),
      // 强制完整遍历：默认 false
      forceFullScan: false,
      setForceFullScan: (v) => set({ forceFullScan: v }),
    }),
    {
      name: 'app-state',
      storage: createTauriFileStorage(),
      // ✅ 版本号 1 → 2
      version: 2,
      migrate(state: any, version) {
        // v1 → v2：删除 systemProxyUrl
        if (version < 2) {
          if (state) {
            delete state.systemProxyUrl;
            // 有些版本的残留字段也一起清掉
            delete state.setSystemProxyUrl;
            delete state.taskCount;
          }
        }
        return state;
      },
    },
  ),
);