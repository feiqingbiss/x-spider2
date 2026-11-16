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
    <section className="h-full">
      <Card
        size="small"
        className="bg-blue-50/20 border-blue-100/50 shadow-sm h-full flex flex-col"
        bodyStyle={{ padding: '16px', flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}
      >
        <div>
          <h2 className="font-bold mb-4 flex items-center text-gray-800">
            批量下载控制台
          </h2>
          <div className="flex items-center justify-between flex-wrap gap-y-2">
            <div className="flex items-center">
              <span className="text-gray-400 text-sm">名单用户：</span>
              <b className="text-lg text-blue-500 ml-1">{userListCount}</b>
            </div>

            <Space size="middle" align="center" wrap>
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
            </Space>
          </div>
        </div>

        <div className="mt-4 pt-4 border-t border-blue-100/50">
          {batchProgress ? (
            <div className="mb-3">
              <Progress
                percent={batchProgress.total > 0 ? Math.round((batchProgress.completed / batchProgress.total) * 100) : 0}
                format={() =>
                  `${batchProgress.completed}/${batchProgress.total}`
                }
                status="active"
                strokeColor="#1d9bf0"
              />
              <div className="text-xs text-gray-500 mt-1">
                正在处理：{batchProgress.currentUser}
              </div>
            </div>
          ) : (
            <div className="mb-3 text-xs text-gray-400">
              将使用上方“全局下载筛选配置”对名单内的所有用户进行批量任务创建。
            </div>
          )}

          <Button
            type="primary"
            danger={isBatchRunning}
            icon={isBatchRunning ? <CloseCircleOutlined /> : <CloudDownloadOutlined />}
            onClick={isBatchRunning ? onCancelBatch : onBatchDownload}
            disabled={!isBatchRunning && !!batchProgress}
            className="font-bold w-full"
          >
            {isBatchRunning ? '取消批量下载' : '一键批量下载'}
          </Button>
        </div>
      </Card>
    </section>
  );
};