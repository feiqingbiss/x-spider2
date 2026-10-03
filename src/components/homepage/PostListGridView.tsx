/* eslint-disable react/prop-types */
import { LoadingOutlined, PictureOutlined } from '@ant-design/icons';
import { App } from 'antd';
import dayjs from 'dayjs';
import * as R from 'ramda';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import MediaType from '../../enums/MediaType';
import { TwitterMedia } from '../../interfaces/TwitterMedia';
import { TwitterPost } from '../../interfaces/TwitterPost';
import { useDownloadStore } from '../../stores/download';
import { useHomepageStore } from '../../stores/homepage';
import { buildPostUrl } from '../../twitter/url';
import { InfiniteScroll } from '../InfiniteScroll';
import { GridViewItemAction, GridViewItemActions } from './GridViewItemActions';

// ✅ 紧急止血：限制最大渲染数量，防止 2000+ 媒体导致 DOM 爆炸
const MAX_RENDER_MEDIA = 500;

// ✅ 缩略图组件：优先走后端代理下载并缓存，失败时显示占位图
const MediaThumbnail: React.FC<{ url?: string; mediaId?: string }> = ({
  url,
  mediaId,
}) => {
  const [hasError, setHasError] = useState(false);

  // 如果 API 没返回 url，用 mediaId 拼接官方备用地址
  let finalUrl = url;
  if (!finalUrl && mediaId) {
    finalUrl = `https://pbs.twimg.com/media/${mediaId}?format=jpg&name=small`;
  }

  if (!finalUrl || hasError) {
    return (
      <div className="w-full h-full bg-gray-100 flex flex-col items-center justify-center text-gray-400 text-xs">
        <PictureOutlined className="text-2xl mb-1 opacity-50" />
        <span>预览不可用</span>
      </div>
    );
  }

  // 确保是预览小图而非原图
  const previewUrl = finalUrl.includes('?')
    ? finalUrl
    : `${finalUrl}?format=jpg&name=small`;

  // 通过 Tauri 自定义协议 xsimg:// 走后端代理下载图片
  const isWindows = navigator.userAgent.includes('Windows');
  const protocolBase = isWindows ? 'http://xsimg.localhost' : 'xsimg://localhost';
  const src = `${protocolBase}/?url=${encodeURIComponent(previewUrl)}`;

  return (
    <img
      alt="推文图片"
      src={src}
      loading="lazy"
      className="object-cover w-full h-full transform transition-transform group-hover:scale-105"
      onError={() => setHasError(true)}
    />
  );
};

export const PostListGridView: React.FC = () => {
  const { message } = App.useApp();
  const { userInfo, postList } = useHomepageStore(
    useShallow((state) => ({
      postList: state.postList,
      userInfo: state.userInfo,
    })),
  );
  const loadPostList = useHomepageStore((s) => s.loadPostList);
  const createDownloadTask = useDownloadStore(
    (state) => state.createDownloadTask,
  );

  const userId = userInfo.data?.id;

  // ✅ 首次加载只在这里做
  useEffect(() => {
    if (userId) {
      loadPostList().catch((err) => {
        console.error('加载图片列表失败', err);
      });
    }
  }, [userId, loadPostList]);

  const fullMediaList = useMemo<(TwitterMedia & { postId: string })[]>(
    () =>
      R.pipe(
        R.map<TwitterPost, (TwitterMedia & { postId: string })[]>((postItem) =>
          R.pipe<
            [TwitterPost],
            TwitterMedia[] | undefined,
            TwitterMedia[],
            (TwitterMedia & { postId: string })[]
          >(
            R.prop('medias'),
            R.defaultTo([]),
            R.map<TwitterMedia, TwitterMedia & { postId: string }>(
              R.assoc('postId', postItem.id),
            ),
          )(postItem),
        ),
        R.flatten,
      )(postList.list || []),
    [postList.list],
  );

  // ✅ 限制渲染数量，避免 DOM 爆炸
  const mediaList = useMemo(() => {
    return fullMediaList.slice(0, MAX_RENDER_MEDIA);
  }, [fullMediaList]);

  const isMediaTruncated = fullMediaList.length > MAX_RENDER_MEDIA;

  // ✅ 只负责"加载更多"，不再做首次加载
  const loadMore = useCallback(async () => {
    // 如果已经达到渲染上限，不再加载更多（避免内存暴涨）
    if (isMediaTruncated) return;

    const state = useHomepageStore.getState();
    if (!state.postList.cursor) return;
    if (state.postList.loading) return;
    try {
      await state.loadMorePostList();
    } catch (err: any) {
      message.error(err.message);
    }
  }, [message, isMediaTruncated]);

  const requestFn = useCallback(async () => {
    if (isMediaTruncated) {
      return { hasMore: false };
    }
    await loadMore();
    const state = useHomepageStore.getState();
    return {
      hasMore: !!state.postList.cursor && !state.postList.loading,
    };
  }, [loadMore, isMediaTruncated]);

  // ✅ 只有首次数据就绪后，才让 InfiniteScroll 接管滚动加载
  const readyForInfiniteScroll = !!postList.list;

  return (
    <InfiniteScroll
      requestFn={requestFn}
      resetKey={userId}
      enabled={readyForInfiniteScroll}
      className="h-full overflow-y-auto pb-10"
      threshold={200}
    >
      {postList.loading && !postList.list ? (
        <div role="status">
          <LoadingOutlined className="text-ant-color-primary mr-2" aria-hidden />
          加载图片列表中...
        </div>
      ) : (
        <div role="status" className="sr-only">
          列表加载完成
        </div>
      )}
      <ul className="grid grid-cols-[repeat(auto-fill,minmax(12rem,1fr))] gap-2">
        {mediaList.map((media) => {
          const actionOpen: GridViewItemAction | undefined = userInfo.data?.screenName
            ? {
                name: '打开推文',
                href: buildPostUrl(userInfo.data.screenName, media.postId),
              }
            : undefined;

          async function commonDownload() {
            const post = postList.list!.find((post) => post.id === media.postId)!;
            try {
              await createDownloadTask({ post, media });
              message.success('已添加到下载队列');
            } catch (err: any) {
              window.log.error(err);
              message.error(`创建下载任务失败：${err?.message}`);
            }
          }

          const actionDownloadImage: GridViewItemAction = {
            name: '下载图片',
            onClick: commonDownload,
          };
          const actionDownloadVideo: GridViewItemAction = {
            name: '下载视频',
            onClick: commonDownload,
          };
          const actionDownloadGif: GridViewItemAction = {
            name: '下载 GIF（视频）',
            onClick: commonDownload,
          };

          return (
            <li tabIndex={0} key={media.id} className="relative h-[12rem] overflow-hidden bg-white group">
              <div className="h-full">
                {/* ✅ 走后端代理加载缩略图 */}
                <MediaThumbnail url={media.url} mediaId={media.id} />

                {media.type === MediaType.Video && (
                  <span className="block absolute right-2 bottom-2 text-white bg-[rgba(0,0,0,0.6)] rounded-sm px-[0.3rem] text-sm pointer-events-none">
                    <span className="sr-only">视频时长：</span>
                    {media.videoInfo?.duration
                      ? dayjs.duration(media.videoInfo.duration).format('mm:ss')
                      : '视频'}
                  </span>
                )}
                {media.type === MediaType.Gif && (
                  <span className="block absolute right-2 bottom-2 text-white bg-[rgba(0,0,0,0.6)] rounded-sm px-[0.3rem] text-sm pointer-events-none">
                    GIF
                  </span>
                )}
                <div className="absolute top-0 left-0 w-full h-full bg-[rgba(0,0,0,0.7)] transition-opacity opacity-0 group-hover:opacity-100 has-[:focus]:opacity-100">
                  <GridViewItemActions
                    actions={R.cond([
                      [R.equals(MediaType.Photo), R.always([actionOpen, actionDownloadImage])],
                      [R.equals(MediaType.Video), R.always([actionOpen, actionDownloadVideo])],
                      [R.equals(MediaType.Gif), R.always([actionOpen, actionDownloadGif])],
                      [R.T, R.always([])],
                    ])(media.type).filter(R.isNotNil)}
                  />
                </div>
              </div>
            </li>
          );
        })}
        {postList.loading && mediaList.length > 0 && !isMediaTruncated && (
          <li className="h-[15rem] flex items-center justify-center bg-white" tabIndex={0}>
            <LoadingOutlined className="text-6xl text-ant-color-primary" aria-hidden />
            <span className="sr-only">加载更多图片中</span>
          </li>
        )}
      </ul>

      {/* ✅ 达到渲染上限时的提示 */}
      {isMediaTruncated && (
        <div className="mt-4 text-sm text-center text-orange-500 font-bold" role="alert">
          为保证流畅度，仅渲染前 {MAX_RENDER_MEDIA} 个媒体（共 {fullMediaList.length} 个）。
          <br />
          请先下载或清理已展示媒体，后续版本将支持完整虚拟滚动。
        </div>
      )}

      {!postList.loading && userInfo.data && !postList.cursor && !isMediaTruncated && (
        <div className="mt-4 text-sm text-ant-color-text-secondary text-center" role="alert">
          列表没有更多数据了
        </div>
      )}
    </InfiniteScroll>
  );
};