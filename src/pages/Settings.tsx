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
      const downloadState = useDownloadStore.getState();
      const stats = {
        downloadTasks: downloadState.downloadTasks.length,
        creationTasks: downloadState.creationTasks.length,
        batchProgress: downloadState.batchProgress,
      };

      // 读取 debug-dl.log（已限制为150KB）
      const dataDir = await path.appDataDir();
      const dlLogPath = await path.join(dataDir, 'logs', 'debug-dl.log');
      let dlLog = '';
      if (await fs.exists(dlLogPath)) {
        const full = await fs.readTextFile(dlLogPath);
        // 再截断一次确保不超过100KB
        dlLog = full.length > 100 * 1024 ? full.slice(-100 * 1024) : full;
      } else {
        dlLog = '[debug-dl.log 不存在]';
      }

      // 可选：读取应用日志（最新1个文件，截取50KB）
      const logDir = await path.appLogDir();
      let appLog = '';
      if (await fs.exists(logDir)) {
        const entries = await fs.readDir(logDir);
        const logFiles = entries
          .filter(e => e.name?.endsWith('.log'))
          .sort((a, b) => (b.name || '').localeCompare(a.name || ''));
        if (logFiles.length > 0) {
          const latestLog = await path.join(logDir, logFiles[0].name!);
          try {
            const fullAppLog = await fs.readTextFile(latestLog);
            appLog = fullAppLog.slice(-50 * 1024);
          } catch { appLog = '[无法读取]'; }
        }
      }

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
        `--- 下载调试日志 (debug-dl.log，最后100KB) ---`,
        dlLog,
        ``,
        `--- 应用日志 (最近50KB) ---`,
        appLog,
      ].join('\n');

      const downloadDir = await path.downloadDir();
      const reportPath = await path.join(downloadDir, 'x-spider-debug-report.txt');
      await fs.writeTextFile(reportPath, report);
      message.success(`报告已保存到 ${reportPath}`);
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