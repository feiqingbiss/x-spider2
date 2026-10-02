import { invoke } from '@tauri-apps/api/tauri';
import { useEffect } from 'react';
import { useSettings } from './useSettings';

/**
 * 把"关闭窗口时最小化到托盘"设置同步到 Rust 端。
 * 启动时同步一次，之后每次设置变化都会同步。
 */
export function useSyncCloseToTray() {
  const { value: minimizeToTrayOnClose } = useSettings<boolean>(
    'app',
    'minimizeToTrayOnClose',
  );

  useEffect(() => {
    invoke('set_close_to_tray', {
      enabled: !!minimizeToTrayOnClose,
    }).catch((err) => {
      console.error('同步 close_to_tray 失败', err);
    });
  }, [minimizeToTrayOnClose]);
}