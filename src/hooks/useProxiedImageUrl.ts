import { convertFileSrc, invoke } from '@tauri-apps/api/tauri';
import { useEffect, useState } from 'react';

export type ProxiedImageStatus = 'idle' | 'loading' | 'success' | 'error';

/**
 * 统一处理需要走 Rust 代理下载的图片。
 * 传入远程图片 URL，返回本地缓存路径（已通过 convertFileSrc 转换）和加载状态。
 */
export function useProxiedImageUrl(url?: string) {
  const [status, setStatus] = useState<ProxiedImageStatus>(url ? 'loading' : 'idle');
  const [src, setSrc] = useState<string>('');

  useEffect(() => {
    if (!url) {
      setStatus('idle');
      setSrc('');
      return;
    }

    let cancelled = false;
    setStatus('loading');
    setSrc('');

    invoke<string>('download_image_to_cache', { url })
      .then((localPath) => {
        if (cancelled) return;
        setSrc(convertFileSrc(localPath));
        setStatus('success');
      })
      .catch((err) => {
        if (cancelled) return;
        console.warn('[ProxiedImage] 加载失败', url, err);
        setStatus('error');
      });

    return () => {
      cancelled = true;
    };
  }, [url]);

  return { src, status };
}