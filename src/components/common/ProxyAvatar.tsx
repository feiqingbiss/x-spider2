/* eslint-disable react/prop-types */
import { Avatar } from 'antd';
import type { AvatarProps } from 'antd';
import React from 'react';
import { useProxiedImageUrl } from '../../hooks/useProxiedImageUrl';

// ✅ 新增全局缓存，防止高频刷新导致头像短暂变灰
const avatarCache = new Map<string, string>();

export interface ProxyAvatarProps extends Omit<AvatarProps, 'src'> {
  src?: string;
}

export const ProxyAvatar: React.FC<ProxyAvatarProps> = ({ src, ...rest }) => {
  const { src: proxiedSrc } = useProxiedImageUrl(src);

  if (proxiedSrc && src) {
    avatarCache.set(src, proxiedSrc);
  }

  // 如果当前还没加载出来，尝试同步从缓存里拿上一次加载的图
  const finalSrc = proxiedSrc || (src ? avatarCache.get(src) : '');

  if (finalSrc) {
    return <Avatar {...rest} src={finalSrc} />;
  }

  return <Avatar {...rest} />;
};