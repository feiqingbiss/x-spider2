import { shell } from '@tauri-apps/api';
import { createCrossPlatformInvoker } from './cross-platform';

export const showInFolder = createCrossPlatformInvoker<
  (path: string, isFile?: boolean) => Promise<void>
>({
  async windows(path: string, isFile = false) {
    // ✅ 修复：打开目录时直接 open 路径，不要用 /select 去选中文件，选中操作在大量任务时极易卡死
    if (isFile) {
      // 保留选中功能，但用引号包裹，防止路径有空格
      await new shell.Command('explorer', [`/select,"${path}"`]).execute();
    } else {
      await new shell.Command('explorer', [path]).execute();
    }
  },
  async macos(path: string, isFile = false) {
    if (isFile) {
      await new shell.Command('open', ['-R', path]).execute();
    } else {
      await new shell.Command('open', [path]).execute();
    }
  },
});