import { useCallback, useEffect, useRef, useState } from 'react';
import type { BtcHistory } from '../../../shared/types';
import { api } from '../../api';
import { errorMessage } from '../../state/toasts';

const REFRESH_MS = 5 * 60_000;

export interface BtcState {
  data?: BtcHistory & { stale?: boolean };
  /** True while (re)loading. Previous data stays available so the chart keeps its frame. */
  loading: boolean;
  error?: string;
  reload: () => void;
}

/** Bitcoin price history for a currency, refreshed every few minutes while mounted. */
export function useBtc(currency: string): BtcState {
  const [state, setState] = useState<Omit<BtcState, 'reload'>>({ loading: true });
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setState((s) => ({ ...s, loading: true }));
    try {
      const data = await api.btc(currency);
      if (mine === seq.current) setState({ data, loading: false });
    } catch (err) {
      if (mine === seq.current) setState((s) => ({ data: s.data?.currency === currency ? s.data : undefined, loading: false, error: errorMessage(err) }));
    }
  }, [currency]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => {
      clearInterval(timer);
      seq.current++;
    };
  }, [load]);

  return { ...state, reload: () => void load() };
}
