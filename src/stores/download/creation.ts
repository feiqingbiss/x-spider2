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
const MAX_QUEUE_SIZE = 50; // 队列最大长度，超过时暂停接受新任务
const UI_UPDATE_INTERVAL = 3; // 每处理完 N 个用户更新一次 UI

// 中止控制器映射
export const creationTaskAbortControllerMap = new Map<string, AbortController>();

// 预检函数
async function preCheckLocalExistence(
  user: TwitterUser,
): Promise<{ existRatio: number; totalMediaCount: number }> {
  perf.mark('preCheck-start');
  try {
    const { twitterPosts } = await getUserTweets(user.id, undefined, PRE_CHECK_COUNT);
    if (!twitterPosts.length) return { existRatio: 0, totalMediaCount: 0 };

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
    logFn('info', `预检结果: 存在 ${existCount}/${totalMediaCount}, 比例 ${existRatio}`);
    perf.measure('preCheck', 'preCheck-start', 'preCheck-end');
    return { existRatio, totalMediaCount };
  } catch (err) {
    logFn('error', '预检失败', err);
    perf.log('preCheck failed');
    return { existRatio: 0, totalMediaCount: 0 };
  }
}

// 核心创建任务执行
export async function runCreationTask(task: CreationTask, abortSignal: AbortSignal) {
  const taskId = task.id;
  perf.mark(`runTask-${taskId}-start`);

  const { filter, user } = task;
  const preCheckResult = await preCheckLocalExistence(user);
  let useMediaSource = false;
  if (preCheckResult.totalMediaCount > 0) {
    useMediaSource = preCheckResult.existRatio >= EXIST_RATIO_THRESHOLD;
    logFn('info', `预检决定使用 ${useMediaSource ? '媒体' : '帖子'} 源 (比例=${preCheckResult.existRatio})`);
  } else {
    useMediaSource = false;
    logFn('info', '预检无媒体数据，使用帖子源');
  }

  const source = useMediaSource ? 'medias' : 'tweets';
  const getListFn = useMediaSource ? getUserMedias : getUserTweets;

  logFn('info', `开始处理用户: ${user.screenName} (源: ${source})`);

  let completeCount = 0,
    skipCount = 0;
  let now = dayjs();
  const since = filter.dateRange?.[0] || dayjs.unix(0);
  const until = filter.dateRange?.[1] || now.clone();
  let nextCursor: string | undefined | null = undefined;
  let consecutiveSkippedPosts = 0,
    retriedInitialEmpty = false;
  let shouldUpdateUI = false;
  let processedUserCount = 0; // 累计处理用户数，用于降低 UI 更新频率

  while (nextCursor !== null && now.isAfter(since)) {
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

    if (!nextCursor && twitterPosts.length === 0 && !retriedInitialEmpty) {
      logFn('warn', '首次获取为空，重试');
      await delay(2000);
      retriedInitialEmpty = true;
      const retry = await getListFn(user.id, undefined);
      if (retry.twitterPosts.length === 0) {
        if (useMediaSource) {
          logFn('warn', `媒体源无结果，切换到帖子源重试`);
          const updatedTask: CreationTask = {
            ...task,
            filter: { ...filter, source: 'tweets' as const }
          };
          await runCreationTask(updatedTask, abortSignal);
          return;
        }
        const errMsg = `用户 ${user.screenName} 无帖子`;
        logFn('error', errMsg);
        throw new Error(errMsg);
      }
      nextCursor = retry.cursor;
      now = R.last(retry.twitterPosts)?.createdAt || now;
      continue;
    }

    nextCursor = cursor;
    now = R.last(twitterPosts)?.createdAt || now;
    const filteredPosts = twitterPosts.filter(
      (p) =>
        p.medias?.length &&
        (!since || !p.createdAt || p.createdAt.isAfter(since)) &&
        (!until || !p.createdAt || p.createdAt.isBefore(until)),
    );
    skipCount += twitterPosts.length - filteredPosts.length;

    if (filteredPosts.length === 0) {
      shouldUpdateUI = true;
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
          // 最终更新一次 UI
          useDownloadStore.getState().updateCreationTask({ ...task, completeCount, skipCount });
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
    }
    shouldUpdateUI = true;
    processedUserCount++;

    // 降低 UI 更新频率：每处理完 UI_UPDATE_INTERVAL 个用户或 shouldUpdateUI 为 true 时才更新
    if (shouldUpdateUI && processedUserCount % UI_UPDATE_INTERVAL === 0) {
      useDownloadStore.getState().updateCreationTask({ ...task, completeCount, skipCount });
      shouldUpdateUI = false;
    }
  }

  // 最终更新一次，确保进度准确
  useDownloadStore.getState().updateCreationTask({ ...task, completeCount, skipCount });

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

  // 检查队列是否过长，过长则等待
  if (creationTasks.length > MAX_QUEUE_SIZE) {
    logFn('warn', `创建任务队列过长 (${creationTasks.length} > ${MAX_QUEUE_SIZE})，等待中...`);
    setTimeout(scheduleCreationTasks, 2000);
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
  setTimeout(scheduleCreationTasks, 500);
}
// 首次启动调度器
setTimeout(scheduleCreationTasks, 10);