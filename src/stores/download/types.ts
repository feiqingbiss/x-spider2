import { TwitterPost } from '../../interfaces/TwitterPost';
import { TwitterMedia } from '../../interfaces/TwitterMedia';
import { DownloadTask } from '../../interfaces/DownloadTask';
import { CreationTask } from '../../interfaces/CreationTask';
import { TwitterUser } from '../../interfaces/TwitterUser';
import { DownloadFilter } from '../../interfaces/DownloadFilter';

export interface CreateDownloadTaskParams {
  post: TwitterPost;
  media: TwitterMedia;
}

export interface BatchProgress {
  total: number;
  completed: number;
  currentUser: string;
}

export interface DownloadStore {
  currentTab: string;
  setCurrentTab: (tab: string) => void;
  downloadTasks: DownloadTask[];
  autoSyncTaskIds: string[];
  setAutoSyncTaskIds: (ids: string[]) => void;
  createDownloadTask: (params: CreateDownloadTaskParams) => Promise<void>;
  batchCreateDownloadTask: (
    paramsList: CreateDownloadTaskParams[],
  ) => Promise<void>;
  pauseDownloadTask: (gid: string) => Promise<void>;
  pauseAllDownloadTask: () => Promise<void>;
  unpauseDownloadTask: (gid: string) => Promise<void>;
  unpauseAllDownloadTask: () => Promise<void>;
  removeDownloadTask: (gid: string) => Promise<void>;
  batchRemoveDownloadTasks: (gids: string[]) => Promise<void>;
  syncDownloadTaskStatus: (gid: string) => Promise<void>;
  updateDownloadTask: (task: DownloadTask, now?: number) => void;
  batchUpdateDownloadTasks: (tasks: DownloadTask[]) => void;
  redownloadTask: (gid: string) => Promise<void>;
  batchRedownloadTask: (gid: string[]) => Promise<void>;
  creationTasks: CreationTask[];
  createCreationTask: (user: TwitterUser, filter: DownloadFilter) => void;
  removeCreationTask: (id: string) => void;
  updateCreationTask: (task: CreationTask) => void;
  batchProgress: BatchProgress | null;
  setBatchProgress: (progress: BatchProgress | null) => void;

  // ✅ 批量下载的全局运行状态
  isBatchRunning: boolean;
  setIsBatchRunning: (v: boolean) => void;
  batchAbortController: AbortController | null;
  setBatchAbortController: (ctrl: AbortController | null) => void;

  // ✅ 本次下载会话涉及的用户集合（用于右环分母）
  //    - 单次下载：{ screenName }
  //    - 批量下载：整个名单的用户
  //    - 会话进行中时追加；会话结束后重置
  sessionUserNames: string[];
  addSessionUsers: (names: string[]) => void;
}