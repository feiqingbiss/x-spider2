import { writeDebugLog } from './utils';

// 性能监控：记录耗时操作
export const perf = {
  mark: (label: string) => {
    if (typeof performance !== 'undefined') {
      performance.mark(label);
    }
  },
  measure: (label: string, startMark: string, endMark: string) => {
    if (typeof performance !== 'undefined') {
      try {
        const measure = performance.measure(label, startMark, endMark);
        const duration = measure.duration;
        if (duration > 50) {
          writeDebugLog(`[PERF] ${label} took ${duration.toFixed(2)}ms`);
        }
        return duration;
      } catch (e) {
        // ignore
      }
    }
    return 0;
  },
  log: (message: string) => {
    writeDebugLog(`[PERF] ${message}`);
  }
};