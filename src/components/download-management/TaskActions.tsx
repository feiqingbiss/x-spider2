/* eslint-disable react/prop-types */
import clsx from 'clsx';
import React from 'react';

export interface TaskAction {
  name: string;
  icon?: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
  primary?: boolean;
}

export interface TaskActionsProps {
  actions: TaskAction[];
}

export const TaskActions: React.FC<TaskActionsProps> = ({ actions }) => {
  return (
    <ul className="flex flex-wrap gap-1.5 text-xs">
      {actions.map((action) => (
        <li key={action.name}>
          <button
            onClick={action.onClick}
            aria-label={action.name}
            title={action.name}
            className={clsx(
              'flex items-center gap-1 px-2.5 py-1 rounded-md border transition-all',
              'active:scale-95',
              action.primary &&
                'text-blue-600 bg-blue-50 border-blue-200 hover:bg-blue-100 hover:border-blue-300',
              action.danger &&
                'text-red-600 bg-red-50 border-red-200 hover:bg-red-100 hover:border-red-300',
              !action.primary &&
                !action.danger &&
                'text-gray-600 bg-gray-50 border-gray-200 hover:bg-gray-100 hover:border-gray-300',
            )}
          >
            {action.icon && (
              <span className="text-[13px] leading-none">{action.icon}</span>
            )}
            <span className="leading-none">{action.name}</span>
          </button>
        </li>
      ))}
    </ul>
  );
};