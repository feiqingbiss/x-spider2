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
    // ✅ 关键修复：如果当前版本本身是 prerelease（例如 2.5.2-9），
    //    自动接受 prerelease 更新，忽略 acceptPrerelease 设置。
    //    因为用户装的已经是预发布版本，理应能收到后续的预发布更新。
    const currentIsPrerelease = PACKAGE_JSON_VERSION.includes('-');
    const acceptPre = pre || currentIsPrerelease;

    const release = await getLatestReleases(acceptPre);
    setLastCheckUpdateTime(Date.now());

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