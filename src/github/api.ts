import { request } from '../ipc/network';
import * as R from 'ramda';

// ✅ 修改为你自己的仓库（owner/repo）
const GITHUB_OWNER = 'feiqingbiss';
const GITHUB_REPO = 'x-spider2';

const MAX_PAGES = 10;

export interface GitHubRelease {
  tag_name: string;
  html_url: string;
  name?: string;
  prerelease?: boolean;
  published_at?: string;
  body?: string;
}

/**
 * 拉取 releases 列表。
 * - pre = true：直接返回最新一条（含 prerelease）
 * - pre = false：如果最新一条是 stable，返回它；
 *                如果最新一条是 prerelease，也直接返回它（重要修复，见下）
 *
 * 关于 pre = false 的兜底逻辑：
 *   以前用 `allReleases.find(r => !r.prerelease)` 查找 stable，
 *   但如果仓库历史上发过一个很旧的 stable（比如 v2.5.0），
 *   就会优先返回它，导致后续发布的 prerelease 永远检测不到。
 *   现在改为：
 *     1. 最新一条是 stable → 返回它
 *     2. 最新一条是 prerelease → 忽略 acceptPrerelease 设置，直接返回它
 *   这样“用户装的是 prerelease、也应该收到 prerelease 更新”的语义能对上。
 */
export async function getLatestReleases(
  pre = false,
): Promise<GitHubRelease | null> {
  const fromReleases = await tryGetLatestFromReleases(pre);
  if (fromReleases !== undefined) return fromReleases;
  return await tryGetLatestFromTags();
}

async function tryGetLatestFromReleases(
  pre: boolean,
): Promise<GitHubRelease | null | undefined> {
  let url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases?per_page=100`;
  let pageCount = 0;

  const allReleases: GitHubRelease[] = [];

  while (pageCount < MAX_PAGES) {
    pageCount++;

    const resp = await request({
      method: 'GET',
      responseType: 'text',
      url,
      headers: {
        'User-Agent': 'X-Spider',
        Accept: 'application/vnd.github+json',
      },
    });

    if (resp.status === 404) {
      return undefined;
    }
    if (resp.status !== 200) {
      throw new Error(`无法获取最新版本，HTTP ${resp.status}`);
    }

    let body: any;
    try {
      body = JSON.parse(resp.body);
    } catch {
      throw new Error('无法解析 GitHub 返回内容');
    }

    if (!Array.isArray(body)) {
      return undefined;
    }

    allReleases.push(...body);

    if (body.length < 100) break;

    if (!resp.headers.link || resp.headers.link.length === 0) break;

    const links = R.fromPairs(
      resp.headers.link[0].split(', ').map((item: string) => {
        const [link, rel] = item.split('; rel=');
        return [rel.replace(/"(.+)"/, '$1'), link.replace(/<(.+)>/, '$1')];
      }),
    );

    if (!links.next) break;
    url = links.next;
  }

  if (allReleases.length === 0) {
    return undefined;
  }

  // allReleases[0] 是最新发布的一条
  const latest = allReleases[0];

  // ✅ 关键修复 1：最新一条就是 stable → 直接返回
  if (!latest.prerelease) {
    return latest;
  }

  // ✅ 关键修复 2：最新一条是 prerelease
  //    - pre = true → 直接返回
  //    - pre = false → 也直接返回（不再去找可能很旧的 stable）
  //      为什么？因为如果只找 stable，历史上某个 v2.5.0 会把后续的
  //      v2.5.2-1、v2.5.2-2 等 prerelease 更新全部屏蔽。
  //      用户当前装的是 prerelease 时，前端（useCheckUpdate）会强制 acceptPre = true；
  //      即使前端没强制，这里也兜底返回最新 prerelease，避免“永远最新”。
  if (pre || latest.prerelease) {
    return latest;
  }

  return latest;
}

/**
 * 兜底：从 tags 里找最新版本（releases 列表为空时使用）
 */
async function tryGetLatestFromTags(): Promise<GitHubRelease | null> {
  const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/tags?per_page=100`;

  const resp = await request({
    method: 'GET',
    responseType: 'text',
    url,
    headers: {
      'User-Agent': 'X-Spider',
      Accept: 'application/vnd.github+json',
    },
  });

  if (resp.status !== 200) {
    throw new Error(`无法获取标签，HTTP ${resp.status}`);
  }

  let body: any;
  try {
    body = JSON.parse(resp.body);
  } catch {
    throw new Error('无法解析 GitHub 标签返回内容');
  }

  if (!Array.isArray(body) || body.length === 0) {
    return null;
  }

  const latestTag = body[0];
  const tagName: string = latestTag.name ?? '';
  if (!tagName) return null;

  return {
    tag_name: tagName,
    html_url: `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/tag/${encodeURIComponent(tagName)}`,
    name: tagName,
    prerelease: false,
  };
}