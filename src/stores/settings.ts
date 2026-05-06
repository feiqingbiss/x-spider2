import { path, shell } from '@tauri-apps/api';
import * as R from 'ramda';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  CURRENT_SETTINGS_VERSION,
  DEFAULT_SETTINGS,
} from '../constants/settings';
import { Settings } from '../interfaces/Settings';
import { createTauriFileStorage } from './persist/tauri-file-storage';

export interface SettingsStore extends Settings {
  update: (settings: Settings) => void;
  updateOne: <T>(name: string, key: string, value: T) => Promise<void>;
  // 新增：打开指定的文件夹
  openFolder: (folderPath: string) => Promise<void>;
  // 新增：打开 App 数据目录（查看 txt 文件所在处）
  openAppDataFolder: () => Promise<void>;
}

export const useSettingsStore = create(
  persist<SettingsStore>(
    (set, get) => ({
      ...DEFAULT_SETTINGS,
      update: (settings) => {
        set(settings);
      },
      updateOne: async (name, key, value) => {
        const store = get();
        const newSettings = R.assocPath([name, key], value)(store) as Settings;
        store.update(newSettings);
        log.info('UpdateSettings', `${name}.${key}`, value);
      },
      
      // 辅助方法：使用系统默认管理器打开文件夹
      openFolder: async (folderPath) => {
        try {
          await shell.open(folderPath);
        } catch (err) {
          log.error('无法打开文件夹:', err);
        }
      },

      // 辅助方法：打开包含 search-user-name.txt 的数据目录
      openAppDataFolder: async () => {
        try {
          const appDataDir = await path.appLocalDataDir();
          await shell.open(appDataDir);
        } catch (err) {
          log.error('无法打开数据目录:', err);
        }
      }
    }),
    {
      name: 'settings',
      version: CURRENT_SETTINGS_VERSION,
      storage: createTauriFileStorage(),
      onRehydrateStorage: () => {
        return async (state, error) => {
          if (error) return;

          // 如果没有默认保存路径，设置为系统 Downloads 文件夹所在地
          if (!state?.download.saveDirBase) {
            const dir = await path.downloadDir();
            useSettingsStore.setState({
              download: R.mergeDeepRight(state!.download, {
                saveDirBase: dir,
              }),
            });
          }
        };
      },
      migrate(state: any, version) {
        if (version === 1) {
          delete state.download.savePath;
        }
        return state;
      },
    },
  ),
);
