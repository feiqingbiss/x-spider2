import { request } from '../ipc/network';
import * as R from 'ramda';

// ✅ 优化：最多翻 10 页，避免 GitHub 返回异常时无限翻页
const MAX_PAGES = 10;

export async function getLatestReleases(pre = false) {
  let url = 'https://api.github.com/repos/MiningCattiva/x-spider/releases';
  let pageCount = 0;

  while (pageCount < MAX_PAGES) {
    pageCount++;

    const resp = await request({
      method: 'GET',
      responseType: 'text',
      url,
      headers: {
        'User-Agent': 'X-Spider',
      },
    });

    if (resp.status !== 200) {
      throw new Error('无法获取最新软件版本，请稍后再试。');
    }

    let body: any;
    try {
      body = JSON.parse(resp.body);
    } catch {
      throw new Error('无法获取最新软件版本，请稍后再试。');
    }

    if (!Array.isArray(body) || !body[0]) {
      throw new Error('无法获取最新软件版本，请稍后再试。');
    }

    if (pre) {
      return body[0] || null;
    }

    const latest = body.find((item: any) => !item.prerelease);

    if (latest) {
      return latest;
    }

    if (!resp.headers.link || resp.headers.link.length === 0) {
      return null;
    }

    const links = R.fromPairs(
      resp.headers.link[0].split(', ').map((item: string) => {
        const [link, rel] = item.split('; rel=');
        return [rel.replace(/"(.+)"/, '$1'), link.replace(/<(.+)>/, '$1')];
      }),
    );

    if (!links.next) return null;

    url = links.next;
  }

  // ✅ 达到最大页数仍未找到稳定版，返回 null
  return null;
}