import React, { useEffect, useState } from 'react';
import { Modal, Input, Button, List, Space, App } from 'antd';
import { PlusOutlined, DeleteOutlined, FolderOpenOutlined } from '@ant-design/icons';
import { path, fs, shell } from '@tauri-apps/api';
import { useAppStateStore } from '../../stores/app-state';

interface Props {
  visible: boolean;
  onClose: () => void;
  onChanged?: () => void; // 添加此属性定义
}

export const UserListManager: React.FC<Props> = ({ visible, onClose, onChanged }) => {
  const { message } = App.useApp();
  const [users, setUsers] = useState<string[]>([]);
  const [newUser, setNewUser] = useState('');

  const fetchUsers = async () => {
    try {
      const rootDir = await path.appDataDir();
      const filePath = await path.join(rootDir, 'search-user-name.txt');
      const content = await fs.readTextFile(filePath);
      const lines = content.split('\n');
      const names = lines
        .map(line => line.replace(/^https?:\/\/x\.com\/?/i, '').replace(/^@/, '').trim())
        .filter(n => n.length > 0);
      setUsers(names);
    } catch (e) {
      setUsers([]);
    }
  };

  useEffect(() => {
    if (visible) fetchUsers();
  }, [visible]);

  const saveUsers = async (newUsers: string[]) => {
    const rootDir = await path.appDataDir();
    const filePath = await path.join(rootDir, 'search-user-name.txt');
    const content = newUsers.map(u => `https://x.com/${u}`).join('\n');
    await fs.writeTextFile(filePath, content);
    const appStore = useAppStateStore.getState();
    appStore.importHistoryFromFile();
    onChanged?.();
  };

  const openListFile = async () => {
    try {
      const rootDir = await path.appDataDir();
      const filePath = await path.join(rootDir, 'search-user-name.txt');
      await shell.open(filePath);
    } catch (err) {
      message.error('无法打开名单文件');
    }
  };

  const handleAdd = async () => {
    const name = newUser.trim().replace(/^@/, '').replace(/^https?:\/\/x\.com\/?/i, '');
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
    const newList = users.filter(u => u !== name);
    await saveUsers(newList);
    setUsers(newList);
    message.success('删除成功');
  };

  return (
    <Modal
      title="管理下载名单"
      visible={visible}
      onCancel={onClose}
      footer={null}
      width={500}
    >
      <Space direction="vertical" style={{ width: '100%' }}>
        <Space>
          <Input
            placeholder="用户名、@用户名 或链接"
            value={newUser}
            onChange={e => setNewUser(e.target.value)}
            onPressEnter={handleAdd}
          />
          <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>添加</Button>
          <Button icon={<FolderOpenOutlined />} onClick={openListFile}>打开文件</Button>
        </Space>
        <List
          dataSource={users}
          renderItem={item => (
            <List.Item
              actions={[
                <Button
                  type="text"
                  danger
                  icon={<DeleteOutlined />}
                  onClick={() => handleDelete(item)}
                />
              ]}
            >
              {item}
            </List.Item>
          )}
        />
      </Space>
    </Modal>
  );
};