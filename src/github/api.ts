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
 * - 优先返回最新 stable release
 * - 如果没有 stable（全是你自己的 prerelease），返回最新 prerelease 作为兜底
 * - pre = true 时直接返回最新一条（包含 prerelease）
 *
 * 如果 releases 列表为空，会 fallback 到 tags 接口。
 */
export async function getLatestReleases(
  pre = false,
): Promise<GitHubRelease | null> {
  const fromReleases = await tryGetLatestFromReleases(pre);
  if (fromReleases !== undefined) return fromReleases;

  // releases 列表完全为空 → 走 tags
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
      // 仓库不存在 / releases 接口不可用 → 交给 tags 兜底
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
      // 不是数组（可能是错误对象），交给 tags 兜底
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
    // 完全没有 release，交给 tags 兜底
    return undefined;
  }

  // pre = true：直接返回最新一条（含 prerelease）
  if (pre) {
    return allReleases[0];
  }

  // pre = false：优先返回最新 stable
  const stable = allReleases.find((r) => !r.prerelease);
  if (stable) return stable;

  // 没有 stable → 兜底返回最新一条（你自己的全是 prerelease 也能被检测到）
  return allReleases[0];
}

/**
 * 兜底：从 tags 里找最新版本（releases 列表为空时使用）
 * tags 响应格式：[{ name: "v2.5.1-10", commit: {...} }]
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