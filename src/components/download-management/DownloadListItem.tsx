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
import React, { memo, useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { DownloadTask } from '../../interfaces/DownloadTask';
import { useDownloadStore } from '../../stores/download';
import { buildPostUrl, buildUserUrl } from '../../twitter/url';
import { showInFolder } from '../../utils/shell';
import { AriaStatus } from '../../utils/aria2';
import { StatusText } from './StatusText';
import { TaskAction, TaskActions } from './TaskActions';
import { ProxyAvatar } from '../common/ProxyAvatar';
import { SmoothImage } from '../common/SmoothImage';
import { 
  getRemoteThumbnail, 
  getMediaThumbnail, 
  getCachedMediaThumbnail, 
  getCachedRemoteThumbnail 
} from '../../utils/image-cache';

export interface DownloadListItemProps {
  task: DownloadTask;
  itemClientHeight: number;
  itemGap: number;
}

const areEqual = (prevProps: DownloadListItemProps, nextProps: DownloadListItemProps) => {
  const prev = prevProps.task;
  const next = nextProps.task;
  return (
    prev.gid === next.gid && 
    prev.status === next.status && 
    prev.fileName === next.fileName &&
    prev.completeSize === next.completeSize &&
    prev.totalSize === next.totalSize
  );
};

const ThumbnailArea = memo(
  ({ task, itemClientHeight }: { task: DownloadTask; itemClientHeight: number }) => {
    const mediaId = task.media.id || 'unknown';
    
    // ✅ 核心修复：初始化状态时，直接从内存缓存中同步获取，杜绝第一帧的灰底闪烁
    const [remoteSrc, setRemoteSrc] = useState<string>(() => {
      let baseUrl = task.media.url || (task.media.id ? `https://pbs.twimg.com/media/${task.media.id}` : '');
      if (!baseUrl) return '';
      const cleanUrl = baseUrl.split('?')[0];
      return getCachedRemoteThumbnail(`${cleanUrl}?format=jpg&name=small`) || '';
    });

    const [localSrc, setLocalSrc] = useState<string>(() => {
      return getCachedMediaThumbnail(mediaId) || '';
    });

    // 1. 请求网络兜底图（如果缓存里已经有了就直接跳过）
    useEffect(() => {
      if (remoteSrc) return;
      let cancelled = false;
      let baseUrl = task.media.url || (task.media.id ? `https://pbs.twimg.com/media/${task.media.id}` : '');
      if (!baseUrl) return;
      const cleanUrl = baseUrl.split('?')[0];
      const remoteUrl = `${cleanUrl}?format=jpg&name=small`;

      getRemoteThumbnail(remoteUrl)
        .then((src) => {
          if (!cancelled) setRemoteSrc(src);
        })
        .catch(() => {});

      return () => { cancelled = true; };
    }, [task.gid, remoteSrc]); // ✅ 只依赖 gid 和 当前状态

    // 2. 任务完成后，尝试请求本地生成的缩略图
    useEffect(() => {
      if (task.status !== AriaStatus.Complete || !task.dir || !task.fileName) return;
      // 如果已经有了 localSrc，直接退出
      if (localSrc) return;
      
      let cancelled = false;
      getMediaThumbnail(task.media, task.post)
        .then((res) => {
          if (!cancelled && res.src) setLocalSrc(res.src);
        })
        .catch(() => {});

      return () => { cancelled = true; };
    }, [task.gid, task.status, localSrc]); // ✅ 剔除复杂对象依赖，避免由于状态合并造成的无限刷新

    const finalSrc = localSrc || remoteSrc;

    return (
      <div className="shrink-0 relative bg-gray-100" style={{ width: itemClientHeight, height: itemClientHeight }}>
        {!finalSrc && (
          <div className="w-full h-full bg-gray-200 animate-pulse flex flex-col items-center justify-center text-gray-400 text-xs">
            <span>加载中...</span>
          </div>
        )}
        <a href={task.post.user?.screenName && task.post.id ? buildPostUrl(task.post.user.screenName, task.post.id) : 'javascript:void(0);'} target="_blank" rel="noreferrer" className="block w-full h-full" title="打开推文页">
          {finalSrc && <SmoothImage src={finalSrc} className="w-full h-full transition-transform duration-300 transform hover:scale-105" />}
        </a>
      </div>
    );
  },
  (prev, next) => prev.task.gid === next.task.gid && prev.task.status === next.task.status && prev.itemClientHeight === next.itemClientHeight
);

const TaskStatusBar = memo(({ task }: { task: DownloadTask }) => {
  const percent = task.totalSize > 0 ? Math.round((task.completeSize / task.totalSize) * 100) : 0;
  return (
    <div className="mt-0">
      <Progress percent={percent} className="mb-0 mr-0" />
      <div><StatusText task={task} /></div>
    </div>
  );
});

export const DownloadListItem: React.FC<DownloadListItemProps> = memo(
  ({ task: t, itemClientHeight }) => {
    const { message } = App.useApp();
    const { removeDownloadTask, pauseDownloadTask, unpauseDownloadTask, redownloadTask } = useDownloadStore(
      useShallow((s) => ({
        removeDownloadTask: s.removeDownloadTask,
        pauseDownloadTask: s.pauseDownloadTask,
        unpauseDownloadTask: s.unpauseDownloadTask,
        redownloadTask: s.redownloadTask,
      })),
    );

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
    };

    const actionPause: TaskAction = { name: '暂停', onClick: async () => await pauseDownloadTask(t.gid), icon: <PauseOutlined />, primary: true };
    const actionUnpause: TaskAction = { name: '继续', onClick: async () => await unpauseDownloadTask(t.gid), icon: <CaretRightFilled />, primary: true };
    
    const actionDelete: TaskAction = {
      name: '删除',
      onClick: async () => {
        if (await dialog.confirm('确认删除该任务？\n已下载的文件不会被删除。', { okLabel: '删除', cancelLabel: '取消', type: 'warning', title: '删除任务' })) {
          await removeDownloadTask(t.gid);
        }
      },
      icon: <DeleteFilled />, danger: true,
    };

    const actionOpen: TaskAction = {
      name: '打开',
      onClick: async () => {
        const filePath = await path.join(t.dir, t.fileName);
        if (!(await fs.exists(filePath))) return dialog.message('文件不存在', { type: 'error', title: '错误' });
        await shell.open(filePath);
      },
      icon: <FileFilled />, primary: true,
    };

    const actionOpenDir: TaskAction = {
      name: '打开目录',
      onClick: async () => {
        const filePath = await path.join(t.dir, t.fileName);
        if (!(await fs.exists(filePath))) return dialog.message('文件不存在', { type: 'error', title: '错误' });
        await showInFolder(filePath, true);
      },
      icon: <FolderFilled />,
    };

    return (
      <div role="listitem" className="bg-white border-[1px] border-gray-300 rounded-md flex overflow-hidden">
        <ThumbnailArea task={t} itemClientHeight={itemClientHeight} />

        <div className="ml-4 overflow-hidden pr-4 w-full h-full flex flex-col justify-between py-1">
          <div>
            <p title={t.fileName} className="text-ellipsis overflow-hidden whitespace-nowrap font-bold mt-1">{t.fileName}</p>
            <a
              href={t.post.user?.screenName ? buildUserUrl(t.post.user?.screenName) : 'javascript:void(0);'}
              title={`跳转到 ${t.post.user?.name || t.post.user?.screenName || '未知用户'} 的主页`}
              target="_blank" rel="noreferrer"
              className="text-xs flex items-center space-x-1 w-fit text-ant-color-text-secondary bg-gray-100 p-1 rounded-full pr-2 overflow-hidden mt-1"
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
                  [R.equals('complete'), R.always([actionOpen, actionOpenDir, actionRedownload, actionDelete])],
                  [R.T, R.always([])],
                ])(t.status)}
              />
            </div>
          </div>
          
          <TaskStatusBar task={t} />
        </div>
      </div>
    );
  },
  areEqual,
);