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
const PRE_CHECK_COUNT = 20;
// 是否启用双源索引（媒体源 + 帖子源）以最大程度保证完整
// true: 慢但完整；false: 只用媒体源（与主页一致）
const ENABLE_DUAL_SOURCE_SCAN = true;

// ===================== API 限流器（全局） =====================
const MIN_API_INTERVAL_MS = 7000;            // 请求最小间隔 7 秒
const MAX_JITTER_MS = 3000;                  // 随机抖动上限 3 秒
const BASE_RATE_LIMIT_WAIT_MS = 120000;      // 首次限流 2 分钟
const MAX_COOLDOWN_MS = 10 * 60 * 1000;      // 上限 10 分钟
const SUCCESS_THRESHOLD = 5;                 // 连续成功 5 次才重置
const WARMUP_COOLDOWN_MS = 60000;            // 恢复后温启动 1 分钟

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

// ===================== 辅助函数 =====================
export const creationTaskAbortControllerMap = new Map<string, AbortController>();

interface PreCheckResult {
  success: boolean;
  existCount: number;
  totalMediaCount: number;
  allExist: boolean;
  firstPosts: any[];
  firstCursor: string | null;
}

// 预检：媒体源，判断第一页是否全部下载
async function preCheckWithMedias(user: TwitterUser): Promise<PreCheckResult> {
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
      logFn('info', `预检（媒体源）: 用户 ${user.screenName} 无媒体`);
      return {
        success: true,
        existCount: 0,
        totalMediaCount: 0,
        allExist: false,
        firstPosts: [],
        firstCursor: cursor ?? null,
      };
    }

    const settings = useSettingsStore.getState();
    let existCount = 0;
    let totalMediaCount = 0;

    for (const post of twitterPosts) {
      if (!post.medias?.length) continue;
      for (const media of post.medias) {
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
          }
        } catch (e) {
          // ignore
        }
      }
    }

    const allExist = totalMediaCount > 0 && existCount === totalMediaCount;
    logFn(
      'info',
      `预检（媒体源）: 存在 ${existCount}/${totalMediaCount}, 全部已下载: ${allExist}`,
    );
    perf.measure('preCheck', 'preCheck-start', 'preCheck-end');
    return {
      success: true,
      existCount,
      totalMediaCount,
      allExist,
      firstPosts: twitterPosts,
      firstCursor: cursor ?? null,
    };
  } catch (err: any) {
    const msg = err?.message || String(err);
    if (isRateLimitError(msg)) {
      recordRateLimit();
    }
    logFn('error', `预检失败 (用户 ${user.screenName})`, err);
    perf.log('preCheck failed');
    return {
      success: false,
      existCount: 0,
      totalMediaCount: 0,
      allExist: false,
      firstPosts: [],
      firstCursor: null,
    };
  }
}

// 单个源的索引：返回未下载的任务列表 + 跳过数量
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
  firstPage?: { posts: any[]; cursor: string | null | undefined },
): Promise<IndexResult> {
  const getListFn = source === 'medias' ? getUserMedias : getUserTweets;
  const taskId = user.id;

  const since = filter.dateRange?.[0] || dayjs.unix(0);
  const until = filter.dateRange?.[1] || dayjs();

  const tasks: CreateDownloadTaskParams[] = [];
  let skipCount = 0;

  let currentPosts = firstPage?.posts ?? [];
  let nextCursor: string | null | undefined = firstPage
    ? firstPage.cursor
    : undefined;
  let isFirstPage = !!firstPage;
  let currentTime = dayjs();

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (abortSignal.aborted) return { tasks, skipCount, success: false };

    if (!isFirstPage) {
      if (!nextCursor) break;
      if (currentTime.isBefore(since)) {
        logFn('info', `[${source}] 已到达时间范围起点，停止翻页`);
        break;
      }
      try {
        await waitForApiSlot();
        perf.mark(`api-${taskId}-${source}-start`);
        const resp = await getListFn(user.id, nextCursor);
        perf.measure(
          `api-${taskId}-${source}`,
          `api-${taskId}-${source}-start`,
          `api-${taskId}-${source}-end`,
        );
        recordSuccess();
        currentPosts = resp.twitterPosts;
        nextCursor = resp.cursor;
      } catch (apiErr: any) {
        const errMsg =
          typeof apiErr?.message === 'string'
            ? apiErr.message
            : String(apiErr);
        logFn('error', `[${source}] API请求失败: ${errMsg}`);
        perf.log(`API failed: ${errMsg}`);
        if (isRateLimitError(errMsg)) {
          recordRateLimit();
          antNotification.warning({
            message: '检测到 API 限流',
            description: `将全局冷却后自动重试`,
          });
          continue;
        }
        throw apiErr;
      }
    }
    isFirstPage = false;

    if (!currentPosts.length) {
      if (!nextCursor) break;
      continue;
    }

    const lastPostDate = R.last(currentPosts)?.createdAt;
    if (lastPostDate) {
      currentTime = lastPostDate;
    }

    const filteredPosts = currentPosts.filter(
      (p: any) =>
        p.medias?.length &&
        (!p.createdAt || p.createdAt.isAfter(since)) &&
        (!p.createdAt || p.createdAt.isBefore(until)),
    );
    skipCount += currentPosts.length - filteredPosts.length;

    const settings = useSettingsStore.getState();
    for (const post of filteredPosts) {
      for (const media of post.medias!) {
        if (filter.mediaTypes && !filter.mediaTypes.includes(media.type))
          continue;
        const mediaId = media.id || `${post.id}-${media.url}`;
        if (seenMediaIds.has(mediaId)) {
          continue;
        }
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

    if (!nextCursor) break;
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

  const preCheckResult = await preCheckWithMedias(user);

  if (!preCheckResult.success) {
    logFn(
      'warn',
      `用户 ${user.screenName} 预检失败（可能限流），本次跳过，保留用户`,
    );
    return;
  }

  if (preCheckResult.totalMediaCount === 0) {
    logFn('info', `用户 ${user.screenName} 无媒体，跳过`);
    return;
  }

  if (preCheckResult.allExist) {
    logFn(
      'info',
      `用户 ${user.screenName} 第一页 ${preCheckResult.totalMediaCount} 个媒体已全部下载，跳过`,
    );
    return;
  }

  logFn(
    'info',
    `用户 ${user.screenName} 存在未下载媒体（${preCheckResult.existCount}/${preCheckResult.totalMediaCount}），开始索引`,
  );

  const seenMediaIds = new Set<string>();
  const allTasks: CreateDownloadTaskParams[] = [];
  let totalSkip = 0;

  const mediaIndex = await indexBySource(
    user,
    'medias',
    filter,
    abortSignal,
    seenMediaIds,
    {
      posts: preCheckResult.firstPosts,
      cursor: preCheckResult.firstCursor,
    },
  );
  allTasks.push(...mediaIndex.tasks);
  totalSkip += mediaIndex.skipCount;

  if (ENABLE_DUAL_SOURCE_SCAN) {
    logFn(
      'info',
      `用户 ${user.screenName} 开始帖子源索引（补齐媒体源可能遗漏的内容）`,
    );
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

  if (allTasks.length) {
    perf.mark(`batchCreate-${taskId}-start`);
    await useDownloadStore.getState().batchCreateDownloadTask(allTasks);
    perf.measure(
      `batchCreate-${taskId}`,
      `batchCreate-${taskId}-start`,
      `batchCreate-${taskId}-end`,
    );
  }

  useDownloadStore
    .getState()
    .updateCreationTask({
      ...task,
      completeCount: allTasks.length,
      skipCount: totalSkip,
    });

  logFn(
    'info',
    `用户 ${user.screenName} 完成: 新增下载 ${allTasks.length}, 跳过 ${totalSkip}${ENABLE_DUAL_SOURCE_SCAN ? '（双源索引）' : ''}`,
  );
  antNotification.success({
    message: `${user.screenName} 完成`,
    description: `新增下载 ${allTasks.length}, 跳过 ${totalSkip}`,
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
    antNotification.error({ message: '任务失败', description: errMsg });
  } finally {
    state.removeCreationTask(nextTask.id);
  }
  setTimeout(scheduleCreationTasks, 2000);
}

setTimeout(scheduleCreationTasks, 10);