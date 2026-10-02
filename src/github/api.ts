import { request } from '../ipc/network';
import * as R from 'ramda';
import { isVersionGt } from '../utils/version';

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
 * 从一堆 releases 里挑出版本号最大的那个。
 *
 * ⚠️ 为什么不用 GitHub 的默认排序？
 *   GitHub 的 /releases API 按"发布时间"倒序排列，而不是按版本号。
 *   如果仓库里发生过"重发旧版本"的操作（比如 v2.5.2-13 先发，
 *   v2.5.2-9 后发），API 返回的第一条会是 v2.5.2-9，而不是 v2.5.2-13。
 *   我们这里用 isVersionGt 遍历所有 tag，挑出版本号真正最大的那一个。
 */
function pickHighestVersion(
  releases: GitHubRelease[],
  acceptPrerelease: boolean,
): GitHubRelease | null {
  let best: GitHubRelease | null = null;
  for (const rel of releases) {
    if (!acceptPrerelease && rel.prerelease) continue;
    if (!rel.tag_name) continue;

    if (!best) {
      best = rel;
      continue;
    }
    const a = rel.tag_name.replace(/^v/i, '');
    const b = best.tag_name.replace(/^v/i, '');
    if (isVersionGt(a, b)) {
      best = rel;
    }
  }
  return best;
}

/**
 * 拉取 releases 列表。
 * - pre = true：从所有 release（含 prerelease）里挑版本号最大的
 * - pre = false：先尝试从 stable 里挑版本号最大的；没有 stable 时兜底从所有里挑
 *
 * releases 列表为空时，会 fallback 到 tags 接口。
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

  // ✅ 关键修复：按版本号挑最大，而不是按 GitHub 的默认排序取第一条
  if (pre) {
    return pickHighestVersion(allReleases, true);
  }

  // 不接受 prerelease：先尝试 stable
  const stableBest = pickHighestVersion(allReleases, false);
  if (stableBest) {
    return stableBest;
  }

  // 没有 stable：兜底从所有 release 里挑最大
  return pickHighestVersion(allReleases, true);
}

/**
 * 兜底：从 tags 里找最新版本（releases 列表为空时使用）
 * 注意：tags 返回的顺序也不一定按版本号排序，同样要遍历挑最大
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

  // 收集所有 tag，用 isVersionGt 挑版本号最大的
  const tags: GitHubRelease[] = body
    .map((t: any) => ({
      tag_name: t.name || '',
      html_url: `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/tag/${encodeURIComponent(t.name || '')}`,
      name: t.name,
      prerelease: false,
    }))
    .filter((t: GitHubRelease) => t.tag_name);

  return pickHighestVersion(tags, true);
}