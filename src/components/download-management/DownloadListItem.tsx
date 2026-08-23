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
import { App, Avatar, Progress } from 'antd';
import * as R from 'ramda';
import React, { memo, useState } from 'react';
import { DownloadTask } from '../../interfaces/DownloadTask';
import { useDownloadStore } from '../../stores/download';
import { buildPostUrl, buildUserUrl } from '../../twitter/url';
import { showInFolder } from '../../utils/shell';
import { StatusText } from './StatusText';
import { TaskAction, TaskActions } from './TaskActions';

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
    prev.completeSize === next.completeSize &&
    prev.totalSize === next.totalSize &&
    prev.error === next.error &&
    prev.fileName === next.fileName &&
    prev.updatedAt === next.updatedAt
  );
};

export const DownloadListItem: React.FC<DownloadListItemProps> = memo(
  ({ task: t, itemClientHeight }) => {
    const { message } = App.useApp();
    const [imageLoaded, setImageLoaded] = useState(false);

    const {
      removeDownloadTask,
      pauseDownloadTask,
      unpauseDownloadTask,
      redownloadTask,
    } = useDownloadStore((s) => ({
      removeDownloadTask: s.removeDownloadTask,
      pauseDownloadTask: s.pauseDownloadTask,
      unpauseDownloadTask: s.unpauseDownloadTask,
      batchRemoveDownloadTasks: s.batchRemoveDownloadTasks,
      redownloadTask: s.redownloadTask,
      batchRedownloadTask: s.batchRedownloadTask,
    }));

    const actionRedownload: TaskAction = {
      name: '重新下载',
      onClick: async () => {
        try {
          await redownloadTask(t.gid);
          message.success('已开始重新下载该任务');
        } catch (err) {
          log.error(err);
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

    const imgSrc = `${t.media.url}?format=jpg&name=thumb`;

    return (
      <div
        role="listitem"
        className="bg-white border-[1px] border-gray-300 rounded-md flex overflow-hidden"
      >
        {/* 左侧缩略图区域 */}
        <div
          className="shrink-0 overflow-hidden relative bg-gray-100"
          style={{
            width: itemClientHeight,
            height: itemClientHeight,
          }}
        >
          {/* 骨架占位（图片加载前显示） */}
          {!imageLoaded && (
            <div className="w-full h-full bg-gray-200 animate-pulse flex items-center justify-center text-gray-400 text-xs">
              加载中...
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
            <img
              src={imgSrc}
              loading="lazy"
              className={`w-full h-full object-cover transition-transform transform hover:scale-105 ${
                imageLoaded ? 'block' : 'hidden'
              }`}
              onLoad={() => setImageLoaded(true)}
              onError={() => setImageLoaded(true)} // 加载失败也显示占位
              alt="缩略图"
            />
          </a>
        </div>

        {/* 右侧信息区 */}
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
            title={`跳转到 ${t.post.user?.name || t.post.user?.screenName || '未知用户'} 的主页`}
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
              percent={Math.round((t.completeSize / t.totalSize) * 100)}
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
  areEqual
);