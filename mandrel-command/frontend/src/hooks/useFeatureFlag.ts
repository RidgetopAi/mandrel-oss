import { useFeatureFlags } from '../contexts/FeatureFlagContext';

export function useFeatureFlag(name: string, defaultValue = false): boolean {
  const { isEnabled } = useFeatureFlags();
  return isEnabled(name, defaultValue);
}

export default useFeatureFlag;
