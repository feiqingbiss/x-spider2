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

export function getCachedRemoteThumbnail(url: string): string | undefined {
  return memoryCache.get(url);
}
export function getCachedMediaThumbnail(mediaId: string): string | undefined {
  return memoryCache.get(`media:${mediaId}`);
}

function createQueue(limit: number) {
  let active = 0;
  const q: (() => void)[] = [];
  return function run<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const task = () => {
        active++;
        fn().then(resolve, reject).finally(() => {
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

// ✅ 核心修复：分离网络和本地队列，避免本地生成图片卡死网络图片的加载
const remoteQueue = createQueue(30); // 网络图片允许较高并发
const localQueue = createQueue(4);   // 本地缩略图生成是 CPU/IO 密集型，限制低并发

export function getRemoteThumbnail(url: string): Promise<string> {
  if (memoryCache.has(url)) return Promise.resolve(memoryCache.get(url)!);
  if (inflight.has(url)) return inflight.get(url)!;

  const p = remoteQueue(() =>
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

  const p = localQueue(() =>
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

  if (settings.download.saveDirBase && settings.download.fileNameTemplate) {
    try {
      const templateData: FileNameTemplateData = { media, post };
      const resolvedDirName = settings.download.dirTemplate
        ? resolveVariables(settings.download.dirTemplate, templateData)
        : '';
      const dir = await path.join(settings.download.saveDirBase, resolvedDirName);
      const fileName = resolveVariables(settings.download.fileNameTemplate, templateData);
      localPath = await path.join(dir, fileName);
    } catch (e) {}
  }

  let finalSrc = '';
  
  if (localPath) {
    let targetPath = localPath;
    if (media.type === MediaType.Video || media.type === MediaType.Gif) {
      targetPath = `${localPath}.thumb.jpg`;
    }
    try {
      finalSrc = await getLocalThumbnail(targetPath);
      exists = true;
      localExistsCache.set(mediaId, { exists: true, localPath });
    } catch (e) {
      exists = false;
      localExistsCache.set(mediaId, { exists: false, localPath: '' });
    }
  }

  if (!finalSrc) {
    let baseUrl = media.url || `https://pbs.twimg.com/media/${media.id}`;
    const qIndex = baseUrl.indexOf('?');
    if (qIndex !== -1) baseUrl = baseUrl.slice(0, qIndex);

    const remoteUrl = `${baseUrl}?format=jpg&name=small`;
    finalSrc = await getRemoteThumbnail(remoteUrl);
  }

  memoryCache.set(cacheKey, finalSrc);
  return { src: finalSrc, localPath: exists ? localPath : undefined };
}