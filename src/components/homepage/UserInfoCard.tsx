/* eslint-disable react/prop-types */
import { Avatar } from 'antd';
import React from 'react';
import { TwitterUser } from '../../interfaces/TwitterUser';
import { buildUserUrl } from '../../twitter/url';

export interface UserInfoCardProps {
  user: TwitterUser;
}

export const UserInfoCard: React.FC<UserInfoCardProps> = ({ user }) => {
  return (
    <section
      aria-label="用户信息"
      className="bg-white border-[1px] border-gray-300 rounded-md mt-4 p-4"
    >
      <a
        className="flex items-center"
        href={user.screenName ? buildUserUrl(user.screenName) : '#'}
        target="_blank"
        rel="noreferrer"
      >
        <Avatar src={user.avatar} size={50} />
        <div className="ml-3">
          <p className="text-base font-bold mb-0">
            {user.name || '未知用户'}
            <span className="text-gray-400 font-normal ml-2 text-xs">
              ({user.mediaCount || 0} 媒体)
            </span>
          </p>
          <p className="text-gray-400 text-sm">@{user.screenName}</p>
        </div>
      </a>
    </section>
  );
};