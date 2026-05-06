/* eslint-disable react/prop-types */
import React from 'react';
import { PageHeader } from '../components/PageHeader';
import { Section } from '../components/settings/Section';
import { Item } from '../components/settings/Item';
import { DownloadOutlined, GlobalOutlined } from '@ant-design/icons';
import Joi from 'joi';
import { SavePathSelector } from '../components/settings/SavePathSelector';
import { Button, Input, Switch } from 'antd';
import { FileNameTemplateInput } from '../components/settings/FileNameTemplateInput';
import { showInFolder } from '../utils/shell';
import { path } from '@tauri-apps/api';

export const Settings: React.FC = () => {
  return (
    <>
      <PageHeader />
      <Section title="下载设置" name="download" titleIcon={<DownloadOutlined />}>
        <Item validator={(v) => Joi.string().messages({'string.empty': '请选择路径'}).validate(v).error?.message} label="保存路径" settingKey="saveDirBase">
          <SavePathSelector required />
        </Item>
        <Item label="文件夹模板" settingKey="dirTemplate" description="自定义文件夹命名规则">
          <FileNameTemplateInput />
        </Item>
        <Item settingKey="sameFileSkip" label="跳过相同文件" valuePropName="checked">
          <Switch />
        </Item>
      </Section>
      <Section title="网络代理" name="proxy" titleIcon={<GlobalOutlined />}>
        <Item label="启用代理" settingKey="enable" valuePropName="checked"><Switch /></Item>
        <Item label="代理地址" settingKey="url"><Input placeholder="http://127.0.0.1:7890" /></Item>
      </Section>
      <Section title="应用常规" name="app">
        <Item label="自动更新" settingKey="autoCheckUpdate" valuePropName="checked"><Switch /></Item>
        <Button onClick={async () => showInFolder(await path.appLogDir())}>打开日志文件夹</Button>
      </Section>
    </>
  );
};
