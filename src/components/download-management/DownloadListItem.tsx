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
import { convertFileSrc } from '@tauri-apps/api/tauri';
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

// 图片加载超时（毫秒）：超过这个时间既没 onLoad 也没 onError，判定为失败
const IMAGE_LOAD_TIMEOUT_MS = 5000;

type ThumbKind = 'local' | 'net' | 'none';

export const DownloadListItem: React.FC<DownloadListItemProps> = memo(
  ({ task: t, itemClientHeight }) => {
    const { message } = App.useApp();
    const [imageLoaded, setImageLoaded] = useState(false);
    const [imageErrored, setImageErrored] = useState(false);
    const [imgSrc, setImgSrc] = useState('');
    const [thumbKind, setThumbKind] = useState<ThumbKind>('none');

    // 记录当前 imgSrc 是否已经有结果（成功/失败），避免超时定时器误伤
    const settledRef = useRef(false);

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
      settledRef.current = false;
      setImageLoaded(false);
      setImageErrored(false);

      const netUrl = t.media.url
        ? `${t.media.url}?format=jpg&name=thumb`
        : '';

      // 步骤 1：先同步设网络缩略图（保证 imgSrc 不为空）
      setImgSrc(netUrl);
      setThumbKind(netUrl ? 'net' : 'none');

      console.log('[Thumb] task', {
        gid: t.gid,
        status: t.status,
        mediaType: t.media.type,
        mediaUrl: t.media.url,
        dir: t.dir,
        fileName: t.fileName,
        netUrl,
      });

      // 步骤 2：已完成 + 图片类型 + 有本地路径 → 尝试用本地文件替换
      const canUseLocalFile =
        t.status === AriaStatus.Complete &&
        t.media.type === MediaType.Photo &&
        !!t.dir &&
        !!t.fileName;

      if (!canUseLocalFile) {
        return () => {
          cancelled = true;
        };
      }

      (async () => {
        try {
          const localPath = await path.join(t.dir, t.fileName);
          const exists = await fs.exists(localPath);
          console.log('[Thumb] local path', localPath, 'exists =', exists);
          if (!exists || cancelled) return;

          const assetUrl = convertFileSrc(localPath);
          console.log('[Thumb] using asset url:', assetUrl);

          // 切到本地文件，重置状态等新的 onLoad / onError
          settledRef.current = false;
          setImageLoaded(false);
          setImageErrored(false);
          setImgSrc(assetUrl);
          setThumbKind('local');
        } catch (e) {
          console.warn('[Thumb] local file check failed, fallback to net', e);
        }
      })();

      return () => {
        cancelled = true;
      };
    }, [t.gid, t.status, t.dir, t.fileName, t.media.url, t.media.type]);

    // 超时兜底：imgSrc 变化后，IMAGE_LOAD_TIMEOUT_MS 内如果还没结算，就当作加载失败
    useEffect(() => {
      if (!imgSrc) return;
      const timer = window.setTimeout(() => {
        if (!settledRef.current) {
          console.warn('[Thumb] load timeout for', imgSrc);
          setImageErrored(true);
          setImageLoaded(true);
          settledRef.current = true;
        }
      }, IMAGE_LOAD_TIMEOUT_MS);
      return () => window.clearTimeout(timer);
    }, [imgSrc]);

    const actionRedownload: TaskAction = {
      name: '重新下载',
      onClick: async () => {
        try {
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
          await removeDownloadTask(t.gid);
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

    // 诊断标签：L=本地, N=网络, -=无；错误时额外标红
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
              无预览
            </div>
          )}
          {imgSrc && !imageLoaded && !imageErrored && (
            <div className="w-full h-full bg-gray-200 animate-pulse flex items-center justify-center text-gray-400 text-xs">
              加载中...
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
                loading="lazy"
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
          {/* 诊断角标，定位问题后可以删掉 */}
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