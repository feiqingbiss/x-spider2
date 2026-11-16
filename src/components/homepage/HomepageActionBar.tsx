/* eslint-disable react/prop-types */
import React from 'react';
import { Card, Button, Checkbox, DatePicker, Form, Space, Switch, Tooltip, Progress, App } from 'antd';
import dayjs from 'dayjs';
import { 
  CloudDownloadOutlined, 
  CloseCircleOutlined, 
  FileTextOutlined, 
  ThunderboltFilled,
  DownloadOutlined 
} from '@ant-design/icons';
import MediaType from '../../enums/MediaType';
import { DownloadFilter } from '../../interfaces/DownloadFilter';
import { useHomepageStore } from '../../stores/homepage';
import { useDownloadStore } from '../../stores/download';
import { useSettingsStore } from '../../stores/settings';
import { useAppStateStore } from '../../stores/app-state';
import { addUserToDownloadList } from '../../utils/homepage-helpers';

export interface HomepageActionBarProps {
  userListCount: number;
  onManageList: () => void;
  isBatchRunning: boolean;
  batchProgress: { total: number; completed: number; currentUser: string } | null;
  onBatchDownload: () => void;
  onCancelBatch: () => void;
}

export const HomepageActionBar: React.FC<HomepageActionBarProps> = ({
  userListCount,
  onManageList,
  isBatchRunning,
  batchProgress,
  onBatchDownload,
  onCancelBatch,
}) => {
  const { message } = App.useApp();

  const { filter, setFilter, user } = useHomepageStore(
    (s) => ({
      filter: s.filter,
      setFilter: s.setFilter,
      user: s.userInfo.data,
    })
  );
  const createCreationTask = useDownloadStore((s) => s.createCreationTask);
  const addSessionUsers = useDownloadStore((s) => s.addSessionUsers);
  const saveDirBase = useSettingsStore((s) => s.download.saveDirBase);
  const forceFullScan = useAppStateStore((s) => s.forceFullScan);
  const setForceFullScan = useAppStateStore((s) => s.setForceFullScan);
  const bumpUserListRevision = useAppStateStore((s) => s.bumpUserListRevision);

  const onStartSingleDownload = async () => {
    if (!user) {
      message.error('请先加载用户');
      return;
    }
    if (!filter.mediaTypes || filter.mediaTypes.length === 0) {
      message.error('请至少选择一个媒体类型');
      return;
    }

    try {
      if (user.screenName) {
        const added = await addUserToDownloadList(user.screenName, saveDirBase);
        if (added) bumpUserListRevision();
        addSessionUsers([user.screenName]);
      }
      // 这里的 createCreationTask 底层会读取 useAppStateStore 的 forceFullScan
      createCreationTask(user, filter);
      message.success('已成功创建当前用户的下载任务');
    } catch (err: any) {
      window.log.error(err);
      message.error('创建下载任务失败');
    }
  };

  return (
    <Card
      size="small"
      className="bg-blue-50/20 border-blue-100/50 shadow-sm"
      bodyStyle={{ padding: '16px' }}
    >
      <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-4">
        {/* 左侧：全局筛选配置 */}
        <div className="flex items-center flex-wrap gap-4">
          <Form<DownloadFilter>
            layout="inline"
            initialValues={filter}
            onValuesChange={(_, values) => setFilter(values)}
            className="gap-y-2"
          >
            <Form.Item name="dateRange" label="日期范围" className="mb-0">
              <DatePicker.RangePicker
                size="small"
                className="w-[240px]"
                presets={[
                  { label: '至今', value: [dayjs.unix(0), dayjs()] },
                  { label: '最近 7 天', value: [dayjs().subtract(7, 'day'), dayjs()] },
                  { label: '最近 15 天', value: [dayjs().subtract(15, 'day'), dayjs()] },
                  { label: '最近 1 个月', value: [dayjs().subtract(1, 'month'), dayjs()] },
                  { label: '最近 6 个月', value: [dayjs().subtract(6, 'month'), dayjs()] },
                  { label: '最近 1 年', value: [dayjs().subtract(1, 'year'), dayjs()] },
                ]}
                disabledDate={(cur) => cur && cur > dayjs().endOf('day')}
              />
            </Form.Item>
            <Form.Item name="mediaTypes" label="媒体类型" className="mb-0">
              <Checkbox.Group
                options={[
                  { label: '视频', value: MediaType.Video },
                  { label: '照片', value: MediaType.Photo },
                  { label: 'GIF', value: MediaType.Gif },
                ]}
              />
            </Form.Item>
          </Form>
        </div>

        {/* 右侧：操作控制区 */}
        <div className="flex items-center flex-wrap gap-3 shrink-0">
          <Button icon={<FileTextOutlined />} onClick={onManageList}>
            管理名单 ({userListCount})
          </Button>

          <Tooltip
            title={
              forceFullScan
                ? '当前：完整遍历。将忽略预检结果，遍历用户所有历史帖子（速度较慢，但最全）'
                : '当前：快速补全。前 20 条已下载 ≥ 15% 时仅补缺失；< 15% 时全量遍历'
            }
          >
            <div
              className="flex items-center cursor-pointer select-none px-2 bg-white rounded-md border border-gray-200 py-1"
              onClick={() => setForceFullScan(!forceFullScan)}
            >
              <Switch size="small" checked={forceFullScan} onChange={(v) => setForceFullScan(v)} />
              <span className={forceFullScan ? 'ml-2 text-orange-500 font-bold text-xs' : 'ml-2 text-gray-400 text-xs'}>
                {forceFullScan ? <><ThunderboltFilled className="mr-1" />完整遍历</> : '快速补全'}
              </span>
            </div>
          </Tooltip>

          <Space>
            <Button
              type="primary"
              icon={<DownloadOutlined />}
              onClick={onStartSingleDownload}
              disabled={!user}
            >
              下载当前用户
            </Button>
            <Button
              type="primary"
              danger={isBatchRunning}
              icon={isBatchRunning ? <CloseCircleOutlined /> : <CloudDownloadOutlined />}
              onClick={isBatchRunning ? onCancelBatch : onBatchDownload}
              disabled={!isBatchRunning && !!batchProgress}
              className="font-bold"
            >
              {isBatchRunning ? '取消批量' : '一键批量下载'}
            </Button>
          </Space>
        </div>
      </div>

      {/* 底部进度条 */}
      {batchProgress && (
        <div className="mt-3 pt-3 border-t border-blue-100/50">
          <Progress
            percent={batchProgress.total > 0 ? Math.round((batchProgress.completed / batchProgress.total) * 100) : 0}
            format={() => `${batchProgress.completed}/${batchProgress.total}`}
            status="active"
            strokeColor="#1d9bf0"
            size="small"
          />
          <div className="text-xs text-gray-500 mt-1 flex justify-between">
            <span>正在处理：{batchProgress.currentUser}</span>
            <span>批量任务受左侧配置及遍历开关控制</span>
          </div>
        </div>
      )}
    </Card>
  );
};