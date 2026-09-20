import { DownloadFilter } from './DownloadFilter';
import { TwitterUser } from './TwitterUser';

// ✅ 新增：任务内部阶段
export type CreationPhase =
  | 'waiting'   // 等待调度
  | 'precheck'  // 预检（拉取前 20 条）
  | 'index'     // 媒体索引（分页拉 UserMedia）
  | 'tweets'    // 帖子源索引（分页拉 UserTweets）
  | 'creating'  // 创建下载任务
  | 'done';     // 完成

export interface CreationTask {
  id: string;
  user: TwitterUser;
  filter: DownloadFilter;
  status: 'waiting' | 'active';
  completeCount: number;
  skipCount: number;

  // ✅ 新增：阶段上报
  phase?: CreationPhase;
  phaseDetail?: string;
  indexedPosts?: number;
}