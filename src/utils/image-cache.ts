import { convertFileSrc, invoke } from '@tauri-apps/api/tauri';
import { fs, path } from '@tauri-apps/api';
import { TwitterMedia } from '../interfaces/TwitterMedia';
import { TwitterPost } from '../interfaces/TwitterPost';
import { useSettingsStore } from '../stores/settings';
import { resolveVariables } from './file-name-template';
import { FileNameTemplateData } from '../interfaces/FileNameTemplateData';

// 内存缓存：URL 或 本地路径 -> convertFileSrc 转换后的 URL
const memoryCache = new Map<string, string>();
const inflight = new Map<string, Promise<string>>();

// ✅ 缓存媒体是否在本地存在的状态，避免重复 fs.exists
const localExistsCache = new Map<string, { exists: boolean; localPath: string }>();

/**
 * 获取远程缩略图（走后端代理下载并缓存到 .x-spider-cache/remote）
 */
export function getRemoteThumbnail(url: string): Promise<string> {
  if (memoryCache.has(url)) return Promise.resolve(memoryCache.get(url)!);
  if (inflight.has(url)) return inflight.get(url)!;

  const p = invoke<string>('download_image_to_cache', { url })
    .then((localPath) => {
      const src = convertFileSrc(localPath);
      memoryCache.set(url, src);
      return src;
    })
    .finally(() => {
      inflight.delete(url);
    });
  inflight.set(url, p);
  return p;
}

/**
 * 获取本地缩略图（Rust 缩放原图并缓存到 .x-spider-cache/local）
 */
export function getLocalThumbnail(localPath: string): Promise<string> {
  const cacheKey = `local:${localPath}`;
  if (memoryCache.has(cacheKey)) return Promise.resolve(memoryCache.get(cacheKey)!);
  if (inflight.has(cacheKey)) return inflight.get(cacheKey)!;

  const p = invoke<string>('generate_thumbnail', { path: localPath })
    .then((thumbPath) => {
      const src = convertFileSrc(thumbPath);
      memoryCache.set(cacheKey, src);
      return src;
    })
    .finally(() => {
      inflight.delete(cacheKey);
    });
  inflight.set(cacheKey, p);
  return p;
}

/**
 * ✅ 终极方法：根据媒体信息智能获取缩略图（本地优先，网络兜底）
 * 返回 { src, localPath }，localPath 若存在则说明可以打开原图
 */
export async function getMediaThumbnail(
  media: TwitterMedia,
  post: TwitterPost,
): Promise<{ src: string; localPath?: string }> {
  const settings = useSettingsStore.getState();
  const mediaId = media.id || 'unknown';
  const cacheKey = `media:${mediaId}`;

  // 1. 命中内存缓存（仅缩略图）
  if (memoryCache.has(cacheKey)) {
    const localInfo = localExistsCache.get(mediaId);
    return {
      src: memoryCache.get(cacheKey)!,
      localPath: localInfo?.exists ? localInfo.localPath : undefined,
    };
  }

  // 2. 计算本地应有的路径（如果用户配置了路径和模板）
  let localPath = '';
  let exists = false;

  if (settings.download.saveDirBase && settings.download.fileNameTemplate) {
    try {
      const templateData: FileNameTemplateData = { media, post };
      const resolvedDirName = settings.download.dirTemplate
        ? resolveVariables(settings.download.dirTemplate, templateData)
        : '';
      const dir = await path.join(settings.download.saveDirBase, resolvedDirName);
      const fileName = resolveVariables(settings.download.fileNameTemplate, templateData);
      localPath = await path.join(dir, fileName);

      // 先查本地缓存，没有再查文件系统
      if (localExistsCache.has(mediaId)) {
        exists = localExistsCache.get(mediaId)!.exists;
      } else {
        exists = await fs.exists(localPath);
        localExistsCache.set(mediaId, { exists, localPath });
      }
    } catch (e) {
      console.warn('路径解析失败', e);
    }
  }

  // 3. 获取最终的缩略图 URL
  let finalSrc = '';
  if (exists && localPath) {
    finalSrc = await getLocalThumbnail(localPath);
  } else {
    // 如果没本地原图，走网络代理
    const netUrl = media.url
      ? `${media.url}?format=jpg&name=small`
      : `https://pbs.twimg.com/media/${media.id}?format=jpg&name=small`;
    finalSrc = await getRemoteThumbnail(netUrl);
  }

  memoryCache.set(cacheKey, finalSrc);
  return { src: finalSrc, localPath: exists ? localPath : undefined };
}

/**
 * 清理指定 URL 或本地路径的内存缓存（用于重新下载、删除时）
 */
export function clearImageCache(urlOrPath: string) {
  memoryCache.delete(urlOrPath);
  memoryCache.delete(`local:${urlOrPath}`);
  inflight.delete(urlOrPath);
  inflight.delete(`local:${urlOrPath}`);
}