import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { createTauriFileStorage } from './persist/tauri-file-storage';
import { writeTextFile, readTextFile } from '@tauri-apps/api/fs'; 
import { appDataDir, join } from '@tauri-apps/api/path';

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
  systemProxyUrl: string;
  setSystemProxyUrl: (url: string) => void;
}

const syncHistoryToFile = async (names: string[]) => {
  try {
    if (names.length === 0) return;
    const rootDir = await appDataDir();
    const filePath = await join(rootDir, 'search-user-name.txt');
    let existingContent = "";
    try { existingContent = await readTextFile(filePath); } catch (e) {}

    // 更健壮的解析：去掉可能的前缀，只保留用户名
    const existingNames = existingContent.split('\n')
      .map(line => {
        let name = line.trim();
        // 移除 http(s)://x.com/ 或 http(s)://x.com（无斜杠）
        name = name.replace(/^https?:\/\/x\.com\/?/i, '');
        // 移除开头的 @
        name = name.replace(/^@/, '');
        return name.trim();
      })
      .filter(name => name.length > 0);

    const combined = Array.from(new Set([...existingNames, ...names])).filter(n => n.length > 0);
    // 修复：统一使用 “https://x.com/用户名” 格式
    let content = "";
    for (const name of combined) {
      content += `https://x.com/${name.trim()}\n`;
    }
    await writeTextFile(filePath, content.trim());
  } catch (err) { console.error('[Sync] Error:', err); }
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
          const rootDir = await appDataDir();
          const filePath = await join(rootDir, 'search-user-name.txt');
          const content = await readTextFile(filePath);
          const lines = content.split('\n');
          const importedNames: string[] = [];
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            // 统一提取用户名
            let name = trimmed.replace(/^https?:\/\/x\.com\/?/i, '').replace(/^@/, '').trim();
            if (name) importedNames.push(name);
          }
          set({ searchHistory: Array.from(new Set(importedNames)).slice(0, 10) });
        } catch (err) {}
      },
      latestVersion: PACKAGE_JSON_VERSION,
      lastCheckUpdateTime: 0,
      latestUrl: '',
      setLastCheckUpdateTime: (time) => set({ lastCheckUpdateTime: time }),
      setLatestVersion: (version) => set({ latestVersion: version }),
      setLatestUrl: (url) => set({ latestUrl: url }),
      systemProxyUrl: '',
      setSystemProxyUrl: (url) => set({ systemProxyUrl: url }),
    }),
    { name: 'app-state', storage: createTauriFileStorage(), version: 1 }
  )
);