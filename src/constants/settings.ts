import { Settings } from '../interfaces/Settings';

export const DEFAULT_SETTINGS: Settings = {
  proxy: {
    enable: true,
    url: 'http://127.0.0.1:7890',
    useSystem: true,
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
    writeLogs: true, // 改为 true，确保日志写入文件
  },
};

export const CURRENT_SETTINGS_VERSION = 2;