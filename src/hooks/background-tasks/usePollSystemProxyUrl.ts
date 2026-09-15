import { useUnmountedRef } from 'ahooks';
import { useEffect } from 'react';
import { getSystemProxy } from '../../ipc/network';
import { useAppStateStore } from '../../stores/app-state';

// ✅ 已修复：新增 enabled 参数，只有真正使用系统代理时才轮询
export function usePollSystemProxyUrl(enabled: boolean) {
  const setUrl = useAppStateStore((state) => state.setSystemProxyUrl);
  const unmountedRef = useUnmountedRef();

  useEffect(() => {
    if (!enabled) return;

    let timeoutId: ReturnType<typeof setTimeout>;

    const poll = async () => {
      try {
        const newUrl = await getSystemProxy();
        if (!unmountedRef.current) {
          setUrl(newUrl);
        }
      } catch (err: any) {
        window.log.error('Get system proxy failed', err);
      }

      timeoutId = setTimeout(poll, 1000);
    };

    poll();
    return () => {
      clearTimeout(timeoutId);
    };
    // ✅ 已修复：去掉 url 依赖，避免无限重建轮询
  }, [enabled, setUrl, unmountedRef]);
}