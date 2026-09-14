import { fs, path } from '@tauri-apps/api';
import * as R from 'ramda';
import dayjs from 'dayjs';
import { notification as antNotification } from 'antd';
import { CreationTask } from '../../interfaces/CreationTask';
import { TwitterUser } from '../../interfaces/TwitterUser';
import { getUserMedias, getUserTweets } from '../../twitter/api';
import { useSettingsStore } from '../settings';
import { useDownloadStore } from './store';
import { prepareDownloadTask, logFn } from './utils';
import { perf } from './performance';
import { delay } from '../../utils';
import { resolveVariables } from '../../utils/file-name-template';
import { FileNameTemplateData } from '../../interfaces/FileNameTemplateData';
import { CreateDownloadTaskParams } from './types';

// ===================== 基础配置 =====================
const MAX_ACTIVE_TASKS = 1;
const PRE_CHECK_COUNT = 20;              // 预检前 20 条
const SKIP_DOWNLOAD_RATIO = 0.8;         // 已下载比例 ≥ 80% 则只补全缺少的
const ENABLE_DUAL_SOURCE_SCAN = true;    // 全量索引时启用双源

// ===================== API 限流器（全局） =====================
const MIN_API_INTERVAL_MS = 7000;
const MAX_JITTER_MS = 3000;
const BASE_RATE_LIMIT_WAIT_MS = 120000;
const MAX_COOLDOWN_MS = 10 * 60 * 1000;
const SUCCESS_THRESHOLD = 5;
const WARMUP_COOLDOWN_MS = 60000;

// 限流提示节流（1 分钟最多提示一次）
const RATE_LIMIT_NOTIFY_INTERVAL = 60000;
let lastRateLimitNotifyTime = 0;

let globalCooldownUntil = 0;
let lastApiCallTime = 0;
let rateLimitStreak = 0;
let successStreak = 0;

async function waitForApiSlot(): Promise<void> {
  const now = Date.now();
  if (now < globalCooldownUntil) {
    const waitMs = globalCooldownUntil - now;
    logFn('warn', `[限流] 全局冷却中，等待 ${Math.ceil(waitMs / 1000)} 秒...`);
    await delay(waitMs);
  }
  const sinceLast = Date.now() - lastApiCallTime;
  const needWait = MIN_API_INTERVAL_MS - sinceLast;
  if (needWait > 0) {
    const jitter = Math.floor(Math.random() * MAX_JITTER_MS);
    await delay(needWait + jitter);
  }
  lastApiCallTime = Date.now();
}

function setGlobalCooldown(ms: number): void {
  const until = Date.now() + Math.min(ms, MAX_COOLDOWN_MS);
  if (until > globalCooldownUntil) {
    globalCooldownUntil = until;
    logFn('warn', `[限流] 设置全局冷却 ${Math.ceil(ms / 1000)} 秒`);
  }
}

function isRateLimitError(msg: string): boolean {
  const m = msg.toLowerCase();
  return (
    m.includes('status=429') ||
    m.includes('expected value at line 1 column 1') ||
    m.includes('rate limit') ||
    m.includes('too many requests') ||
    m.includes('error decoding response body')
  );
}

function recordRateLimit(): void {
  rateLimitStreak = Math.min(rateLimitStreak + 1, 6);
  successStreak = 0;
  const cooldown = Math.min(
    BASE_RATE_LIMIT_WAIT_MS * Math.pow(2, rateLimitStreak - 1),
    MAX_COOLDOWN_MS,
  );
  setGlobalCooldown(cooldown);
  logFn(
    'warn',
    `[限流] 连续限流 ${rateLimitStreak} 次，冷却 ${Math.ceil(cooldown / 1000)} 秒`,
  );
}

function recordSuccess(): void {
  successStreak++;
  if (successStreak >= SUCCESS_THRESHOLD && rateLimitStreak > 0) {
    logFn('info', `[限流] 连续成功 ${successStreak} 次，重置限流计数`);
    rateLimitStreak = 0;
    successStreak = 0;
    setGlobalCooldown(WARMUP_COOLDOWN_MS);
  }
}

function notifyRateLimitOnce(cooldownSeconds: number) {
  const now = Date.now();
  if (now - lastRateLimitNotifyTime < RATE_LIMIT_NOTIFY_INTERVAL) return;
  lastRateLimitNotifyTime = now;
  antNotification.warning({
    message: '请求过于频繁',
    description: `已自动暂停约 ${cooldownSeconds} 秒后继续`,
    duration: 5,
  });
}

// ===================== 辅助函数 =====================
export const creationTaskAbortControllerMap = new Map<string, AbortController>();

interface PreCheckResult {
  success: boolean;
  existCount: number;
  totalMediaCount: number;
  ratio: number;
  cache: { posts: any[]; cursor: string | null } | null;
  missingTasks: CreateDownloadTaskParams[];  // 预检范围内缺失的媒体任务
}

// 计算某个帖子列表里有多少媒体已下载，并收集缺失的
async function analyzePosts(
  posts: any[],
  filter: CreationTask['filter'],
  seenMediaIds?: Set<string>,
): Promise<{
  existCount: number;
  totalMediaCount: number;
  missingTasks: CreateDownloadTaskParams[];
}> {
  const settings = useSettingsStore.getState();
  const since = filter.dateRange?.[0] || dayjs.unix(0);
  const until = filter.dateRange?.[1] || dayjs();

  let existCount = 0;
  let totalMediaCount = 0;
  const missingTasks: CreateDownloadTaskParams[] = [];

  for (const post of posts) {
    if (!post.medias?.length) continue;
    // 时间范围过滤
    if (post.createdAt) {
      if (post.createdAt.isBefore(since) || post.createdAt.isAfter(until)) {
        continue;
      }
    }
    for (const media of post.medias) {
      if (filter.mediaTypes && !filter.mediaTypes.includes(media.type)) {
        continue;
      }
      const mediaId = media.id || `${post.id}-${media.url}`;
      if (seenMediaIds) {
        if (seenMediaIds.has(mediaId)) continue;
        seenMediaIds.add(mediaId);
      }
      totalMediaCount++;
      try {
        const templateData: FileNameTemplateData = { media, post };
        const resolvedDirName = settings.download.dirTemplate
          ? resolveVariables(settings.download.dirTemplate, templateData)
          : '';
        const dir = await path.join(
          settings.download.saveDirBase,
          resolvedDirName,
        );
        const fileName = resolveVariables(
          settings.download.fileNameTemplate,
          templateData,
        );
        const filePath = await path.join(dir, fileName);
        if (await fs.exists(filePath)) {
          existCount++;
        } else {
          missingTasks.push({ media, post });
        }
      } catch (e) {
        // ignore
      }
    }
  }

  return { existCount, totalMediaCount, missingTasks };
}

// 预检：抓取前 PRE_CHECK_COUNT 条媒体，判断已下载比例
async function preCheckWithMedias(
  user: TwitterUser,
  filter: CreationTask['filter'],
): Promise<PreCheckResult> {
  perf.mark('preCheck-start');
  try {
    await waitForApiSlot();
    const { twitterPosts, cursor } = await getUserMedias(
      user.id,
      undefined,
      PRE_CHECK_COUNT,
    );
    recordSuccess();

    if (!twitterPosts.length) {
      logFn('info', `预检: 用户 ${user.screenName} 无媒体`);
      return {
        success: true,
        existCount: 0,
        totalMediaCount: 0,
        ratio: 0,
        cache: { posts: [], cursor: cursor ?? null },
        missingTasks: [],
      };
    }

    const { existCount, totalMediaCount, missingTasks } = await analyzePosts(
      twitterPosts,
      filter,
    );
    const ratio = totalMediaCount > 0 ? existCount / totalMediaCount : 0;

    logFn(
      'info',
      `预检: 前 ${twitterPosts.length} 条帖, 已下载 ${existCount}/${totalMediaCount} (${(ratio * 100).toFixed(1)}%), 缺失 ${missingTasks.length}`,
    );
    perf.measure('preCheck', 'preCheck-start', 'preCheck-end');
    return {
      success: true,
      existCount,
      totalMediaCount,
      ratio,
      cache: { posts: twitterPosts, cursor: cursor ?? null },
      missingTasks,
    };
  } catch (err: any) {
    const msg = err?.message || String(err);
    if (isRateLimitError(msg)) {
      recordRateLimit();
      notifyRateLimitOnce(Math.ceil((globalCooldownUntil - Date.now()) / 1000));
    }
    logFn('error', `预检失败 (用户 ${user.screenName})`, err);
    perf.log('preCheck failed');
    return {
      success: false,
      existCount: 0,
      totalMediaCount: 0,
      ratio: 0,
      cache: null,
      missingTasks: [],
    };
  }
}

// 单个源的索引
interface IndexResult {
  tasks: CreateDownloadTaskParams[];
  skipCount: number;
  success: boolean;
}

async function indexBySource(
  user: TwitterUser,
  source: 'medias' | 'tweets',
  filter: CreationTask['filter'],
  abortSignal: AbortSignal,
  seenMediaIds: Set<string>,
  initialPosts: any[] = [],
  initialCursor: string | null | undefined = undefined,
): Promise<IndexResult> {
  const getListFn = source === 'medias' ? getUserMedias : getUserTweets;
  const since = filter.dateRange?.[0] || dayjs.unix(0);
  const until = filter.dateRange?.[1] || dayjs();

  const tasks: CreateDownloadTaskParams[] = [];
  let skipCount = 0;

  const processPosts = async (posts: any[]): Promise<void> => {
    const filteredPosts = posts.filter(
      (p: any) =>
        p.medias?.length &&
        (!p.createdAt || p.createdAt.isAfter(since)) &&
        (!p.createdAt || p.createdAt.isBefore(until)),
    );
    skipCount += posts.length - filteredPosts.length;

    const settings = useSettingsStore.getState();
    for (const post of filteredPosts) {
      for (const media of post.medias!) {
        if (filter.mediaTypes && !filter.mediaTypes.includes(media.type))
          continue;
        const mediaId = media.id || `${post.id}-${media.url}`;
        if (seenMediaIds.has(mediaId)) continue;
        seenMediaIds.add(mediaId);
        try {
          const dlTask = await prepareDownloadTask({ post, media });
          const filePath = await path.join(dlTask.dir, dlTask.fileName);
          if (settings.download.sameFileSkip && (await fs.exists(filePath))) {
            skipCount++;
            continue;
          }
          tasks.push({ media, post });
        } catch (e: any) {
          logFn('error', `准备失败: ${e.message}`);
          skipCount++;
        }
      }
    }
  };

  if (initialPosts.length > 0) {
    await processPosts(initialPosts);
  }

  let cursor: string | null | undefined = initialCursor;
  let currentTime =
    initialPosts.length > 0
      ? R.last(initialPosts)?.createdAt || dayjs()
      : dayjs();

  while (cursor && !currentTime.isBefore(since)) {
    if (abortSignal.aborted) return { tasks, skipCount, success: false };

    await waitForApiSlot();
    perf.mark(`api-${user.id}-${source}-start`);
    let resp;
    try {
      resp = await getListFn(user.id, cursor);
      perf.measure(
        `api-${user.id}-${source}`,
        `api-${user.id}-${source}-start`,
        `api-${user.id}-${source}-end`,
      );
      recordSuccess();
    } catch (apiErr: any) {
      const errMsg =
        typeof apiErr?.message === 'string' ? apiErr.message : String(apiErr);
      logFn('error', `[${source}] API请求失败: ${errMsg}`);
      if (isRateLimitError(errMsg)) {
        recordRateLimit();
        notifyRateLimitOnce(
          Math.ceil((globalCooldownUntil - Date.now()) / 1000),
        );
        continue;
      }
      throw apiErr;
    }

    const posts = resp.twitterPosts;
    if (posts.length > 0) {
      await processPosts(posts);
      const last = R.last(posts)?.createdAt;
      if (last) currentTime = last;
    }
    cursor = resp.cursor;
  }

  logFn(
    'info',
    `[${source}] 索引完成: 待下载 ${tasks.length}, 跳过 ${skipCount}`,
  );
  return { tasks, skipCount, success: true };
}

// ===================== 核心任务执行 =====================
export async function runCreationTask(
  task: CreationTask,
  abortSignal: AbortSignal,
) {
  const taskId = task.id;
  perf.mark(`runTask-${taskId}-start`);

  const { filter, user } = task;

  // 预检
  const preCheckResult = await preCheckWithMedias(user, filter);

  if (!preCheckResult.success) {
    logFn('warn', `用户 ${user.screenName} 预检失败，本次跳过`);
    return;
  }

  if (preCheckResult.totalMediaCount === 0) {
    logFn('info', `用户 ${user.screenName} 无媒体，跳过`);
    return;
  }

  const ratioPercent = (preCheckResult.ratio * 100).toFixed(0);
  const seenMediaIds = new Set<string>();
  const allTasks: CreateDownloadTaskParams[] = [];
  let totalSkip = 0;

  if (preCheckResult.ratio >= SKIP_DOWNLOAD_RATIO) {
    // ===== 场景 A：已下载 ≥ 80%，只补全预检范围内的缺失 =====
    logFn(
      'info',
      `用户 ${user.screenName} 前 ${PRE_CHECK_COUNT} 条已下载 ${ratioPercent}% (≥${SKIP_DOWNLOAD_RATIO * 100}%)，仅补全缺失的 ${preCheckResult.missingTasks.length} 个媒体`,
    );
    // 添加到去重集合
    for (const t of preCheckResult.missingTasks) {
      const mediaId = t.media.id || `${t.post.id}-${t.media.url}`;
      seenMediaIds.add(mediaId);
      allTasks.push(t);
    }
    totalSkip = preCheckResult.existCount;
  } else {
    // ===== 场景 B：< 80%，全量遍历 =====
    logFn(
      'info',
      `用户 ${user.screenName} 前 ${PRE_CHECK_COUNT} 条仅 ${ratioPercent}% 已下载 (<${SKIP_DOWNLOAD_RATIO * 100}%)，开始全量索引`,
    );

    // 媒体源（复用预检数据）
    const mediaIndex = await indexBySource(
      user,
      'medias',
      filter,
      abortSignal,
      seenMediaIds,
      preCheckResult.cache?.posts || [],
      preCheckResult.cache?.cursor ?? undefined,
    );
    allTasks.push(...mediaIndex.tasks);
    totalSkip += mediaIndex.skipCount;

    // 帖子源（补齐媒体源遗漏）
    if (ENABLE_DUAL_SOURCE_SCAN) {
      logFn('info', `用户 ${user.screenName} 开始帖子源索引`);
      const tweetsIndex = await indexBySource(
        user,
        'tweets',
        filter,
        abortSignal,
        seenMediaIds,
      );
      allTasks.push(...tweetsIndex.tasks);
      totalSkip += tweetsIndex.skipCount;
    }
  }

  // 一次性创建下载任务
  if (allTasks.length) {
    perf.mark(`batchCreate-${taskId}-start`);
    await useDownloadStore.getState().batchCreateDownloadTask(allTasks);
    perf.measure(
      `batchCreate-${taskId}`,
      `batchCreate-${taskId}-start`,
      `batchCreate-${taskId}-end`,
    );
  }

  useDownloadStore.getState().updateCreationTask({
    ...task,
    completeCount: allTasks.length,
    skipCount: totalSkip,
  });

  logFn(
    'info',
    `用户 ${user.screenName} 完成: 新增 ${allTasks.length}, 跳过 ${totalSkip}`,
  );
  antNotification.success({
    message: `${user.screenName} 完成`,
    description: `新增 ${allTasks.length}, 跳过 ${totalSkip}`,
    duration: 3,
  });
  perf.measure(
    `runTask-${taskId}`,
    `runTask-${taskId}-start`,
    `runTask-${taskId}-end`,
  );
}

// ===================== 调度器 =====================
export async function scheduleCreationTasks() {
  const state = useDownloadStore.getState();
  const { creationTasks } = state;

  if (Date.now() < globalCooldownUntil) {
    const waitMs = globalCooldownUntil - Date.now() + 500;
    setTimeout(scheduleCreationTasks, Math.min(waitMs, 30000));
    return;
  }

  const active = creationTasks.filter((t) => t.status === 'active').length;
  if (active >= MAX_ACTIVE_TASKS) {
    setTimeout(scheduleCreationTasks, 1000);
    return;
  }
  const nextTask = creationTasks.find((t) => t.status === 'waiting');
  if (!nextTask) {
    setTimeout(scheduleCreationTasks, 1000);
    return;
  }
  const ctrl = creationTaskAbortControllerMap.get(nextTask.id);
  if (!ctrl || ctrl.signal.aborted) {
    state.removeCreationTask(nextTask.id);
    setTimeout(scheduleCreationTasks, 500);
    return;
  }
  state.updateCreationTask({ ...nextTask, status: 'active' });
  try {
    await runCreationTask(nextTask, ctrl.signal);
  } catch (err: any) {
    const errMsg = typeof err?.message === 'string' ? err.message : String(err);
    logFn('error', `任务最终失败: ${errMsg}`);
    if (!isRateLimitError(errMsg)) {
      antNotification.error({
        message: '任务失败',
        description: '请检查网络或稍后重试',
        duration: 3,
      });
    }
  } finally {
    state.removeCreationTask(nextTask.id);
  }
  setTimeout(scheduleCreationTasks, 2000);
}

setTimeout(scheduleCreationTasks, 10);