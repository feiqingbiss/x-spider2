/* eslint-disable react/prop-types */
import { Card, Button, Space, Switch, Tooltip, Progress } from 'antd';
import {
  CloudDownloadOutlined,
  CloseCircleOutlined,
  FileTextOutlined,
  ThunderboltFilled,
} from '@ant-design/icons';
import React from 'react';

export interface BatchDownloadCardProps {
  userListCount: number;
  onManageList: () => void;
  forceFullScan: boolean;
  onToggleForceFullScan: (v: boolean) => void;
  isBatchRunning: boolean;
  batchProgress: { total: number; completed: number; currentUser: string } | null;
  onBatchDownload: () => void;
  onCancelBatch: () => void;
}

export const BatchDownloadCard: React.FC<BatchDownloadCardProps> = ({
  userListCount,
  onManageList,
  forceFullScan,
  onToggleForceFullScan,
  isBatchRunning,
  batchProgress,
  onBatchDownload,
  onCancelBatch,
}) => {
  return (
    <section className="mt-3">
      <Card
        size="small"
        className="bg-blue-50/20 border-blue-100/50 shadow-sm"
        bodyStyle={{ padding: '10px 16px' }}
      >
        <div className="flex items-center justify-between flex-wrap gap-y-2">
          <div className="flex items-center">
            <span className="text-gray-400 text-sm">名单用户：</span>
            <b className="text-lg text-blue-500 ml-1">{userListCount}</b>
          </div>

          <Space size="middle" align="center">
            <Button icon={<FileTextOutlined />} onClick={onManageList}>
              管理名单
            </Button>

            <Tooltip
              title={
                forceFullScan
                  ? '当前：完整遍历。将忽略预检结果，遍历用户所有历史帖子（速度较慢，但最全）'
                  : '当前：快速补全。前 20 条已下载 ≥ 15% 时仅补缺失；< 15% 时全量遍历'
              }
            >
              <div
                className="flex items-center cursor-pointer select-none px-2"
                onClick={() => onToggleForceFullScan(!forceFullScan)}
              >
                <Switch
                  size="small"
                  checked={forceFullScan}
                  onChange={(v) => onToggleForceFullScan(v)}
                />
                <span
                  className={
                    forceFullScan
                      ? 'ml-2 text-orange-500 font-bold text-xs'
                      : 'ml-2 text-gray-400 text-xs'
                  }
                >
                  {forceFullScan ? (
                    <>
                      <ThunderboltFilled className="mr-1" />
                      完整遍历
                    </>
                  ) : (
                    '快速补全'
                  )}
                </span>
              </div>
            </Tooltip>

            <Button
              type="primary"
              danger
              icon={
                isBatchRunning ? (
                  <CloseCircleOutlined />
                ) : (
                  <CloudDownloadOutlined />
                )
              }
              onClick={isBatchRunning ? onCancelBatch : onBatchDownload}
              disabled={!isBatchRunning && !!batchProgress}
              className="font-bold px-6"
            >
              {isBatchRunning ? '取消批量下载' : '一键批量下载'}
            </Button>
          </Space>
        </div>
        {batchProgress && (
          <div className="mt-3">
            <Progress
              percent={Math.round(
                (batchProgress.completed / batchProgress.total) * 100,
              )}
              format={() =>
                `${batchProgress.completed}/${batchProgress.total}`
              }
              status="active"
            />
            <div className="text-xs text-gray-500 mt-1">
              正在处理：{batchProgress.currentUser}
            </div>
          </div>
        )}
      </Card>
    </section>
  );
};