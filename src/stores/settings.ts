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
  openFolder: (folderPath: string) => Promise<void>;
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

      openFolder: async (folderPath) => {
        try {
          await shell.open(folderPath);
        } catch (err) {
          log.error('无法打开文件夹:', err);
        }
      },

      openAppDataFolder: async () => {
        try {
          const appDataDir = await path.appLocalDataDir();
          await shell.open(appDataDir);
        } catch (err) {
          log.error('无法打开数据目录:', err);
        }
      },
    }),
    {
      name: 'settings',
      version: CURRENT_SETTINGS_VERSION,
      storage: createTauriFileStorage(),
      onRehydrateStorage: () => {
        return async (state, error) => {
          if (error) return;

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
        // v1 → v2：savePath 改名为 saveDirBase
        if (version === 1) {
          delete state.download.savePath;
        }
        // v2 → v3：删除 proxy.useSystem
        if (version < 3) {
          if (state.proxy) {
            delete state.proxy.useSystem;
          }
        }
        return state;
      },
    },
  ),
);