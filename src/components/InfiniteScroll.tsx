/* eslint-disable react/prop-types */
import { useUnmountedRef } from 'ahooks';
import React, { useCallback, useEffect, useRef } from 'react';

export interface LoadParam {
  hasMore: boolean;
  [key: string]: any;
}

export interface InfiniteScrollProps
  extends React.HTMLAttributes<HTMLDivElement> {
  requestFn: (params: LoadParam) => Promise<LoadParam>;
  threshold?: number;
}

// 最多连续追加 30 次，避免极端情况下死循环
const MAX_CONSECUTIVE_LOADS = 30;

export const InfiniteScroll: React.FC<InfiniteScrollProps> = ({
  requestFn,
  threshold = -1,
  children,
  ...props
}) => {
  const ref = useRef<HTMLDivElement>(null);
  const paramRef = useRef<LoadParam>({ hasMore: true });
  const loadingRef = useRef(false);
  const unmountedRef = useUnmountedRef();

  const checkAndLoad = useCallback(
    async (depth = 0) => {
      const el = ref.current;
      if (!el) return;
      if (unmountedRef.current) return;
      if (!paramRef.current.hasMore) return;
      if (loadingRef.current) return;
      if (depth > MAX_CONSECUTIVE_LOADS) return;

      const thresholdReal = threshold >= 0 ? threshold : el.clientHeight;
      const distanceToBottom =
        el.scrollHeight - el.scrollTop - el.clientHeight;

      // 还没接近底部 → 什么都不做
      if (distanceToBottom > thresholdReal) return;

      loadingRef.current = true;
      try {
        paramRef.current = await requestFn(paramRef.current);
      } finally {
        loadingRef.current = false;
      }

      if (unmountedRef.current) return;
      if (!paramRef.current.hasMore) return;

      // ✅ 关键：用 requestAnimationFrame 让 React 先把 DOM 渲染完，
      //    然后再判断要不要继续拉下一页
      requestAnimationFrame(() => {
        if (unmountedRef.current) return;
        if (loadingRef.current) return;
        if (!paramRef.current.hasMore) return;

        const el2 = ref.current;
        if (!el2) return;

        const stillShouldLoad =
          el2.scrollHeight - el2.scrollTop <= el2.clientHeight + thresholdReal;
        if (stillShouldLoad) {
          checkAndLoad(depth + 1);
        }
      });
    },
    [requestFn, threshold, unmountedRef],
  );

  useEffect(() => {
    checkAndLoad(0);
  }, [checkAndLoad]);

  const onScroll = useCallback(() => {
    checkAndLoad(0);
  }, [checkAndLoad]);

  return (
    <div {...props} ref={ref} onScroll={onScroll}>
      {children}
    </div>
  );
};