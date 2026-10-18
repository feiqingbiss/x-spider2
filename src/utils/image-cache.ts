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

// 统一的单队列防并发
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
const runQueue = createQueue(8);

export function getRemoteThumbnail(url: string): Promise<string> {
  if (memoryCache.has(url)) return Promise.resolve(memoryCache.get(url)!);
  if (inflight.has(url)) return inflight.get(url)!;

  const p = runQueue(() =>
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

  const p = runQueue(() =>
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
): Promise<string> {
  const settings = useSettingsStore.getState();
  const mediaId = media.id || 'unknown';
  const cacheKey = `media:${mediaId}`;

  if (memoryCache.has(cacheKey)) return memoryCache.get(cacheKey)!;

  // 1. 计算本地路径
  let localPath = '';
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

  // 2. 优先请求本地高清图（Rust 会自动判断原图是否存在并生成）
  if (localPath) {
    let targetPath = localPath;
    if (media.type === MediaType.Video || media.type === MediaType.Gif) {
      targetPath = `${localPath}.thumb.jpg`;
    }
    try {
      finalSrc = await getLocalThumbnail(targetPath);
    } catch (e) {
      // 本地文件不存在，走网络
    }
  }

  // 3. 网络兜底
  if (!finalSrc) {
    let baseUrl = media.url || `https://pbs.twimg.com/media/${media.id}`;
    const qIndex = baseUrl.indexOf('?');
    if (qIndex !== -1) baseUrl = baseUrl.slice(0, qIndex);

    if (media.type === MediaType.Video || media.type === MediaType.Gif) {
      finalSrc = `${baseUrl}?format=jpg&name=small`;
    } else {
      finalSrc = await getRemoteThumbnail(`${baseUrl}?format=jpg&name=small`);
    }
  }

  memoryCache.set(cacheKey, finalSrc);
  return finalSrc;
}