import { convertFileSrc, invoke } from '@tauri-apps/api/tauri';
import { path } from '@tauri-apps/api';
import { TwitterMedia } from '../interfaces/TwitterMedia';
import { TwitterPost } from '../interfaces/TwitterPost';
import { useSettingsStore } from '../stores/settings';
import { resolveVariables } from './file-name-template';
import { FileNameTemplateData } from '../interfaces/FileNameTemplateData';
import MediaType from '../enums/MediaType';

const memoryCache = new Map<string, string>();
const inflight = new Map<string, Promise<string>>();
const localExistsCache = new Map<string, { exists: boolean; localPath: string }>();

// 独立队列：网络并发 4，本地生成并发 10（14700KF 完全吃得下）
function createQueue(limit: number) {
  let active = 0;
  const q: (() => void)[] = [];
  return function run<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const task = () => {
        active++;
        fn()
          .then(resolve, reject)
          .finally(() => {
            active--;
            const next = q.shift();
            if (next) next();
          });
      };
      if (active < limit) task();
      else q.push(task);
    });
  };
}

const runRemoteQueue = createQueue(4);
const runLocalQueue = createQueue(10);

export function getRemoteThumbnail(url: string): Promise<string> {
  if (memoryCache.has(url)) return Promise.resolve(memoryCache.get(url)!);
  if (inflight.has(url)) return inflight.get(url)!;

  const p = runRemoteQueue(() =>
    invoke<string>('download_image_to_cache', { url })
      .then((localPath) => {
        const src = convertFileSrc(localPath);
        memoryCache.set(url, src);
        return src;
      })
      .finally(() => inflight.delete(url)),
  );

  inflight.set(url, p);
  return p;
}

export function getLocalThumbnail(localPath: string): Promise<string> {
  const cacheKey = `local:${localPath}`;
  if (memoryCache.has(cacheKey)) return Promise.resolve(memoryCache.get(cacheKey)!);
  if (inflight.has(cacheKey)) return inflight.get(cacheKey)!;

  const p = runLocalQueue(() =>
    invoke<string>('generate_thumbnail', { path: localPath })
      .then((thumbPath) => {
        const src = convertFileSrc(thumbPath);
        memoryCache.set(cacheKey, src);
        return src;
      })
      .finally(() => inflight.delete(cacheKey)),
  );

  inflight.set(cacheKey, p);
  return p;
}

export async function getMediaThumbnail(
  media: TwitterMedia,
  post: TwitterPost,
): Promise<{ src: string; localPath?: string }> {
  const settings = useSettingsStore.getState();
  const mediaId = media.id || 'unknown';
  const cacheKey = `media:${mediaId}`;

  if (memoryCache.has(cacheKey)) {
    const localInfo = localExistsCache.get(mediaId);
    return {
      src: memoryCache.get(cacheKey)!,
      localPath: localInfo?.exists ? localInfo.localPath : undefined,
    };
  }

  let localPath = '';
  let exists = false;

  // 计算路径（不查 fs.exists，直接让 Rust 去读）
  if (settings.download.saveDirBase && settings.download.fileNameTemplate) {
    try {
      const templateData: FileNameTemplateData = { media, post };
      const resolvedDirName = settings.download.dirTemplate
        ? resolveVariables(settings.download.dirTemplate, templateData)
        : '';
      const dir = await path.join(settings.download.saveDirBase, resolvedDirName);
      const fileName = resolveVariables(settings.download.fileNameTemplate, templateData);
      localPath = await path.join(dir, fileName);
    } catch (e) {
      console.warn('路径解析失败', e);
    }
  }

  let finalSrc = '';
  
  // 尝试本地生成
  if (localPath) {
    let targetPath = localPath;
    if (media.type === MediaType.Video || media.type === MediaType.Gif) {
      targetPath = `${localPath}.thumb.jpg`;
    }

    try {
      // 直接让 Rust 去读文件，读不到会 reject，直接走 catch
      finalSrc = await getLocalThumbnail(targetPath);
      exists = true;
      localExistsCache.set(mediaId, { exists: true, localPath });
    } catch (e) {
      // 本地没原图或没缩略图，忽略
      exists = false;
      localExistsCache.set(mediaId, { exists: false, localPath: '' });
    }
  }

  // 如果本地没有，走网络
  if (!finalSrc) {
    let baseUrl = media.url || `https://pbs.twimg.com/media/${media.id}`;
    const qIndex = baseUrl.indexOf('?');
    if (qIndex !== -1) baseUrl = baseUrl.slice(0, qIndex);

    if (media.type === MediaType.Video || media.type === MediaType.Gif) {
      // 视频直连
      finalSrc = `${baseUrl}?format=jpg&name=small`;
    } else {
      finalSrc = await getRemoteThumbnail(`${baseUrl}?format=jpg&name=small`);
    }
  }

  memoryCache.set(cacheKey, finalSrc);
  return { src: finalSrc, localPath: exists ? localPath : undefined };
}

export function clearImageCache(urlOrPath: string) {
  memoryCache.delete(urlOrPath);
  memoryCache.delete(`local:${urlOrPath}`);
  inflight.delete(urlOrPath);
  inflight.delete(`local:${urlOrPath}`);
}