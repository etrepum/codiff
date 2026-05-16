import type {
  CodiffPreferences,
  RepositoryHistory,
  RepositoryState,
  ReviewSource,
} from './types.ts';

declare global {
  interface Window {
    codiff: {
      getPreferences: () => Promise<CodiffPreferences>;
      getRepositoryHistory: (limit?: number) => Promise<RepositoryHistory>;
      getRepositoryState: (source?: ReviewSource) => Promise<RepositoryState>;
      onPreferencesChanged: (callback: (preferences: CodiffPreferences) => void) => () => void;
      onRepositoryChanged: (callback: (change: { root: string }) => void) => () => void;
      showInFolder: (path: string) => Promise<void>;
    };
  }
}
