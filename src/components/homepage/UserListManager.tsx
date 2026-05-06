import React, { useEffect, useMemo, useState } from 'react';
import { Modal, Input, Button, List, Space, App } from 'antd';
import {
  PlusOutlined,
  DeleteOutlined,
  FolderOpenOutlined,
  SearchOutlined,
  DiffOutlined,
} from '@ant-design/icons';
import { path, fs, shell } from '@tauri-apps/api';
import { useAppStateStore } from '../../stores/app-state';
import { useSettingsStore } from '../../stores/settings';

interface Props {
  visible: boolean;
  onClose: () => void;
  onChanged?: () => void;
}

export const UserListManager: React.FC<Props> = ({
  visible,
  onClose,
  onChanged,
}) => {
  const { message } = App.useApp();
  const [users, setUsers] = useState<string[]>([]);
  const [newUser, setNewUser] = useState('');
  const [searchKeyword, setSearchKeyword] = useState('');

  const saveDirBase = useSettingsStore((s) => s.download.saveDirBase);

  // 获取 search-user-name.txt 路径
  const getListFilePath = async (): Promise<string> => {
    const baseDir = saveDirBase || await path.appDataDir();
    return await path.join(baseDir, 'search-user-name.txt');
  };

  const fetchUsers = async () => {
    try {
      const filePath = await getListFilePath();
      const content = await fs.readTextFile(filePath);
      const lines = content.split('\n');
      const names = lines
        .map((line) =>
          line
            .replace(/^https?:\/\/x\.com\/?/i, '')
            .replace(/^@/, '')
            .trim(),
        )
        .filter((n) => n.length > 0);
      setUsers(names);
    } catch (e) {
      setUsers([]);
    }
  };

  useEffect(() => {
    if (visible) fetchUsers();
  }, [visible]);

  const saveUsers = async (newUsers: string[]) => {
    const filePath = await getListFilePath();
    const content = newUsers.map((u) => `https://x.com/${u}`).join('\n');
    await fs.writeTextFile(filePath, content);
    const appStore = useAppStateStore.getState();
    appStore.importHistoryFromFile();
    onChanged?.();
  };

  const openListFile = async () => {
    try {
      const filePath = await getListFilePath();
      await shell.open(filePath);
    } catch (err) {
      message.error('无法打开名单文件');
    }
  };

  const extractUsername = (input: string): string => {
    return input
      .trim()
      .replace(/^@/, '')
      .replace(/^https?:\/\/x\.com\/?/i, '');
  };

  const handleAdd = async () => {
    const name = extractUsername(newUser);
    if (!name) {
      message.warning('请输入有效的用户名');
      return;
    }
    if (users.includes(name)) {
      message.warning('该用户已在名单中');
      return;
    }
    const newList = [...users, name];
    await saveUsers(newList);
    setUsers(newList);
    setNewUser('');
    message.success('添加成功');
  };

  const handleDelete = async (name: string) => {
    const newList = users.filter((u) => u !== name);
    await saveUsers(newList);
    setUsers(newList);
    message.success(`已移除 ${name}`);
    if (extractUsername(newUser) === name) {
      setNewUser('');
    }
  };

  const handleDeleteByInput = async () => {
    const name = extractUsername(newUser);
    if (!name) {
      message.warning('请输入要删除的用户名');
      return;
    }
    if (!users.includes(name)) {
      message.warning('该用户不在名单中');
      return;
    }
    await handleDelete(name);
  };

  const handleCompareFolders = async () => {
    if (!saveDirBase) {
      message.error('请先在设置中配置下载保存路径');
      return;
    }
    try {
      if (!(await fs.exists(saveDirBase))) {
        message.error('下载目录不存在，请检查设置');
        return;
      }

      const entries = await fs.readDir(saveDirBase);
      const folderNames = entries
        .filter((entry) => entry.children !== undefined || entry.name)
        .map((entry) => entry.name)
        .filter((name) => !!name);

      if (folderNames.length === 0) {
        return;
      }

      const filePath = await getListFilePath();
      let listContent = '';
      try {
        listContent = await fs.readTextFile(filePath);
      } catch (e) {}

      const listUsernames = listContent
        .split('\n')
        .map((line) =>
          line
            .replace(/^https?:\/\/x\.com\/?/i, '')
            .replace(/^@/, '')
            .trim(),
        )
        .filter((n) => n.length > 0);

      const invalidFolders = folderNames.filter(
        (folder) => !listUsernames.includes(folder),
      );

      const outputPath = await path.join(saveDirBase, 'invalid_folders.txt');
      await fs.writeTextFile(outputPath, invalidFolders.join('\n'));
    } catch (err: any) {
      message.error(`对比失败：${err?.message || '未知错误'}`);
    }
  };

  const filteredUsers = useMemo(() => {
    if (!searchKeyword.trim()) return users;
    const kw = searchKeyword.trim().toLowerCase();
    return users.filter((u) => u.toLowerCase().includes(kw));
  }, [users, searchKeyword]);

  return (
    <Modal
      title="管理下载名单"
      visible={visible}
      onCancel={onClose}
      footer={null}
      width={500}
    >
      <Space direction="vertical" style={{ width: '100%' }}>
        <Space wrap>
          <Input
            placeholder="用户名、@用户名 或链接"
            value={newUser}
            onChange={(e) => setNewUser(e.target.value)}
            onPressEnter={handleAdd}
            style={{ width: 180 }}
          />
          <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>
            添加
          </Button>
          <Button
            danger
            icon={<DeleteOutlined />}
            onClick={handleDeleteByInput}
          >
            删除
          </Button>
          <Button icon={<FolderOpenOutlined />} onClick={openListFile}>
            打开文件
          </Button>
          <Button icon={<DiffOutlined />} onClick={handleCompareFolders}>
            对比下载目录
          </Button>
        </Space>

        <Input
          placeholder="搜索用户名..."
          prefix={<SearchOutlined />}
          value={searchKeyword}
          onChange={(e) => setSearchKeyword(e.target.value)}
          allowClear
        />

        <List
          dataSource={filteredUsers}
          renderItem={(item) => (
            <List.Item
              actions={[
                <Button
                  key="delete"
                  type="text"
                  danger
                  icon={<DeleteOutlined />}
                  onClick={() => handleDelete(item)}
                >
                  删除
                </Button>,
              ]}
            >
              <span className="truncate max-w-[300px]">{item}</span>
            </List.Item>
          )}
        />
      </Space>
    </Modal>
  );
};