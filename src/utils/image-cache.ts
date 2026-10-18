import { convertFileSrc, invoke } from '@tauri-apps/api/tauri';
import { fs, path } from '@tauri-apps/api';
import { TwitterMedia } from '../interfaces/TwitterMedia';
import { TwitterPost } from '../interfaces/TwitterPost';
import { useSettingsStore } from '../stores/settings';
import { resolveVariables } from './file-name-template';
import { FileNameTemplateData } from '../interfaces/FileNameTemplateData';
import MediaType from '../enums/MediaType';

const memoryCache = new Map<string, string>();
const inflight = new Map<string, Promise<string>>();
const localExistsCache = new Map<string, { exists: boolean; localPath: string }>();

const MAX_CONCURRENT = 4;
let activeCount = 0;
const queue: (() => void)[] = [];

function runWithLimit<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const task = () => {
      activeCount++;
      fn()
        .then(resolve, reject)
        .finally(() => {
          activeCount--;
          if (queue.length > 0) {
            const next = queue.shift();
            if (next) next();
          }
        });
    };

    if (activeCount < MAX_CONCURRENT) {
      task();
    } else {
      queue.push(task);
    }
  });
}

export function getRemoteThumbnail(url: string): Promise<string> {
  if (memoryCache.has(url)) return Promise.resolve(memoryCache.get(url)!);
  if (inflight.has(url)) return inflight.get(url)!;

  const p = runWithLimit(() =>
    invoke<string>('download_image_to_cache', { url })
      .then((localPath) => {
        const src = convertFileSrc(localPath);
        memoryCache.set(url, src);
        return src;
      })
      .finally(() => {
        inflight.delete(url);
      }),
  );

  inflight.set(url, p);
  return p;
}

export function getLocalThumbnail(localPath: string): Promise<string> {
  const cacheKey = `local:${localPath}`;
  if (memoryCache.has(cacheKey))
    return Promise.resolve(memoryCache.get(cacheKey)!);
  if (inflight.has(cacheKey)) return inflight.get(cacheKey)!;

  const p = runWithLimit(() =>
    invoke<string>('generate_thumbnail', { path: localPath })
      .then((thumbPath) => {
        const src = convertFileSrc(thumbPath);
        memoryCache.set(cacheKey, src);
        return src;
      })
      .finally(() => {
        inflight.delete(cacheKey);
      }),
  );

  inflight.set(cacheKey, p);
  return p;
}

/**
 * 根据媒体信息智能获取缩略图（本地优先，网络兜底）
 */
export async function getMediaThumbnail(
  media: TwitterMedia,
  post: TwitterPost,
): Promise<{ src: string; localPath?: string }> {
  const settings = useSettingsStore.getState();
  const mediaId = media.id || 'unknown';
  const cacheKey = `media:${mediaId}`;

  // 1. 命中内存缓存
  if (memoryCache.has(cacheKey)) {
    const localInfo = localExistsCache.get(mediaId);
    return {
      src: memoryCache.get(cacheKey)!,
      localPath: localInfo?.exists ? localInfo.localPath : undefined,
    };
  }

  // 2. 计算本地原文件路径
  let localPath = '';
  let exists = false;

  if (settings.download.saveDirBase && settings.download.fileNameTemplate) {
    try {
      const templateData: FileNameTemplateData = { media, post };
      const resolvedDirName = settings.download.dirTemplate
        ? resolveVariables(settings.download.dirTemplate, templateData)
        : '';
      const dir = await path.join(
        settings.download.saveDirBase,
        resolvedDirName,
      );
      const fileName = resolveVariables(
        settings.download.fileNameTemplate,
        templateData,
      );
      localPath = await path.join(dir, fileName);

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

  let finalSrc = '';
  try {
    if (exists && localPath) {
      // ✅ 如果本地原文件存在，进一步区分图片和视频
      if (media.type === MediaType.Video || media.type === MediaType.Gif) {
        // 视频/动图：找它下载时附带的封面图 (.thumb.jpg)
        const localThumbPath = `${localPath}.thumb.jpg`;
        const hasThumb = await fs.exists(localThumbPath);
        
        if (hasThumb) {
          finalSrc = await getLocalThumbnail(localThumbPath);
        } else {
          // 如果原视频在，但封面图不在，退回网络直连
          let baseUrl = media.url || `https://pbs.twimg.com/media/${media.id}`;
          const qIndex = baseUrl.indexOf('?');
          if (qIndex !== -1) baseUrl = baseUrl.slice(0, qIndex);
          finalSrc = `${baseUrl}?format=jpg&name=small`;
        }
      } else {
        // 普通图片：直接读取原图生成缩略图
        finalSrc = await getLocalThumbnail(localPath);
      }
    } else {
      // 本地没有原文件，走网络兜底
      let baseUrl = media.url || `https://pbs.twimg.com/media/${media.id}`;
      const qIndex = baseUrl.indexOf('?');
      if (qIndex !== -1) baseUrl = baseUrl.slice(0, qIndex);

      if (media.type === MediaType.Video || media.type === MediaType.Gif) {
        // 视频走 WebView 直连
        finalSrc = `${baseUrl}?format=jpg&name=small`;
      } else {
        // 图片走代理缓存
        const netUrl = `${baseUrl}?format=jpg&name=small`;
        finalSrc = await getRemoteThumbnail(netUrl);
      }
    }
  } catch (e) {
    console.warn('[Thumbnail] 获取失败', media.type, media.url, e);
    throw e;
  }

  memoryCache.set(cacheKey, finalSrc);
  // 返回 localPath，前端组件会根据这个字段决定是否显示“打开本地”按钮
  return { src: finalSrc, localPath: exists ? localPath : undefined };
}

export function clearImageCache(urlOrPath: string) {
  memoryCache.delete(urlOrPath);
  memoryCache.delete(`local:${urlOrPath}`);
  inflight.delete(urlOrPath);
  inflight.delete(`local:${urlOrPath}`);
}