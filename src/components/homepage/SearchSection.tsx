/* eslint-disable react/prop-types */
import { Button, Input, Space } from 'antd';
import {
  DownOutlined,
  HistoryOutlined,
  UpOutlined,
} from '@ant-design/icons';
import React, { useState } from 'react';

export interface SearchSectionProps {
  keyword: string;
  setKeyword: (v: string) => void;
  onSearch: (sn: string) => void;
  loading: boolean;
  disabled: boolean;
  placeholder: string;
  searchHistory: string[];
  onClearHistory: () => void;
}

export const SearchSection: React.FC<SearchSectionProps> = ({
  keyword,
  setKeyword,
  onSearch,
  loading,
  disabled,
  placeholder,
  searchHistory,
  onClearHistory,
}) => {
  const [historyVisible, setHistoryVisible] = useState(true);

  return (
    <section aria-label="搜索用户">
      <Space.Compact block>
        <Input
          disabled={disabled}
          onPressEnter={() => onSearch(keyword)}
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          placeholder={placeholder}
          className="text-center"
        />
        <Button
          disabled={!keyword || disabled}
          loading={loading}
          onClick={() => onSearch(keyword)}
          type="primary"
        >
          加载
        </Button>
      </Space.Compact>

      {searchHistory.length > 0 && (
        <div className="mt-1">
          <div className="flex items-center justify-between h-5">
            <Button
              type="text"
              size="small"
              className="text-gray-400 !p-0 flex items-center"
              onClick={() => setHistoryVisible(!historyVisible)}
            >
              <HistoryOutlined className="mr-1 text-xs" />
              <span className="text-[11px]">
                搜索历史 ({searchHistory.length})
              </span>
              {historyVisible ? (
                <UpOutlined className="ml-1 text-[9px]" />
              ) : (
                <DownOutlined className="ml-1 text-[9px]" />
              )}
            </Button>
            {historyVisible && (
              <Button
                type="link"
                size="small"
                onClick={onClearHistory}
                className="!p-0 text-[11px] text-gray-400/60 hover:text-red-400"
              >
                清空
              </Button>
            )}
          </div>

          {historyVisible && (
            <div className="mt-1 overflow-x-auto scrollbar-hide bg-gray-50/50 p-1 rounded">
              <div className="flex flex-nowrap gap-x-4 items-center min-w-max">
                {searchHistory.map((sn) => (
                  <Button
                    key={sn}
                    type="link"
                    size="small"
                    className="!p-0 text-[12px] text-blue-400 hover:text-blue-600 whitespace-nowrap"
                    onClick={() => {
                      setKeyword(sn);
                      onSearch(sn);
                    }}
                  >
                    {sn}
                  </Button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
};