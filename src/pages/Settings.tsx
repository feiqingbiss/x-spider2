/* eslint-disable react/prop-types */
import React from 'react';
import { PageHeader } from '../components/PageHeader';
import { Section } from '../components/settings/Section';
import { Item } from '../components/settings/Item';
import { DownloadOutlined, GlobalOutlined, BugOutlined } from '@ant-design/icons';
import Joi from 'joi';
import { SavePathSelector } from '../components/settings/SavePathSelector';
import { Button, Input, Switch, Space, App } from 'antd';
import { FileNameTemplateInput } from '../components/settings/FileNameTemplateInput';
import { showInFolder } from '../utils/shell';
import { path, fs, shell } from '@tauri-apps/api';
import { useDownloadStore } from '../stores/download';

export const Settings: React.FC = () => {
  const { message } = App.useApp();

  const exportDebugReport = async () => {
    try {
      // 收集基本状态
      const downloadState = useDownloadStore.getState();
      const stats = {
        downloadTasks: downloadState.downloadTasks.length,
        creationTasks: downloadState.creationTasks.length,
        batchProgress: downloadState.batchProgress,
      };

      // 获取日志目录并读取最新日志文件
      const logDir = await path.appLogDir();
      let logContent = '';
      if (await fs.exists(logDir)) {
        const entries = await fs.readDir(logDir);
        const logFiles = entries
          .filter((e) => e.name?.endsWith('.log'))
          .sort((a, b) => (b.name || '').localeCompare(a.name || ''));

        if (logFiles.length > 0) {
          const latestLogPath = await path.join(logDir, logFiles[0].name!);
          try {
            logContent = await fs.readTextFile(latestLogPath);
          } catch (e) {
            logContent = '[无法读取日志文件]';
          }
        } else {
          logContent = '[无日志文件]';
        }
      } else {
        logContent = '[日志目录不存在]';
      }

      // 生成报告
      const report = [
        `=== X-Spider 调试报告 ===`,
        `生成时间: ${new Date().toISOString()}`,
        `版本: ${PACKAGE_JSON_VERSION}`,
        `操作系统: ${navigator.platform}`,
        ``,
        `--- 下载任务统计 ---`,
        `下载任务: ${stats.downloadTasks}`,
        `创建任务: ${stats.creationTasks}`,
        `批量进度: ${stats.batchProgress ? JSON.stringify(stats.batchProgress) : '无'}`,
        ``,
        `--- 应用日志 (最近部分) ---`,
        logContent.slice(-200000), // 限制 200KB 防止过大
      ].join('\n');

      // 写入到下载目录
      const downloadDir = await path.downloadDir();
      const reportPath = await path.join(downloadDir, 'x-spider-debug-report.txt');
      await fs.writeTextFile(reportPath, report);
      
      message.success(`报告已保存到 ${reportPath}`);
      // 打开所在文件夹
      await shell.open(downloadDir);
    } catch (err: any) {
      message.error(`导出失败: ${err?.message || '未知错误'}`);
    }
  };

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
        <Space>
          <Button onClick={async () => showInFolder(await path.appLogDir())}>打开日志文件夹</Button>
          <Button icon={<BugOutlined />} onClick={exportDebugReport}>导出诊断报告</Button>
        </Space>
      </Section>
    </>
  );
};