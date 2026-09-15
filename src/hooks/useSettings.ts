import { useShallow } from 'zustand/react/shallow';
import { useSettingsStore } from '../stores/settings';
import * as R from 'ramda';

export interface UseSettingsReturn<T> {
  value: T;
  setValue: (value: T) => Promise<void>;
}

export function useSettings<T>(
  name: string,
  key: string,
): UseSettingsReturn<T> {
  // ✅ 优化：useShallow
  const [value, updateOne] = useSettingsStore(
    useShallow((state) => [
      R.path<T>([name, key])(state),
      state.updateOne,
    ]),
  );

  return {
    value: value as T,
    setValue: async (newVal) => {
      await updateOne(name, key, newVal);
    },
  };
}