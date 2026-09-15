import { useSettingsStore } from '../stores/settings';
import { usePollSystemProxyUrl } from './background-tasks/usePollSystemProxyUrl';
import { useAriaBinding } from './background-tasks/useAriaBinding';
import { useTaskNotifications } from './background-tasks/useTaskNotifications';
import { useAutoCheckUpdate } from './background-tasks/useAutoCheckUpdate';

export function useRunBackgroundTasks() {
  const proxyEnable = useSettingsStore((s) => s.proxy.enable);
  const useSystem = useSettingsStore((s) => s.proxy.useSystem);

  useTaskNotifications();
  useAutoCheckUpdate();
  // ✅ 已修复：只有启用代理且使用系统代理时才轮询系统代理
  usePollSystemProxyUrl(proxyEnable && useSystem);
  useAriaBinding();
}