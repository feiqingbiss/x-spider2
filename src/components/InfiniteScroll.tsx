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

// ✅ 已修复：最多连续请求 50 次，防止死循环
const MAX_CONSECUTIVE_LOADS = 50;

export const InfiniteScroll: React.FC<InfiniteScrollProps> = ({
  requestFn,
  threshold = -1,
  children,
  ...props
}) => {
  const ref = useRef<HTMLDivElement>(null);
  const paramRef = useRef<LoadParam>({
    hasMore: true,
  });
  const loadingRef = useRef(false);
  const unmountedRef = useUnmountedRef();

  const onScroll = useCallback(async () => {
    const el = ref.current;
    if (!el) return;
    if (!paramRef.current.hasMore) return;
    if (loadingRef.current) return;

    const thresholdReal = threshold >= 0 ? threshold : el.clientHeight;
    let shouldContinueRequest =
      el.scrollHeight - el.scrollTop <= el.clientHeight + thresholdReal;

    let guard = 0;
    while (
      shouldContinueRequest &&
      !unmountedRef.current &&
      guard++ < MAX_CONSECUTIVE_LOADS
    ) {
      loadingRef.current = true;

      try {
        paramRef.current = await requestFn(paramRef.current);
      } finally {
        loadingRef.current = false;
      }
      shouldContinueRequest =
        paramRef.current.hasMore &&
        el.scrollHeight - el.scrollTop <= el.clientHeight + thresholdReal;
    }
  }, [requestFn, threshold, unmountedRef]);

  useEffect(() => {
    onScroll();
  }, [onScroll]);

  return (
    <div {...props} ref={ref} onScroll={onScroll}>
      {children}
    </div>
  );
};