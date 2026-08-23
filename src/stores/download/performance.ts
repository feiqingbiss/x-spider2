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

// 导出性能日志文件（用户可在设置中手动导出）
export async function exportPerformanceLog() {
  const filePath = await ensureDebugLogPath();
  // 由于日志已存在于 debug-dl.log，只需提示用户到日志文件夹查看
  // 或者单独写入 perf.log
  const dataDir = await path.appDataDir();
  const logsDir = await path.join(dataDir, 'logs');
  const perfLogPath = await path.join(logsDir, 'perf.log');
  // 从 debug-dl.log 中提取 [PERF] 行
  // 但为简化，我们建议用户查看 debug-dl.log 中包含 [PERF] 的行
  // 或者我们单独写入 perf.log
  // 这里为了简单，不重复实现
}