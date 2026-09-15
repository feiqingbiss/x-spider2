/* eslint-disable react/prop-types */
import {
  CaretRightFilled,
  DeleteFilled,
  DownloadOutlined,
  FileFilled,
  FolderFilled,
  PauseOutlined,
} from '@ant-design/icons';
import { dialog, fs, path, shell } from '@tauri-apps/api';
import { convertFileSrc, invoke } from '@tauri-apps/api/tauri';
import { App, Avatar, Progress } from 'antd';
import * as R from 'ramda';
import React, { memo, useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { DownloadTask } from '../../interfaces/DownloadTask';
import { useDownloadStore } from '../../stores/download';
import { buildPostUrl, buildUserUrl } from '../../twitter/url';
import { showInFolder } from '../../utils/shell';
import { AriaStatus } from '../../utils/aria2';
import MediaType from '../../enums/MediaType';
import { StatusText } from './StatusText';
import { TaskAction, TaskActions } from './TaskActions';

export interface DownloadListItemProps {
  task: DownloadTask;
  itemClientHeight: number;
  itemGap: number;
}

const areEqual = (
  prevProps: DownloadListItemProps,
  nextProps: DownloadListItemProps,
) => {
  const prev = prevProps.task;
  const next = nextProps.task;
  return (
    prev.gid === next.gid &&
    prev.status === next.status &&
    prev.completeSize === next.completeSize &&
    prev.totalSize === next.totalSize &&
    prev.error === next.error &&
    prev.fileName === next.fileName &&
    prev.updatedAt === next.updatedAt
  );
};

// ============ 缩略图缓存与并发控制 ============

// 已生成好的缩略图 data URL 缓存：gid -> dataUrl（null 表示生成失败）
const thumbCache = new Map<string, string | null>();

// 正在生成的缩略图 Promise 缓存，避免同一 gid 并发重复请求
const thumbInflight = new Map<string, Promise<string | null>>();

// 同时最多处理 2 个缩略图请求，避免打爆 IPC
const MAX_CONCURRENT_THUMBS = 2;
let runningThumbTasks = 0;
const thumbWaitQueue: Array<() => void> = [];

function runWithLimit<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const task = () => {
      runningThumbTasks++;
      fn()
        .then(resolve, reject)
        .finally(() => {
          runningThumbTasks--;
          const next = thumbWaitQueue.shift();
          if (next) next();
        });
    };
    if (runningThumbTasks < MAX_CONCURRENT_THUMBS) task();
    else thumbWaitQueue.push(task);
  });
}

/**
 * 生成（或从缓存拿）缩略图 data URL。
 * - 命中缓存直接返回
 * - 已有进行中的请求，复用同一个 Promise
 * - 否则进入并发队列，调用 Rust 端 generate_thumbnail
 */
function loadThumbnail(gid: string, localPath: string): Promise<string | null> {
  if (thumbCache.has(gid)) {
    return Promise.resolve(thumbCache.get(gid)!);
  }
  const inflight = thumbInflight.get(gid);
  if (inflight) return inflight;

  const p = runWithLimit(async () => {
    try {
      const dataUrl = await invoke<string>('generate_thumbnail', {
        path: localPath,
      });
      thumbCache.set(gid, dataUrl);
      return dataUrl;
    } catch (e) {
      console.warn('[Thumb] generate_thumbnail failed:', e);
      thumbCache.set(gid, null);
      return null;
    } finally {
      thumbInflight.delete(gid);
    }
  });

  thumbInflight.set(gid, p);
  return p;
}

// 清理某个 gid 的缓存（删除/重下时调用）
function clearThumbCache(gid: string) {
  thumbCache.delete(gid);
  thumbInflight.delete(gid);
}

// ============ 缩略图类型 ============
type ThumbKind = 'local' | 'net' | 'none';

// 缩略图超时（毫秒）：生成一张 400px 缩略图通常 <500ms，给 15 秒足够
const THUMB_TIMEOUT_MS = 15000;

export const DownloadListItem: React.FC<DownloadListItemProps> = memo(
  ({ task: t, itemClientHeight }) => {
    const { message } = App.useApp();
    const [imageLoaded, setImageLoaded] = useState(false);
    const [imageErrored, setImageErrored] = useState(false);
    const [imgSrc, setImgSrc] = useState('');
    const [thumbKind, setThumbKind] = useState<ThumbKind>('none');

    const {
      removeDownloadTask,
      pauseDownloadTask,
      unpauseDownloadTask,
      redownloadTask,
    } = useDownloadStore(
      useShallow((s) => ({
        removeDownloadTask: s.removeDownloadTask,
        pauseDownloadTask: s.pauseDownloadTask,
        unpauseDownloadTask: s.unpauseDownloadTask,
        redownloadTask: s.redownloadTask,
      })),
    );

    useEffect(() => {
      let cancelled = false;
      setImageLoaded(false);
      setImageErrored(false);

      const netUrl = t.media.url
        ? `${t.media.url}?format=jpg&name=thumb`
        : '';

      // 非图片 / 未完成 → 直接走网络缩略图
      const canUseLocalThumb =
        t.status === AriaStatus.Complete &&
        t.media.type === MediaType.Photo &&
        !!t.dir &&
        !!t.fileName;

      if (!canUseLocalThumb) {
        setImgSrc(netUrl);
        setThumbKind(netUrl ? 'net' : 'none');
        return () => {
          cancelled = true;
        };
      }

      // 检查缓存：命中直接显示
      if (thumbCache.has(t.gid)) {
        const cached = thumbCache.get(t.gid);
        if (cached) {
          setImgSrc(cached);
          setThumbKind('local');
        } else {
          // 之前生成失败过，回退到网络
          setImgSrc(netUrl);
          setThumbKind(netUrl ? 'net' : 'none');
        }
        return () => {
          cancelled = true;
        };
      }

      // 未命中缓存 → 先用网络图占位（如果也有），然后异步生成缩略图
      // 如果没网络图，就先显示"生成缩略图中"
      setImgSrc(netUrl);
      setThumbKind(netUrl ? 'net' : 'none');

      (async () => {
        try {
          const localPath = await path.join(t.dir, t.fileName);
          const exists = await fs.exists(localPath);
          if (cancelled || !exists) return;

          const dataUrl = await loadThumbnail(t.gid, localPath);
          if (cancelled) return;

          if (dataUrl) {
            setImageLoaded(false);
            setImageErrored(false);
            setImgSrc(dataUrl);
            setThumbKind('local');
          }
          // dataUrl 为 null 时，保持网络图 / 无图状态
        } catch (e) {
          console.warn('[Thumb] local thumb load failed:', e);
        }
      })();

      return () => {
        cancelled = true;
      };
    }, [t.gid, t.status, t.dir, t.fileName, t.media.url, t.media.type]);

    // 超时兜底
    const settledRef = useRef(false);
    useEffect(() => {
      if (!imgSrc) return;
      settledRef.current = false;
      const timer = window.setTimeout(() => {
        if (!settledRef.current) {
          setImageErrored(true);
          setImageLoaded(true);
          settledRef.current = true;
        }
      }, THUMB_TIMEOUT_MS);
      return () => window.clearTimeout(timer);
    }, [imgSrc]);

    const handleRemove = async (gid: string) => {
      clearThumbCache(gid);
      await removeDownloadTask(gid);
    };

    const actionRedownload: TaskAction = {
      name: '重新下载',
      onClick: async () => {
        try {
          clearThumbCache(t.gid);
          await redownloadTask(t.gid);
          message.success('已开始重新下载该任务');
        } catch (err) {
          window.log.error(err);
          dialog.message('无法重新下载文件', {
            type: 'error',
          });
        }
      },
      icon: <DownloadOutlined />,
      primary: false,
    };

    const actionPause: TaskAction = {
      name: '暂停',
      onClick: async () => {
        await pauseDownloadTask(t.gid);
      },
      icon: <PauseOutlined />,
      primary: true,
    };

    const actionUnpause: TaskAction = {
      name: '继续',
      onClick: async () => {
        await unpauseDownloadTask(t.gid);
      },
      icon: <CaretRightFilled />,
      primary: true,
    };

    const actionDelete: TaskAction = {
      name: '删除',
      onClick: async () => {
        if (
          await dialog.confirm('确认删除该任务？\n已下载的文件不会被删除。', {
            okLabel: '删除',
            cancelLabel: '取消',
            type: 'warning',
            title: '删除任务',
          })
        ) {
          await handleRemove(t.gid);
        }
      },
      icon: <DeleteFilled />,
      danger: true,
    };

    const actionOpen: TaskAction = {
      name: '打开',
      onClick: async () => {
        const filePath = await path.join(t.dir, t.fileName);
        if (!(await fs.exists(filePath))) {
          dialog.message('文件不存在', {
            type: 'error',
            title: '错误',
          });
          return;
        }
        await shell.open(filePath);
      },
      icon: <FileFilled />,
      primary: true,
    };

    const actionOpenDir: TaskAction = {
      name: '打开目录',
      onClick: async () => {
        const filePath = await path.join(t.dir, t.fileName);
        if (!(await fs.exists(filePath))) {
          dialog.message('文件不存在', {
            type: 'error',
            title: '错误',
          });
          return;
        }
        await showInFolder(filePath, true);
      },
      icon: <FolderFilled />,
    };

    const tagText =
      thumbKind === 'local' ? 'L' : thumbKind === 'net' ? 'N' : '-';
    const tagColor = imageErrored
      ? 'rgba(220,38,38,0.85)'
      : thumbKind === 'local'
        ? 'rgba(22,163,74,0.85)'
        : thumbKind === 'net'
          ? 'rgba(37,99,235,0.85)'
          : 'rgba(107,114,128,0.85)';

    return (
      <div
        role="listitem"
        className="bg-white border-[1px] border-gray-300 rounded-md flex overflow-hidden"
      >
        <div
          className="shrink-0 overflow-hidden relative bg-gray-100"
          style={{
            width: itemClientHeight,
            height: itemClientHeight,
          }}
        >
          {!imgSrc && (
            <div className="w-full h-full bg-gray-100 flex items-center justify-center text-gray-400 text-xs">
              生成缩略图中...
            </div>
          )}
          {imgSrc && !imageLoaded && !imageErrored && (
            <div className="w-full h-full bg-gray-200 animate-pulse flex flex-col items-center justify-center text-gray-400 text-xs">
              <span>加载中...</span>
              {thumbKind === 'local' && (
                <span className="text-[10px] mt-1 opacity-70">本地缩略图</span>
              )}
            </div>
          )}
          {imgSrc && imageErrored && (
            <div className="w-full h-full bg-gray-100 flex items-center justify-center text-gray-400 text-xs">
              预览不可用
            </div>
          )}
          <a
            href={
              t.post.user?.screenName && t.post.id
                ? buildPostUrl(t.post.user.screenName, t.post.id)
                : 'javascript:void(0);'
            }
            target="_blank"
            rel="noreferrer"
            className="block w-full h-full"
            title="打开推文页"
          >
            {imgSrc && (
              <img
                src={imgSrc}
                className={`w-full h-full object-cover transition-transform transform hover:scale-105 ${
                  imageLoaded && !imageErrored ? 'block' : 'hidden'
                }`}
                onLoad={() => {
                  settledRef.current = true;
                  setImageLoaded(true);
                }}
                onError={() => {
                  settledRef.current = true;
                  setImageErrored(true);
                  setImageLoaded(true);
                }}
                alt="缩略图"
              />
            )}
          </a>
          <div
            className="absolute right-1 bottom-1 px-1 rounded text-[10px] leading-4 text-white font-bold"
            style={{ background: tagColor }}
          >
            {tagText}
          </div>
        </div>

        <div className="ml-4 overflow-hidden pr-4 w-full h-full">
          <p
            title={t.fileName}
            className="text-ellipsis overflow-hidden whitespace-nowrap font-bold mt-2"
          >
            {t.fileName}
          </p>
          <a
            href={
              t.post.user?.screenName
                ? buildUserUrl(t.post.user?.screenName)
                : 'javascript:void(0);'
            }
            title={`跳转到 ${
              t.post.user?.name || t.post.user?.screenName || '未知用户'
            } 的主页`}
            target="_blank"
            rel="noreferrer"
            className="text-xs flex items-center space-x-1 w-fit text-ant-color-text-secondary bg-gray-100 p-1 rounded-full pr-2 overflow-hidden"
          >
            <Avatar src={t.post.user?.avatar} size={20} />
            <span>{t.post.user?.name || '未知用户'}</span>
            {t.post.user?.screenName && <span>@{t.post.user.screenName}</span>}
          </a>
          <div className="mt-2">
            <TaskActions
              actions={R.cond([
                [R.equals('active'), R.always([actionPause, actionDelete])],
                [R.equals('paused'), R.always([actionUnpause, actionDelete])],
                [R.equals('error'), R.always([actionRedownload, actionDelete])],
                [
                  R.equals('complete'),
                  R.always([
                    actionOpen,
                    actionOpenDir,
                    actionRedownload,
                    actionDelete,
                  ]),
                ],
                [R.T, R.always([])],
              ])(t.status)}
            />
          </div>
          <div className="mt-0">
            <Progress
              percent={
                t.totalSize > 0
                  ? Math.round((t.completeSize / t.totalSize) * 100)
                  : 0
              }
              className="mb-0 mr-0"
            />
          </div>
          <div>
            <StatusText task={t} />
          </div>
        </div>
      </div>
    );
  },
  areEqual,
);