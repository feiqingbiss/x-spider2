/* eslint-disable react/prop-types */
import { LoadingOutlined, PictureOutlined, FileImageOutlined } from '@ant-design/icons';
import { App } from 'antd';
import { shell } from '@tauri-apps/api';
import dayjs from 'dayjs';
import * as R from 'ramda';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import MediaType from '../../enums/MediaType';
import { TwitterMedia } from '../../interfaces/TwitterMedia';
import { TwitterPost } from '../../interfaces/TwitterPost';
import { useHomepageStore } from '../../stores/homepage';
import { buildPostUrl } from '../../twitter/url';
import { InfiniteScroll } from '../InfiniteScroll';
import { GridViewItemAction, GridViewItemActions } from './GridViewItemActions';
import { getMediaThumbnail } from '../../utils/image-cache';

const MAX_RENDER_MEDIA = 500;

const MediaThumbnail: React.FC<{
  media: TwitterMedia;
  post: TwitterPost;
  onLocalStateChange: (localPath?: string) => void;
}> = ({ media, post, onLocalStateChange }) => {
  const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading');
  const [src, setSrc] = useState('');

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');

    getMediaThumbnail(media, post)
      .then((res) => {
        if (cancelled) return;
        setSrc(res.src);
        setStatus('success');
        onLocalStateChange(res.localPath);
      })
      .catch(() => {
        if (cancelled) return;
        setStatus('error');
        onLocalStateChange(undefined);
      });

    return () => {
      cancelled = true;
    };
  }, [media, post, onLocalStateChange]);

  if (status === 'error') {
    return (
      <div className="w-full h-full bg-gray-100 flex flex-col items-center justify-center text-gray-400 text-xs">
        <PictureOutlined className="text-2xl mb-1 opacity-50" />
        <span>预览不可用</span>
      </div>
    );
  }

  if (status === 'loading' || !src) {
    return (
      <div className="w-full h-full bg-gray-200 animate-pulse flex items-center justify-center text-gray-400 text-xs">
        <span>加载中...</span>
      </div>
    );
  }

  return (
    <img
      alt="推文图片"
      src={src}
      loading="lazy"
      className="object-cover w-full h-full transform transition-transform group-hover:scale-105"
      onError={() => setStatus('error')}
    />
  );
};

// 抽离单张卡片，处理自己的本地路径状态
const MediaGridItem: React.FC<{
  media: TwitterMedia & { postId: string };
  post: TwitterPost;
  userScreenName?: string;
}> = ({ media, post, userScreenName }) => {
  const [localPath, setLocalPath] = useState<string | undefined>();

  const actionOpen: GridViewItemAction | undefined = userScreenName
    ? {
        name: '打开推文',
        href: buildPostUrl(userScreenName, media.postId),
      }
    : undefined;

  // ✅ 只有在本地存在时才显示这个按钮
  const actionOpenLocal: GridViewItemAction | undefined = localPath
    ? {
        name: '打开本地',
        onClick: async () => {
          await shell.open(localPath);
        },
      }
    : undefined;

  return (
    <li
      tabIndex={0}
      className="relative h-[12rem] overflow-hidden bg-white group"
    >
      <div className="h-full">
        <MediaThumbnail
          media={media}
          post={post}
          onLocalStateChange={setLocalPath}
        />

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
            actions={[actionOpen, actionOpenLocal].filter(
              (x): x is GridViewItemAction => x !== undefined,
            )}
          />
        </div>
      </div>
    </li>
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

  const userId = userInfo.data?.id;

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

  const mediaList = useMemo(() => {
    return fullMediaList.slice(0, MAX_RENDER_MEDIA);
  }, [fullMediaList]);

  const isMediaTruncated = fullMediaList.length > MAX_RENDER_MEDIA;

  const loadMore = useCallback(async () => {
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
          const post = postList.list!.find((p) => p.id === media.postId)!;
          return (
            <MediaGridItem
              key={media.id}
              media={media}
              post={post}
              userScreenName={userInfo.data?.screenName}
            />
          );
        })}
        {postList.loading && mediaList.length > 0 && !isMediaTruncated && (
          <li className="h-[15rem] flex items-center justify-center bg-white" tabIndex={0}>
            <LoadingOutlined className="text-6xl text-ant-color-primary" aria-hidden />
            <span className="sr-only">加载更多图片中</span>
          </li>
        )}
      </ul>

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