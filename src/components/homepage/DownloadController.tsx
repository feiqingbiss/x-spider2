/* eslint-disable react/prop-types */
import { App, Button, Checkbox, DatePicker, Form } from 'antd';
import dayjs from 'dayjs';
import React from 'react';
import { useShallow } from 'zustand/react/shallow';
import MediaType from '../../enums/MediaType';
import { DownloadFilter } from '../../interfaces/DownloadFilter';
import { useDownloadStore } from '../../stores/download';
import { useHomepageStore } from '../../stores/homepage';
import { useSettingsStore } from '../../stores/settings';
import { useAppStateStore } from '../../stores/app-state';
import { addUserToDownloadList } from '../../utils/homepage-helpers';
import { DownloadOutlined } from '@ant-design/icons';

export const DownloadController: React.FC = () => {
  const { message } = App.useApp();
  const { filter, setFilter, user } = useHomepageStore(
    useShallow((s) => ({
      filter: s.filter,
      setFilter: s.setFilter,
      user: s.userInfo.data,
    })),
  );
  const createCreationTask = useDownloadStore((s) => s.createCreationTask);
  const addSessionUsers = useDownloadStore((s) => s.addSessionUsers);
  const saveDirBase = useSettingsStore((s) => s.download.saveDirBase);
  const bumpUserListRevision = useAppStateStore((s) => s.bumpUserListRevision);

  const onStartDownload = async () => {
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
        // ✅ 把该用户加入下载名单（去重）
        const added = await addUserToDownloadList(user.screenName, saveDirBase);
        if (added) {
          bumpUserListRevision();
        }
        // ✅ 计入本次下载会话
        addSessionUsers([user.screenName]);
      }

      createCreationTask(user, filter);
      message.success('已成功创建下载任务，请到下载管理页查看');
    } catch (err: any) {
      window.log.error(err);
      message.error('创建下载任务失败');
    }
  };

  return (
    <section className="p-4 bg-white rounded-md border-[1px] flex flex-col justify-between h-full">
      <div>
        <h2 className="font-bold mb-4 flex items-center text-gray-800">
          全局下载筛选配置
          <span className="text-xs text-gray-400 font-normal ml-2">(对单独下载及批量下载均生效)</span>
        </h2>
        <Form<DownloadFilter>
          layout="inline"
          initialValues={filter}
          onValuesChange={(_, values) => {
            setFilter(values);
          }}
          className="gap-y-4"
        >
          <Form.Item name="dateRange" label="日期范围">
            <DatePicker.RangePicker
              presets={[
                { label: '至今', value: [dayjs.unix(0), dayjs()] },
                {
                  label: '最近 7 天',
                  value: [dayjs().subtract(7, 'day'), dayjs()],
                },
                {
                  label: '最近 15 天',
                  value: [dayjs().subtract(15, 'day'), dayjs()],
                },
                {
                  label: '最近 1 个月',
                  value: [dayjs().subtract(1, 'month'), dayjs()],
                },
                {
                  label: '最近 6 个月',
                  value: [dayjs().subtract(6, 'month'), dayjs()],
                },
                {
                  label: '最近 1 年',
                  value: [dayjs().subtract(1, 'year'), dayjs()],
                },
              ]}
              disabledDate={(cur) => cur && cur > dayjs().endOf('day')}
            />
          </Form.Item>
          <Form.Item name="mediaTypes" label="媒体类型">
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
      
      <div className="mt-4 pt-4 border-t border-gray-100 flex items-center gap-3">
        <Button 
          type="primary" 
          onClick={onStartDownload} 
          disabled={!user}
          icon={<DownloadOutlined />}
        >
          下载当前用户
        </Button>
        {!user && (
          <span className="text-xs text-gray-400">请先在顶部搜索并加载需要下载的用户</span>
        )}
      </div>
    </section>
  );
};