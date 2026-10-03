import { useSettingsStore } from '../stores/settings';

export function useResolvedProxyUrl() {
  const proxyConfig = useSettingsStore((state) => state.proxy);

  if (!proxyConfig.enable) return '';
  return proxyConfig.url;
}