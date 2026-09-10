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
const PRE_CHECK_COUNT = 15;
const EXIST_RATIO_THRESHOLD = 0.5;
const UI_UPDATE_INTERVAL = 5; // 每处理5个用户更新一次UI
const RECENT_DAYS = 15; // 半个月

// ===================== API 限流器（全局） =====================
const MIN_API_INTERVAL_MS = 3500;      // 请求最小间隔（原 2000ms）
const MAX_JITTER_MS = 4000;             // 随机抖动上限
const BASE_RATE_LIMIT_WAIT_MS = 60000;  // 首次限流等待 60s
const MAX_COOLDOWN_MS = 5 * 60 * 1000;  // 最长冷却 5 分钟

let globalCooldownUntil = 0;   // 全局冷却截止时间
let lastApiCallTime = 0;       // 上次 API 调用时间
let rateLimitStreak = 0;       // 连续限流次数

async function waitForApiSlot(): Promise<void> {
  const now = Date.now();

  // 1. 如果处于全局冷却期，先等待
  if (now < globalCooldownUntil) {
    const waitMs = globalCooldownUntil - now;
    logFn('warn', `[限流] 全局冷却中，等待 ${Math.ceil(waitMs / 1000)} 秒...`);
    await delay(waitMs);
  }

  // 2. 保证与上一次 API 调用的最小间隔 + 随机抖动
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
    m.includes('too many requests')
  );
}

function recordRateLimit(): void {
  rateLimitStreak = Math.min(rateLimitStreak + 1, 5);
  // 指数退避：60s → 120s → 240s → 300s（上限）
  const cooldown = Math.min(
    BASE_RATE_LIMIT_WAIT_MS * Math.pow(2, rateLimitStreak - 1),
    MAX_COOLDOWN_MS,
  );
  setGlobalCooldown(cooldown);
  logFn('warn', `[限流] 连续限流 ${rateLimitStreak} 次，冷却 ${Math.ceil(cooldown / 1000)} 秒`);
}

function recordSuccess(): void {
  if (rateLimitStreak > 0) {
    logFn('info', `[限流] API 恢复正常，重置限流计数`);
    rateLimitStreak = 0;
  }
}

// ===================== 辅助函数 =====================
export const creationTaskAbortControllerMap = new Map<string, AbortController>();

async function getListFilePath(): Promise<string> {
  const saveDirBase =
    useSettingsStore.getState().download.saveDirBase || (await path.appDataDir());
  return await path.join(saveDirBase, 'search-user-name.txt');
}

async function removeUserFromList(username: string) {
  try {
    const filePath = await getListFilePath();
    let content = '';
    try {
      content = await fs.readTextFile(filePath);
    } catch (_) {}
    const names = content
      .split('\n')
      .map((line) =>
        line
          .replace(/^https?:\/\/x\.com\/?/i, '')
          .replace(/^@/, '')
          .trim(),
      )
      .filter((n) => n.length > 0 && n !== username);
    const newContent = names.map((u) => `https://x.com/${u}`).join('\n');
    await fs.writeTextFile(filePath, newContent);
    logFn('info', `已从名单移除用户: ${username}`);
  } catch (err) {
    logFn('error', `移除用户 ${username} 失败`, err);
  }
}

// 预检函数（带限流保护）
async function preCheckLocalExistence(
  user: TwitterUser,
): Promise<{
  existRatio: number;
  totalMediaCount: number;
  hasRecentPosts: boolean;
  firstPosts?: any;
  firstCursor?: string | null;
}> {
  perf.mark('preCheck-start');
  try {
    await waitForApiSlot();
    const { twitterPosts, cursor } = await getUserTweets(
      user.id,
      undefined,
      PRE_CHECK_COUNT,
    );
    recordSuccess();

    if (!twitterPosts.length) {
      return {
        existRatio: 0,
        totalMediaCount: 0,
        hasRecentPosts: false,
        firstPosts: [],
        firstCursor: cursor,
      };
    }

    const fifteenDaysAgo = dayjs().subtract(RECENT_DAYS, 'day');
    const hasRecentPosts = twitterPosts.some(
      (p) => p.createdAt && p.createdAt.isAfter(fifteenDaysAgo),
    );

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

    const existRatio =
      totalMediaCount > 0 ? existCount / totalMediaCount : 0;
    logFn(
      'info',
      `预检结果: 存在 ${existCount}/${totalMediaCount}, 比例 ${existRatio}, 最近15天有推文: ${hasRecentPosts}`,
    );
    perf.measure('preCheck', 'preCheck-start', 'preCheck-end');
    return {
      existRatio,
      totalMediaCount,
      hasRecentPosts,
      firstPosts: twitterPosts,
      firstCursor: cursor,
    };
  } catch (err: any) {
    const msg = err?.message || String(err);
    if (isRateLimitError(msg)) {
      recordRateLimit();
    }
    logFn('error', '预检失败', err);
    perf.log('preCheck failed');
    return { existRatio: 0, totalMediaCount: 0, hasRecentPosts: false };
  }
}

// ===================== 核心任务执行 =====================
export async function runCreationTask(
  task: CreationTask,
  abortSignal: AbortSignal,
) {
  const taskId = task.id;
  perf.mark(`runTask-${taskId}-start`);

  const { filter, user } = task;

  // ----- 1. 预检（复用预检数据，避免重复请求） -----
  const preCheckResult = await preCheckLocalExistence(user);

  let useMediaSource = false;
  if (preCheckResult.totalMediaCount > 0 && preCheckResult.hasRecentPosts) {
    useMediaSource = preCheckResult.existRatio >= EXIST_RATIO_THRESHOLD;
    logFn(
      'info',
      `预检决定使用 ${useMediaSource ? '媒体' : '帖子'} 源 (比例=${preCheckResult.existRatio})`,
    );
  } else if (preCheckResult.totalMediaCount > 0 && !preCheckResult.hasRecentPosts) {
    useMediaSource = false;
    logFn(
      'info',
      `用户无最近15天推文，使用帖子源 (总媒体=${preCheckResult.totalMediaCount})`,
    );
  } else {
    useMediaSource = false;
    logFn('info', '预检无媒体数据，使用帖子源');
  }

  const getListFn = useMediaSource ? getUserMedias : getUserTweets;
  logFn(
    'info',
    `开始处理用户: ${user.screenName} (源: ${useMediaSource ? '媒体' : '帖子'})`,
  );

  let completeCount = 0;
  let skipCount = 0;
  let currentTime = dayjs();
  const since = filter.dateRange?.[0] || dayjs.unix(0);
  const until = filter.dateRange?.[1] || currentTime.clone();
  let nextCursor: string | undefined | null = undefined;
  let consecutiveSkippedPosts = 0;
  let retriedInitialEmpty = false;
  let processedUserCount = 0;
  let shouldUpdateUI = false;

  // 复用预检数据：如果预检用的源与最终选择一致，则第一次直接使用
  let cachedPosts: any[] | undefined;
  let cachedCursor: string | null | undefined;
  const preCheckSourceIsTweets = !useMediaSource; // 预检总是用帖子源
  if (
    preCheckSourceIsTweets &&
    preCheckResult.firstPosts &&
    preCheckResult.firstPosts.length > 0
  ) {
    cachedPosts = preCheckResult.firstPosts;
    cachedCursor = preCheckResult.firstCursor;
    logFn('info', `复用预检数据 ${cachedPosts.length} 条帖子`);
  }

  while (nextCursor !== null && currentTime.isAfter(since)) {
    if (abortSignal.aborted) break;

    // ========== 等待 API 空闲槽位 ==========
    let resp;
    try {
      if (cachedPosts) {
        // 使用预检缓存数据
        resp = { twitterPosts: cachedPosts, cursor: cachedCursor ?? null };
        cachedPosts = undefined;
        cachedCursor = undefined;
      } else {
        await waitForApiSlot();
        perf.mark(`api-${taskId}-start`);
        resp = await getListFn(user.id, nextCursor);
        perf.measure(`api-${taskId}`, `api-${taskId}-start`, `api-${taskId}-end`);
        recordSuccess();
      }
    } catch (apiErr: any) {
      const errMsg =
        typeof apiErr?.message === 'string' ? apiErr.message : String(apiErr);
      logFn('error', `API请求失败: ${errMsg}`);
      perf.log(`API failed: ${errMsg}`);

      if (isRateLimitError(errMsg)) {
        // 记录限流，设置全局冷却，然后重试
        recordRateLimit();
        antNotification.warning({
          message: '检测到 API 限流',
          description: `将全局冷却后自动重试`,
        });
        continue; // 重试当前请求
      }
      throw apiErr;
    }

    if (abortSignal.aborted) break;
    const { twitterPosts, cursor } = resp;
    logFn('info', `获得 ${twitterPosts.length} 条帖子, cursor=${cursor}`);

    // 首次为空时重试
    if (!nextCursor && twitterPosts.length === 0 && !retriedInitialEmpty) {
      logFn('warn', '首次获取为空，重试');
      await delay(2000);
      retriedInitialEmpty = true;
      try {
        await waitForApiSlot();
        const retry = await getListFn(user.id, undefined);
        recordSuccess();
        if (retry.twitterPosts.length === 0) {
          if (useMediaSource) {
            logFn('warn', `媒体源无结果，切换到帖子源重试`);
            const updatedTask: CreationTask = {
              ...task,
              filter: { ...filter, source: 'tweets' as const },
            };
            await runCreationTask(updatedTask, abortSignal);
            return;
          }
          if (
            preCheckResult.totalMediaCount === 0 ||
            !preCheckResult.hasRecentPosts
          ) {
            logFn('error', `用户 ${user.screenName} 无有效帖子，从名单移除`);
            await removeUserFromList(user.screenName);
            throw new Error(`用户 ${user.screenName} 无帖子`);
          } else {
            logFn(
              'warn',
              `用户 ${user.screenName} 有媒体但无法获取，可能受限，保留名单但跳过本次`,
            );
            break;
          }
        }
        nextCursor = retry.cursor;
        currentTime = R.last(retry.twitterPosts)?.createdAt || currentTime;
        continue;
      } catch (retryErr: any) {
        const msg = retryErr?.message || String(retryErr);
        if (isRateLimitError(msg)) {
          recordRateLimit();
          continue;
        }
        throw retryErr;
      }
    }

    nextCursor = cursor;
    currentTime = R.last(twitterPosts)?.createdAt || currentTime;

    const filteredPosts = twitterPosts.filter(
      (p: any) =>
        p.medias?.length &&
        (!since || !p.createdAt || p.createdAt.isAfter(since)) &&
        (!until || !p.createdAt || p.createdAt.isBefore(until)),
    );
    skipCount += twitterPosts.length - filteredPosts.length;

    if (filteredPosts.length === 0) {
      continue;
    }

    const paramsList: CreateDownloadTaskParams[] = [];
    const settings = useSettingsStore.getState();
    for (const post of filteredPosts) {
      let postAdded = false;
      for (const media of post.medias!) {
        if (filter.mediaTypes && !filter.mediaTypes.includes(media.type))
          continue;
        try {
          const dlTask = await prepareDownloadTask({ post, media });
          const filePath = await path.join(dlTask.dir, dlTask.fileName);
          if (settings.download.sameFileSkip && (await fs.exists(filePath))) {
            skipCount++;
            continue;
          }
          paramsList.push({ media, post });
          postAdded = true;
        } catch (e: any) {
          logFn('error', `准备失败: ${e.message}`);
          skipCount++;
        }
      }
      if (!postAdded) {
        consecutiveSkippedPosts++;
        if (consecutiveSkippedPosts >= 10) {
          logFn('info', '连续跳过帖子达到阈值，提前结束');
          if (completeCount > 0 || skipCount > 0) {
            useDownloadStore
              .getState()
              .updateCreationTask({ ...task, completeCount, skipCount });
          }
          perf.measure(
            `runTask-${taskId}`,
            `runTask-${taskId}-start`,
            `runTask-${taskId}-end`,
          );
          return;
        }
      } else {
        consecutiveSkippedPosts = 0;
      }
    }

    if (paramsList.length) {
      perf.mark(`batchCreate-${taskId}-start`);
      await useDownloadStore.getState().batchCreateDownloadTask(paramsList);
      perf.measure(
        `batchCreate-${taskId}`,
        `batchCreate-${taskId}-start`,
        `batchCreate-${taskId}-end`,
      );
      completeCount += paramsList.length;
      processedUserCount++;
      shouldUpdateUI = true;
    }

    if (shouldUpdateUI && processedUserCount % UI_UPDATE_INTERVAL === 0) {
      useDownloadStore
        .getState()
        .updateCreationTask({ ...task, completeCount, skipCount });
      shouldUpdateUI = false;
    }
  }

  if (completeCount > 0 || skipCount > 0) {
    useDownloadStore
      .getState()
      .updateCreationTask({ ...task, completeCount, skipCount });
  }

  logFn(
    'info',
    `用户 ${user.screenName} 完成: 下载 ${completeCount}, 跳过 ${skipCount}`,
  );
  antNotification.success({
    message: `${user.screenName} 完成`,
    description: `下载 ${completeCount}, 跳过 ${skipCount}`,
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

  // 如果处于全局冷却期，等待冷却结束后再调度
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
  // 任务间隔拉长到 2 秒，进一步降低请求频率
  setTimeout(scheduleCreationTasks, 2000);
}

setTimeout(scheduleCreationTasks, 10);