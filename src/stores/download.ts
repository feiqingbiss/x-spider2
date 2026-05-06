async function runCreationTask(task: CreationTask, abortSignal: AbortSignal) {
  log().info('Run creation task', task);
  const { filter, user } = task;

  const { batchCreateDownloadTask, updateCreationTask } =
    useDownloadStore.getState();
  const settings = useSettingsStore.getState();

  let completeCount = 0;
  let skipCount = 0;

  let now = dayjs();
  const since = filter.dateRange?.[0] || dayjs.unix(0);
  const until = filter.dateRange?.[1] || now.clone();
  let nextCursor: string | undefined | null = undefined;

  const getListFn = filter.source === 'medias' ? getUserMedias : getUserTweets;

  const getMediaCounts = R.reduce((acc: number, elem: TwitterPost) => {
    return acc + (elem.medias?.length || 0);
  }, 0);

  while (nextCursor !== null && now.isAfter(since)) {
    if (abortSignal.aborted) {
      return;
    }

    log().info('CreationTask fetching', nextCursor);
    const { twitterPosts, cursor } = await getListFn(user.id, nextCursor);
    if (abortSignal.aborted) break;
    nextCursor = cursor;
    now = R.last(twitterPosts)?.createdAt || now;
    log().info('Now', now.format('YYYY-MM-DD'), 'next cursor', nextCursor);
    const filteredPosts = twitterPosts.filter(
      R.allPass([
        (post) => (post.medias ? post.medias.length >= 0 : false),
        (post) => {
          if (!post.createdAt) return true;
          return until ? post.createdAt.isBefore(until) : true;
        },
        (post) => {
          if (!post.createdAt) return true;
          return since ? post.createdAt.isAfter(since) : true;
        },
      ]),
    );

    const filteredCount =
      getMediaCounts(twitterPosts) - getMediaCounts(filteredPosts);
    skipCount += filteredCount;
    log().info('FilteredPosts', filteredPosts);

    if (filteredPosts.length === 0) {
      updateCreationTask({
        ...task,
        completeCount,
        skipCount,
      });
      continue;
    }

    const paramsList: CreateDownloadTaskParams[] = [];
    let consecutiveSkipCount = 0; // 连续因文件已存在而跳过的计数

    for (const post of filteredPosts) {
      const filteredMedias = post.medias!.filter(
        R.allPass([
          (media) => {
            if (!filter.mediaTypes) return false;
            return filter.mediaTypes.includes(media.type);
          },
        ]),
      );

      log().info('FilteredMedias', filteredMedias);
      for (const media of filteredMedias) {
        const downloadTask = await prepareDownloadTask({ post, media }); // 重命名内部变量
        log().info('Prepared download task', downloadTask);
        const filePath = await path.join(downloadTask.dir, downloadTask.fileName);
        log().info('Resolved file path', filePath);
        if (settings.download.sameFileSkip && (await fs.exists(filePath))) {
          skipCount++;
          consecutiveSkipCount++;
          log().info('Skip because sameFileSkip', media);
          // 连续跳过达到阈值，认为更旧的都已下载，准备提前结束
          if (consecutiveSkipCount >= CONSECUTIVE_SKIP_THRESHOLD) {
            log().info(
              `连续跳过 ${consecutiveSkipCount} 个已存在文件，提前结束用户 ${user.screenName} 的任务`,
            );
            // 使用外部的 task (CreationTask) 更新状态
            updateCreationTask({
              ...task,
              completeCount,
              skipCount,
            });
            return; // 直接结束 runCreationTask
          }
          continue;
        }
        // 有新文件需要下载，重置连续跳过计数
        consecutiveSkipCount = 0;
        paramsList.push({
          media,
          post,
        });
      }
    }

    log().info('Params', paramsList);

    if (paramsList.length === 0) {
      updateCreationTask({
        ...task,
        completeCount,
        skipCount,
      });
      continue;
    }

    await batchCreateDownloadTask(paramsList);
    completeCount += paramsList.length;
    updateCreationTask({
      ...task,
      completeCount,
      skipCount,
    });

    if (abortSignal.aborted) break;
  }
}