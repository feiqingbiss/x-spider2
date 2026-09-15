import { useLockFn } from 'ahooks';
import { useAppStateStore } from '../stores/app-state';
import { getLatestReleases } from '../github/api';
import { isVersionGt } from '../utils/version';
import { dialog, shell } from '@tauri-apps/api';
import { useSettings } from './useSettings';

export function useCheckUpdate() {
  const { setLatestVersion, setLatestUrl, setLastCheckUpdateTime } =
    useAppStateStore((s) => ({
      setLatestVersion: s.setLatestVersion,
      setLatestUrl: s.setLatestUrl,
      setLastCheckUpdateTime: s.setLastCheckUpdateTime,
    }));
  const { value: pre } = useSettings<boolean>('app', 'acceptPrerelease');
  return useLockFn(async () => {
    const release = await getLatestReleases(pre);
    setLastCheckUpdateTime(Date.now());

    // ✅ 已修复：release 可能为 null，先判断再使用
    if (!release) {
      return false;
    }

    const latestVersion = (release.tag_name as string).slice(1);
    setLatestVersion(latestVersion);
    setLatestUrl(release.html_url);
    if (isVersionGt(latestVersion, PACKAGE_JSON_VERSION)) {
      dialog
        .ask('软件有最新版本，是否前往下载？', {
          title: '更新提示',
          okLabel: '现在就去',
          cancelLabel: '下次一定',
        })
        .then((result) => {
          if (result) {
            shell.open(release.html_url);
          }
        });
      return true;
    }
    return false;
  });
}