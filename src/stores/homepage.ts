import { create } from 'zustand';
import { TwitterUser } from '../interfaces/TwitterUser';
import { getUser, getUserMedias } from '../twitter/api';
import { TwitterPost } from '../interfaces/TwitterPost';
import { DownloadFilter } from '../interfaces/DownloadFilter';
import MediaType from '../enums/MediaType';
import { produce } from 'immer';

export interface PostListRequest {
  list?: TwitterPost[];
  loading: boolean;
  cursor: string | null;
}

export interface UserInfoRequest {
  data?: TwitterUser;
  loading: boolean;
}

export interface HomepageStore {
  keyword: string;
  setKeyword: (kw: string) => void;
  filter: DownloadFilter;
  setFilter: (filter: DownloadFilter) => void;

  userInfo: UserInfoRequest;
  loadUser: (screenName: string) => Promise<void>;
  clearUser: () => void;

  postList: PostListRequest;
  clearPostList: () => void;
  loadPostList: () => Promise<void>;
  loadMorePostList: () => Promise<void>;
}

// 使用 request id 保证只有最新的请求生效
let loadPostListRequestId = 0;
let loadUserRequestId = 0;

export const useHomepageStore = create<HomepageStore>((set, get) => ({
  keyword: '',
  setKeyword: (kw: string) => set({ keyword: kw }),
  filter: {
    mediaTypes: [MediaType.Photo, MediaType.Video, MediaType.Gif],
    source: 'medias',
  },
  setFilter: (filter) => set({ filter }),

  userInfo: {
    loading: false,
    data: undefined,
  },
  loadUser: async (screenName: string) => {
    const requestId = ++loadUserRequestId;

    // 清空当前用户和列表，避免显示旧数据
    set({
      userInfo: {
        data: undefined,
        loading: true,
      },
      postList: {
        cursor: null,
        list: undefined,
        loading: false,
      },
    });
    // 使正在进行的 postList 请求失效
    loadPostListRequestId++;

    try {
      const value = await getUser(screenName);

      if (requestId !== loadUserRequestId) {
        return;
      }

      set({
        userInfo: {
          loading: false,
          data: value,
        },
      });
    } catch (err: any) {
      if (requestId !== loadUserRequestId) {
        return;
      }
      set({
        userInfo: {
          data: undefined,
          loading: false,
        },
      });
      throw err;
    }
  },
  clearUser: () =>
    set({
      userInfo: {
        loading: false,
        data: undefined,
      },
    }),

  postList: {
    list: undefined,
    loading: false,
    cursor: null,
  },
  clearPostList: () => {
    // 使正在进行的请求失效
    loadPostListRequestId++;
    set({
      postList: {
        cursor: null,
        list: undefined,
        loading: false,
      },
    });
  },
  loadPostList: async () => {
    const requestId = ++loadPostListRequestId;
    const state = get();
    const userInfo = state.userInfo.data;

    if (!userInfo) {
      throw new Error('No userInfo');
    }

    set({
      postList: {
        cursor: null,
        list: undefined,
        loading: true,
      },
    });

    try {
      const { cursor, twitterPosts } = await getUserMedias(userInfo.id);

      // 丢弃过期请求
      if (requestId !== loadPostListRequestId) {
        return;
      }

      set({
        postList: {
          list: twitterPosts,
          loading: false,
          cursor,
        },
      });
    } catch (err: any) {
      if (requestId !== loadPostListRequestId) {
        return;
      }
      log.error('Failed to load post list', err);
      set({
        postList: {
          cursor: null,
          list: [],
          loading: false,
        },
      });
      throw new Error(`加载图片列表失败：${err?.message || '未知原因'}`);
    }
  },
  loadMorePostList: async () => {
    const state = get();
    const postList = state.postList;
    const userInfo = state.userInfo.data;

    if (!postList.list) {
      throw new Error('未初始化列表');
    }
    if (postList.loading) {
      throw new Error('已正在加载中');
    }
    if (!postList.cursor) {
      throw new Error('没有更多数据了');
    }
    if (!userInfo) {
      throw new Error('未加载用户信息');
    }

    // 记录当前 requestId，加载更多时不递增
    const currentRequestId = loadPostListRequestId;

    set(
      produce(state, (draft) => {
        draft.postList.loading = true;
      }),
    );

    try {
      const { twitterPosts, cursor } = await getUserMedias(
        userInfo.id,
        postList.cursor,
      );

      // 如果加载过程中用户切换了，丢弃结果
      if (currentRequestId !== loadPostListRequestId) {
        return;
      }

      set({
        postList: {
          loading: false,
          list: (postList.list || []).concat(twitterPosts),
          cursor,
        },
      });
    } catch (err: any) {
      if (currentRequestId !== loadPostListRequestId) {
        return;
      }
      set(
        produce(state, (draft) => {
          draft.postList.loading = false;
        }),
      );
      throw err;
    }
  },
}));