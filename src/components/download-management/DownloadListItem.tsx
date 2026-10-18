/* eslint-disable react/prop-types */
import {
  CaretRightFilled,
  DeleteFilled,
  DownloadOutlined,
  FileFilled,
  FolderFilled,
  PauseOutlined,
} from '@ant-design/icons';
import { shell } from '@tauri-apps/api';
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
    
    const [remoteSrc, setRemoteSrc] = useState<string>(() => {
      let baseUrl = task.media.url || (task.media.id ? `https://pbs.twimg.com/media/${task.media.id}` : '');
      if (!baseUrl) return '';
      const cleanUrl = baseUrl.split('?')[0];
      return getCachedRemoteThumbnail(`${cleanUrl}?format=jpg&name=small`) || '';
    });

    const [localSrc, setLocalSrc] = useState<string>(() => {
      return getCachedMediaThumbnail(mediaId) || '';
    });

    // ✅ 核心重构：绝对优先网络，网络挂了才走本地
    useEffect(() => {
      // 如果已经有任何一个图了（比如从缓存命中了），直接跳过
      if (remoteSrc || localSrc) return;

      let cancelled = false;

      const load = async () => {
        let baseUrl = task.media.url || (task.media.id ? `https://pbs.twimg.com/media/${task.media.id}` : '');
        if (!baseUrl) return;
        const cleanUrl = baseUrl.split('?')[0];
        const remoteUrl = `${cleanUrl}?format=jpg&name=small`;

        try {
          // 1. 优先请求极速的 CDN 网络图
          const src = await getRemoteThumbnail(remoteUrl);
          if (!cancelled) setRemoteSrc(src);
          // 只要网络图拿到，就立刻返回，绝对不碰本地缩略图
        } catch (e) {
          // 2. 网络图彻底失败报错（超时、代理挂、链接失效等），才去读本地图
          if (task.status === AriaStatus.Complete && task.dir && task.fileName) {
            try {
              const res = await getMediaThumbnail(task.media, task.post);
              if (!cancelled && res.src) setLocalSrc(res.src);
            } catch (err) {}
          }
        }
      };

      load();
      return () => { cancelled = true; };
    }, [task.gid, task.status]); // 只依赖 gid 和 status

    const finalSrc = remoteSrc || localSrc; // 这里优先显示网络图，如果网络图没拿到，就用本地图

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
    const { message, modal } = App.useApp();
    
    const { removeDownloadTask, pauseDownloadTask, unpauseDownloadTask, redownloadTask } = useDownloadStore(
      useShallow((s) => ({
        removeDownloadTask: s.removeDownloadTask,
        pauseDownloadTask: s.pauseDownloadTask,
        unpauseDownloadTask: s.unpauseDownloadTask,
        redownloadTask: s.redownloadTask,
      })),
    );

    const getFullPath = () => {
      const sep = t.dir.includes('\\') ? '\\' : '/';
      return t.dir.endsWith(sep) ? `${t.dir}${t.fileName}` : `${t.dir}${sep}${t.fileName}`;
    };

    const actionRedownload: TaskAction = {
      name: '重新下载',
      onClick: async () => {
        const hide = message.loading('正在重新添加下载任务...', 0);
        try {
          await redownloadTask(t.gid);
          hide();
          message.success('已开始重新下载该任务');
        } catch (err: any) {
          hide();
          window.log.error(err);
          message.error(`重新下载失败: ${err?.message || '未知错误'}`);
        }
      },
      icon: <DownloadOutlined />,
    };

    const actionPause: TaskAction = { 
      name: '暂停', 
      onClick: async () => {
        try { await pauseDownloadTask(t.gid); } catch(e) { message.error('暂停失败'); }
      }, 
      icon: <PauseOutlined />, 
      primary: true 
    };
    
    const actionUnpause: TaskAction = { 
      name: '继续', 
      onClick: async () => {
        try { await unpauseDownloadTask(t.gid); } catch(e) { message.error('继续失败'); }
      }, 
      icon: <CaretRightFilled />, 
      primary: true 
    };
    
    const actionDelete: TaskAction = {
      name: '删除',
      onClick: () => {
        modal.confirm({
          title: '确认删除该任务？',
          content: '已下载的文件不会被删除。',
          okText: '删除',
          okButtonProps: { danger: true },
          cancelText: '取消',
          onOk: async () => {
            try {
              await removeDownloadTask(t.gid);
              message.success('任务已移除');
            } catch (e) {
              message.error('删除任务失败');
            }
          }
        });
      },
      icon: <DeleteFilled />, 
      danger: true,
    };

    const actionOpen: TaskAction = {
      name: '打开',
      onClick: async () => {
        try {
          await shell.open(getFullPath());
        } catch (err: any) {
          window.log.error('打开文件失败', err);
          message.error(`文件可能已被移除或不存在`);
        }
      },
      icon: <FileFilled />, 
      primary: true,
    };

    const actionOpenDir: TaskAction = {
      name: '打开目录',
      onClick: async () => {
        try {
          await showInFolder(t.dir, false);
        } catch (err: any) {
          window.log.error('打开目录失败', err);
          message.error(`无法打开目录`);
        }
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