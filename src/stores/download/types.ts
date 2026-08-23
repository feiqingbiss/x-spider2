import { Dayjs } from 'dayjs';
import { AriaStatus } from '../../utils/aria2';
import { TwitterMedia } from '../../interfaces/TwitterMedia';
import { TwitterPost } from '../../interfaces/TwitterPost';
import { TwitterUser } from '../../interfaces/TwitterUser';
import { DownloadFilter } from '../../interfaces/DownloadFilter';
import { DownloadTask } from '../../interfaces/DownloadTask';
import { CreationTask } from '../../interfaces/CreationTask';

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
  batchCreateDownloadTask: (paramsList: CreateDownloadTaskParams[]) => Promise<void>;
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
}