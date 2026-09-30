import { create } from 'zustand';

export interface Toast {
  id: number;
  kind: 'info' | 'ok' | 'error';
  message: string;
}

interface ToastStore {
  toasts: Toast[];
  push: (kind: Toast['kind'], message: string) => void;
  dismiss: (id: number) => void;
}

let nextId = 1;

export const useToasts = create<ToastStore>((set, get) => ({
  toasts: [],
  push(kind, message) {
    const id = nextId++;
    set((s) => ({ toasts: [...s.toasts.slice(-3), { id, kind, message }] }));
    setTimeout(() => get().dismiss(id), kind === 'error' ? 8000 : 4000);
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

export const toast = {
  info: (m: string) => useToasts.getState().push('info', m),
  ok: (m: string) => useToasts.getState().push('ok', m),
  error: (m: string) => useToasts.getState().push('error', m),
};

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
