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

const MAX_ACTIVE_TASKS = 1;
const MIN_API_INTERVAL_MS = 2000;
const MAX_ADDITIONAL_DELAY_MS = 4000;
const RATE_LIMIT_WAIT_MS = 30000;
const PRE_CHECK_COUNT = 15;
const EXIST_RATIO_THRESHOLD = 0.5;
const UI_UPDATE_INTERVAL = 5; // 每处理5个用户更新一次UI
const RECENT_DAYS = 15; // 半个月

// 中止控制器映射
export const creationTaskAbortControllerMap = new Map<string, AbortController>();

// 获取名单文件路径
async function getListFilePath(): Promise<string> {
  const saveDirBase = useSettingsStore.getState().download.saveDirBase || await path.appDataDir();
  return await path.join(saveDirBase, 'search-user-name.txt');
}

// 从名单中移除用户（同步）
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
          .trim()
      )
      .filter((n) => n.length > 0 && n !== username);
    const newContent = names.map((u) => `https://x.com/${u}`).join('\n');
    await fs.writeTextFile(filePath, newContent);
    logFn('info', `已从名单移除用户: ${username}`);
  } catch (err) {
    logFn('error', `移除用户 ${username} 失败`, err);
  }
}

// 预检函数：返回存在比例、媒体总数、是否有最近15天推文
async function preCheckLocalExistence(
  user: TwitterUser,
): Promise<{ existRatio: number; totalMediaCount: number; hasRecentPosts: boolean }> {
  perf.mark('preCheck-start');
  try {
    const { twitterPosts } = await getUserTweets(user.id, undefined, PRE_CHECK_COUNT);
    if (!twitterPosts.length) {
      return { existRatio: 0, totalMediaCount: 0, hasRecentPosts: false };
    }

    // 检查是否有最近15天内的推文
    const fifteenDaysAgo = dayjs().subtract(RECENT_DAYS, 'day');
    const hasRecentPosts = twitterPosts.some(p => p.createdAt && p.createdAt.isAfter(fifteenDaysAgo));

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
          const dir = await path.join(settings.download.saveDirBase, resolvedDirName);
          const fileName = resolveVariables(settings.download.fileNameTemplate, templateData);
          const filePath = await path.join(dir, fileName);
          if (await fs.exists(filePath)) {
            existCount++;
          }
        } catch (e) {
          // ignore
        }
      }
    }

    const existRatio = totalMediaCount > 0 ? existCount / totalMediaCount : 0;
    logFn('info', `预检结果: 存在 ${existCount}/${totalMediaCount}, 比例 ${existRatio}, 最近15天有推文: ${hasRecentPosts}`);
    perf.measure('preCheck', 'preCheck-start', 'preCheck-end');
    return { existRatio, totalMediaCount, hasRecentPosts };
  } catch (err) {
    logFn('error', '预检失败', err);
    perf.log('preCheck failed');
    return { existRatio: 0, totalMediaCount: 0, hasRecentPosts: false };
  }
}

// 核心创建任务执行
export async function runCreationTask(task: CreationTask, abortSignal: AbortSignal) {
  const taskId = task.id;
  perf.mark(`runTask-${taskId}-start`);

  const { filter, user } = task;

  // ----- 1. 预检 -----
  const preCheckResult = await preCheckLocalExistence(user);

  // 判断是否应该跳过：如果存在比例 >= 阈值 且 有最近15天推文，且本地文件已覆盖最近推文，则可以跳过（但为了保险，除非用户明确要求，否则仍执行）
  // 我们改为：如果存在比例很高且最近推文都在本地，则快速跳过。但为了数据完整性，我们仍执行，只是可能很快完成。
  // 真正决定使用哪种源
  let useMediaSource = false;
  if (preCheckResult.totalMediaCount > 0 && preCheckResult.hasRecentPosts) {
    useMediaSource = preCheckResult.existRatio >= EXIST_RATIO_THRESHOLD;
    logFn('info', `预检决定使用 ${useMediaSource ? '媒体' : '帖子'} 源 (比例=${preCheckResult.existRatio})`);
  } else if (preCheckResult.totalMediaCount > 0 && !preCheckResult.hasRecentPosts) {
    // 有媒体但没有最近15天的推文，使用帖子源（慢但完整）
    useMediaSource = false;
    logFn('info', `用户无最近15天推文，使用帖子源 (总媒体=${preCheckResult.totalMediaCount})`);
  } else {
    useMediaSource = false;
    logFn('info', '预检无媒体数据，使用帖子源');
  }

  const source = useMediaSource ? 'medias' : 'tweets';
  const getListFn = useMediaSource ? getUserMedias : getUserTweets;

  logFn('info', `开始处理用户: ${user.screenName} (源: ${source})`);

  let completeCount = 0,
    skipCount = 0;
  let currentTime = dayjs();
  const since = filter.dateRange?.[0] || dayjs.unix(0);
  const until = filter.dateRange?.[1] || currentTime.clone();
  let nextCursor: string | undefined | null = undefined;
  let consecutiveSkippedPosts = 0,
    retriedInitialEmpty = false;
  let processedUserCount = 0;
  let shouldUpdateUI = false;

  while (nextCursor !== null && currentTime.isAfter(since)) {
    if (abortSignal.aborted) break;

    const delayMs = MIN_API_INTERVAL_MS + Math.floor(Math.random() * MAX_ADDITIONAL_DELAY_MS);
    await delay(delayMs);

    perf.mark(`api-${taskId}-start`);
    let resp;
    try {
      resp = await getListFn(user.id, nextCursor);
    } catch (apiErr: any) {
      const errMsg = typeof apiErr?.message === 'string' ? apiErr.message : String(apiErr);
      logFn('error', `API请求失败: ${errMsg}`);
      perf.log(`API failed: ${errMsg}`);
      if (errMsg.includes('expected value at line 1 column 1') || errMsg.includes('status=429')) {
        logFn('warn', `检测到 API 限流，等待 ${RATE_LIMIT_WAIT_MS / 1000} 秒后重试...`);
        antNotification.warning({
          message: '检测到 API 限流',
          description: `任务 ${user.screenName} 将在 ${RATE_LIMIT_WAIT_MS / 1000} 秒后重试`,
        });
        await delay(RATE_LIMIT_WAIT_MS);
        continue;
      }
      throw apiErr;
    }
    perf.measure(`api-${taskId}`, `api-${taskId}-start`, `api-${taskId}-end`);

    if (abortSignal.aborted) break;
    const { twitterPosts, cursor } = resp;
    logFn('info', `获得 ${twitterPosts.length} 条帖子, cursor=${cursor}`);

    // 处理首次为空
    if (!nextCursor && twitterPosts.length === 0 && !retriedInitialEmpty) {
      logFn('warn', '首次获取为空，重试');
      await delay(2000);
      retriedInitialEmpty = true;
      const retry = await getListFn(user.id, undefined);
      if (retry.twitterPosts.length === 0) {
        // 如果使用媒体源且无结果，尝试切换帖子源
        if (useMediaSource) {
          logFn('warn', `媒体源无结果，切换到帖子源重试`);
          const updatedTask: CreationTask = {
            ...task,
            filter: { ...filter, source: 'tweets' as const }
          };
          await runCreationTask(updatedTask, abortSignal);
          return;
        }
        // 帖子源也无结果 -> 用户无帖子，从名单移除（但先检查是否有最近推文）
        // 如果预检显示无媒体或无最近推文，则移除
        if (preCheckResult.totalMediaCount === 0 || !preCheckResult.hasRecentPosts) {
          logFn('error', `用户 ${user.screenName} 无有效帖子，从名单移除`);
          await removeUserFromList(user.screenName);
          throw new Error(`用户 ${user.screenName} 无帖子`);
        } else {
          // 有媒体但获取不到，可能是限制
          logFn('warn', `用户 ${user.screenName} 有媒体但无法获取，可能受限，保留名单但跳过本次`);
          // 不抛出错误，直接结束任务（无下载）
          break;
        }
      }
      nextCursor = retry.cursor;
      currentTime = R.last(retry.twitterPosts)?.createdAt || currentTime;
      continue;
    }

    nextCursor = cursor;
    currentTime = R.last(twitterPosts)?.createdAt || currentTime;
    const filteredPosts = twitterPosts.filter(
      (p) =>
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
        if (filter.mediaTypes && !filter.mediaTypes.includes(media.type)) continue;
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
            useDownloadStore.getState().updateCreationTask({ ...task, completeCount, skipCount });
          }
          perf.measure(`runTask-${taskId}`, `runTask-${taskId}-start`, `runTask-${taskId}-end`);
          return;
        }
      } else {
        consecutiveSkippedPosts = 0;
      }
    }

    if (paramsList.length) {
      perf.mark(`batchCreate-${taskId}-start`);
      await useDownloadStore.getState().batchCreateDownloadTask(paramsList);
      perf.measure(`batchCreate-${taskId}`, `batchCreate-${taskId}-start`, `batchCreate-${taskId}-end`);
      completeCount += paramsList.length;
      processedUserCount++;
      shouldUpdateUI = true;
    }

    // 降低 UI 更新频率：每处理完 UI_UPDATE_INTERVAL 个用户才更新
    if (shouldUpdateUI && processedUserCount % UI_UPDATE_INTERVAL === 0) {
      useDownloadStore.getState().updateCreationTask({ ...task, completeCount, skipCount });
      shouldUpdateUI = false;
    }
  }

  // 最终更新一次
  if (completeCount > 0 || skipCount > 0) {
    useDownloadStore.getState().updateCreationTask({ ...task, completeCount, skipCount });
  }

  logFn('info', `用户 ${user.screenName} 完成: 下载 ${completeCount}, 跳过 ${skipCount}`);
  antNotification.success({
    message: `${user.screenName} 完成`,
    description: `下载 ${completeCount}, 跳过 ${skipCount}`,
  });
  perf.measure(`runTask-${taskId}`, `runTask-${taskId}-start`, `runTask-${taskId}-end`);
}

// 调度器
export async function scheduleCreationTasks() {
  const state = useDownloadStore.getState();
  const { creationTasks } = state;

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
  setTimeout(scheduleCreationTasks, 500);
}
// 首次启动调度器
setTimeout(scheduleCreationTasks, 10);