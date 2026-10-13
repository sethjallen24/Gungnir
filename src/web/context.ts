import { createContext, useContext } from 'react';
import type { Client, ServerStatus, User } from '../shared/types';

export interface AppState {
  user: User;
  status: ServerStatus;
  clients: Client[];
  reloadClients: () => Promise<void>;
  signOut: () => Promise<void>;
}

export const AppContext = createContext<AppState | null>(null);

export function useApp(): AppState {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp outside AppContext');
  return ctx;
}
