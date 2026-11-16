import { convertFileSrc, invoke } from '@tauri-apps/api/tauri';
import { path } from '@tauri-apps/api';
import { TwitterMedia } from '../interfaces/TwitterMedia';
import { TwitterPost } from '../interfaces/TwitterPost';
import { useSettingsStore } from '../stores/settings';
import { resolveVariables } from './file-name-template';
import { FileNameTemplateData } from '../interfaces/FileNameTemplateData';
import MediaType from '../enums/MediaType';

const MAX_CACHE_SIZE = 2000; // ✅ 限制最大缓存 2000 张图片

class LRUCache<V> {
  private cache = new Map<string, V>();
  constructor(private maxSize: number) {}
  get(key: string): V | undefined {
    if (!this.cache.has(key)) return undefined;
    const val = this.cache.get(key)!;
    // 刷新活跃度：删了重新加
    this.cache.delete(key);
    this.cache.set(key, val);
    return val;
  }
  set(key: string, value: V) {
    if (this.cache.has(key)) this.cache.delete(key);
    else if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey) this.cache.delete(firstKey);
    }
    this.cache.set(key, value);
  }
}

const memoryCache = new LRUCache<string>(MAX_CACHE_SIZE);
const localExistsCache = new LRUCache<{ exists: boolean; localPath: string }>(MAX_CACHE_SIZE);
const inflight = new Map<string, Promise<string>>();

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

const remoteQueue = createQueue(30); 
const localQueue = createQueue(4);

export function getRemoteThumbnail(url: string): Promise<string> {
  const cached = memoryCache.get(url);
  if (cached) return Promise.resolve(cached);
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
  const cached = memoryCache.get(cacheKey);
  if (cached) return Promise.resolve(cached);
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

  const cachedSrc = memoryCache.get(cacheKey);
  if (cachedSrc) {
    const localInfo = localExistsCache.get(mediaId);
    return {
      src: cachedSrc,
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