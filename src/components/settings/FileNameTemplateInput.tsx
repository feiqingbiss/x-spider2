/* eslint-disable react/prop-types */
import React, { useId } from 'react';
import { Input } from 'antd';
import { VariablePicker } from './VariablePicker';
import { TemplateExample } from './TemplateExample';

export interface FileNameTemplateInputProps {
  value?: string;
  onChange?: (value: string) => void;
  id?: string;
}

export const FileNameTemplateInput: React.FC<FileNameTemplateInputProps> = ({
  value,
  onChange,
  id,
}) => {
  // 生成唯一 ID，避免"文件夹模板"和"文件名模板"两个实例 id 冲突
  const autoId = useId();
  const inputId = id ?? `file-name-template-input-${autoId}`;
  const variablesId = `${inputId}-variables`;

  return (
    <div>
      <VariablePicker id={variablesId} />
      <Input
        id={inputId}
        placeholder="请输入内容，支持使用变量"
        aria-describedby={variablesId}
        value={value}
        onChange={(e) => onChange?.(e.target.value)}
      />
      <TemplateExample value={value} />
    </div>
  );
};