import { Settings } from '../interfaces/Settings';

export const DEFAULT_SETTINGS: Settings = {
  proxy: {
    enable: true,
    url: 'http://127.0.0.1:7890',
  },
  download: {
    saveDirBase: '',
    dirTemplate: '',
    fileNameTemplate:
      '%POST_TIME% %USER_SCREEN_NAME% %POST_ID%-%MEDIA_INDEX%%EXT%',
    sameFileSkip: true,
  },
  app: {
    autoCheckUpdate: true,
    acceptPrerelease: false,
    writeLogs: true,
  },
};

// ✅ 版本号 2 → 3
export const CURRENT_SETTINGS_VERSION = 3;