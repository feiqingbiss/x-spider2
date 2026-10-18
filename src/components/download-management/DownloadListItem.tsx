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
import { App, Progress } from 'antd';
import * as R from 'ramda';
import React, { memo, useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { DownloadTask } from '../../interfaces/DownloadTask';
import { useDownloadStore } from '../../stores/download';
import { buildPostUrl, buildUserUrl } from '../../twitter/url';
import { showInFolder } from '../../utils/shell';
import { AriaStatus } from '../../utils/aria2';
import MediaType from '../../enums/MediaType';
import { delay } from '../../utils';
import { StatusText } from './StatusText';
import { TaskAction, TaskActions } from './TaskActions';
import { ProxyAvatar } from '../common/ProxyAvatar';
import {
  getLocalThumbnail,
  getRemoteThumbnail,
  clearImageCache,
} from '../../utils/image-cache';

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

const THUMB_RETRY_DELAYS_MS = [500, 1000, 2000, 3000, 5000, 8000, 13000];
const THUMB_TIMEOUT_MS = 15000;

const ThumbnailArea = memo(
  ({
    task,
    itemClientHeight,
  }: {
    task: DownloadTask;
    itemClientHeight: number;
  }) => {
    const [imageLoaded, setImageLoaded] = useState(false);
    const [imageErrored, setImageErrored] = useState(false);
    const [imgSrc, setImgSrc] = useState('');
    const [thumbKind, setThumbKind] = useState<'local' | 'remote' | 'none'>('none');
    const imgSrcRef = useRef('');

    useEffect(() => {
      imgSrcRef.current = imgSrc;
    }, [imgSrc]);

    useEffect(() => {
      let cancelled = false;

      const netUrl = task.media.url ? `${task.media.url}?format=jpg&name=thumb` : '';
      const isVideoLike =
        task.media.type === MediaType.Video || task.media.type === MediaType.Gif;
      const canUseLocal =
        task.status === AriaStatus.Complete && !!task.dir && !!task.fileName;

      const loadImage = async () => {
        try {
          if (canUseLocal) {
            const localThumbPath = isVideoLike
              ? await path.join(task.dir, `${task.fileName}.thumb.jpg`)
              : await path.join(task.dir, task.fileName);

            let exists = await fs.exists(localThumbPath);
            if (!exists && isVideoLike) {
              for (const wait of THUMB_RETRY_DELAYS_MS) {
                if (cancelled) return;
                await delay(wait);
                exists = await fs.exists(localThumbPath);
                if (exists) break;
              }
            }

            if (exists && !cancelled) {
              const localSrc = await getLocalThumbnail(localThumbPath);
              if (!cancelled) {
                setImageLoaded(false);
                setImageErrored(false);
                setImgSrc(localSrc);
                setThumbKind('local');
              }
              return;
            }
          }

          if (netUrl && !cancelled) {
            const remoteSrc = await getRemoteThumbnail(netUrl);
            if (!cancelled) {
              setImageLoaded(false);
              setImageErrored(false);
              setImgSrc(remoteSrc);
              setThumbKind('remote');
            }
          } else if (!netUrl && !cancelled && !imgSrcRef.current) {
            setThumbKind('none');
          }
        } catch (e) {
          console.warn('[Thumb] load failed', e);
          if (!cancelled && !imgSrcRef.current) {
            setThumbKind('none');
          }
        }
      };

      loadImage();

      return () => {
        cancelled = true;
      };
    }, [task.gid, task.status, task.dir, task.fileName, task.media.url, task.media.type]);

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

    const tagText =
      thumbKind === 'local' ? 'L' : thumbKind === 'remote' ? 'R' : '-';
    const tagColor = imageErrored
      ? 'rgba(220,38,38,0.85)'
      : thumbKind === 'local'
        ? 'rgba(22,163,74,0.85)'
        : thumbKind === 'remote'
          ? 'rgba(37,99,235,0.85)'
          : 'rgba(107,114,128,0.85)';

    return (
      <div
        className="shrink-0 overflow-hidden relative bg-gray-100"
        style={{ width: itemClientHeight, height: itemClientHeight }}
      >
        {!imgSrc && (
          <div className="w-full h-full bg-gray-200 animate-pulse flex flex-col items-center justify-center text-gray-400 text-xs">
            <span>生成缩略图中...</span>
          </div>
        )}
        {imgSrc && !imageLoaded && !imageErrored && (
          <div className="w-full h-full bg-gray-200 animate-pulse flex flex-col items-center justify-center text-gray-400 text-xs pointer-events-none absolute inset-0 z-10">
            <span>加载中...</span>
          </div>
        )}
        {imgSrc && imageErrored && (
          <div className="w-full h-full bg-gray-100 flex items-center justify-center text-gray-400 text-xs">
            预览不可用
          </div>
        )}
        <a
          href={
            task.post.user?.screenName && task.post.id
              ? buildPostUrl(task.post.user.screenName, task.post.id)
              : 'javascript:void(0);'
          }
          target="_blank"
          rel="noreferrer"
          className="block w-full h-full"
          title="打开推文页"
        >
          {imgSrc && (
            <img
              key={task.gid}
              src={imgSrc}
              className={`w-full h-full object-cover transition-all duration-300 transform hover:scale-105 ${
                imageLoaded && !imageErrored
                  ? 'opacity-100 block'
                  : 'opacity-0 hidden'
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
          className="absolute right-1 bottom-1 px-1 rounded text-[10px] leading-4 text-white font-bold z-20"
          style={{ background: tagColor }}
        >
          {tagText}
        </div>
      </div>
    );
  },
);

export const DownloadListItem: React.FC<DownloadListItemProps> = memo(
  ({ task: t, itemClientHeight }) => {
    const { message } = App.useApp();

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

    const handleRemove = async (gid: string) => {
      // 可以清理内存中的缓存，但不要影响本地文件
      clearImageCache(`https://pbs.twimg.com/media/${t.media.id}?format=jpg&name=thumb`);
      await removeDownloadTask(gid);
    };

    const actionRedownload: TaskAction = {
      name: '重新下载',
      onClick: async () => {
        try {
          await redownloadTask(t.gid);
          message.success('已开始重新下载该任务');
        } catch (err) {
          window.log.error(err);
          dialog.message('无法重新下载文件', { type: 'error' });
        }
      },
      icon: <DownloadOutlined />,
      primary: false,
    };

    const actionPause: TaskAction = {
      name: '暂停',
      onClick: async () => await pauseDownloadTask(t.gid),
      icon: <PauseOutlined />,
      primary: true,
    };

    const actionUnpause: TaskAction = {
      name: '继续',
      onClick: async () => await unpauseDownloadTask(t.gid),
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
          dialog.message('文件不存在', { type: 'error', title: '错误' });
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
          dialog.message('文件不存在', { type: 'error', title: '错误' });
          return;
        }
        await showInFolder(filePath, true);
      },
      icon: <FolderFilled />,
    };

    return (
      <div
        role="listitem"
        className="bg-white border-[1px] border-gray-300 rounded-md flex overflow-hidden"
      >
        <ThumbnailArea task={t} itemClientHeight={itemClientHeight} />

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
            <ProxyAvatar src={t.post.user?.avatar} size={20} />
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