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
  // ✅ 新增：resetKey 变化时，内部状态会被重置（用于切换用户等场景）
  resetKey?: string | number;
}

const MAX_CONSECUTIVE_LOADS = 30;

export const InfiniteScroll: React.FC<InfiniteScrollProps> = ({
  requestFn,
  threshold = -1,
  resetKey,
  children,
  ...props
}) => {
  const ref = useRef<HTMLDivElement>(null);
  const paramRef = useRef<LoadParam>({ hasMore: true });
  const loadingRef = useRef(false);
  const unmountedRef = useUnmountedRef();

  // ✅ 记录上一次的 resetKey，用于检测"用户切换"
  const lastResetKeyRef = useRef(resetKey);

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

      if (distanceToBottom > thresholdReal) return;

      loadingRef.current = true;
      try {
        paramRef.current = await requestFn(paramRef.current);
      } finally {
        loadingRef.current = false;
      }

      if (unmountedRef.current) return;
      if (!paramRef.current.hasMore) return;

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
    // ✅ 切换用户时（resetKey 变化），重置内部分页状态
    if (lastResetKeyRef.current !== resetKey) {
      lastResetKeyRef.current = resetKey;
      paramRef.current = { hasMore: true };
      loadingRef.current = false;
    }
    checkAndLoad(0);
  }, [resetKey, checkAndLoad]);

  const onScroll = useCallback(() => {
    checkAndLoad(0);
  }, [checkAndLoad]);

  return (
    <div {...props} ref={ref} onScroll={onScroll}>
      {children}
    </div>
  );
};