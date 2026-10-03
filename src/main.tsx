import ReactDOM from 'react-dom/client';
import { App } from './App';
import './css/preflight.css';
import './css/base.css';
import dayjs from 'dayjs';
import duration from 'dayjs/plugin/duration';
import 'dayjs/locale/zh-cn';
import './utils/log';
import { Logger } from './utils/log';

dayjs.extend(duration);
dayjs.locale('zh-cn');

// ✅ 优化：过滤掉 ResizeObserver 循环警告（antd / rc-* 组件常见，无害）
function isResizeObserverNoise(msg: string): boolean {
  return msg.includes('ResizeObserver loop');
}

function bootstrapLogger() {
  window.log = new Logger();

  window.addEventListener('error', (ev) => {
    if (isResizeObserverNoise(ev.message || '')) return;

    // ✅ 过滤掉浏览器扩展产生的错误，避免污染日志
    if (
      ev.filename &&
      (ev.filename.startsWith('chrome-extension://') ||
        ev.filename.startsWith('moz-extension://') ||
        ev.filename.startsWith('safari-extension://'))
    ) {
      return;
    }

    // ✅ 安全提取错误信息，避免直接传递复杂对象导致序列化崩溃
    const safeInfo = {
      message: ev.message || 'Unknown error',
      filename: ev.filename || 'unknown',
      lineno: ev.lineno,
      colno: ev.colno,
      errorName: ev.error?.name,
      errorMessage: ev.error?.message,
      errorStack: ev.error?.stack,
    };

    log.error('Window error', safeInfo);
  });

  window.addEventListener('unhandledrejection', (ev) => {
    const reason = ev.reason;
    const reasonStr =
      typeof reason === 'string' ? reason : reason?.message || '';

    if (isResizeObserverNoise(reasonStr)) return;

    // ✅ 安全提取 rejection 信息
    const safeInfo = {
      reasonName: reason?.name,
      reasonMessage: reason?.message,
      reasonStack: reason?.stack,
      reasonStr: reasonStr || String(reason),
    };

    log.error('Unhandled rejection', safeInfo);
  });
}

function bootstrapView() {
  log.info('Bootstrap view');
  ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
    <App />,
  );
}

async function bootstrap() {
  bootstrapLogger();
  log.info(`App bootstrap, version=${PACKAGE_JSON_VERSION}`);
  bootstrapView();
}

bootstrap();