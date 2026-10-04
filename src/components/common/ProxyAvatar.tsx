/* eslint-disable react/prop-types */
import { Avatar } from 'antd';
import type { AvatarProps } from 'antd';
import React from 'react';
import { useProxiedImageUrl } from '../../hooks/useProxiedImageUrl';

export interface ProxyAvatarProps extends Omit<AvatarProps, 'src'> {
  src?: string;
}

/**
 * 头像组件：自动走 Rust 代理下载图片。
 * - 加载中：显示 antd 默认头像（首字母/图标）
 * - 加载失败：显示 antd 默认头像
 * - 加载成功：显示代理缓存后的图片
 */
export const ProxyAvatar: React.FC<ProxyAvatarProps> = ({ src, ...rest }) => {
  const { src: proxiedSrc, status } = useProxiedImageUrl(src);

  if (status === 'success' && proxiedSrc) {
    return <Avatar {...rest} src={proxiedSrc} />;
  }

  // loading / error / idle 都显示默认占位
  return <Avatar {...rest} />;
};