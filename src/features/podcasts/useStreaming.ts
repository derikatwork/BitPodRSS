import { useEffect } from 'react';
import { isPayableValue } from '../../../shared/value';
import { db } from '../../db';
import { StreamMeter } from '../../lib/streaming';
import { startOfLocalDay, streamingAllowanceToday } from '../../lib/spending';
import { payValue, recordPayments, summarizePayments } from '../../lib/v4v';
import { useNostr } from '../../state/nostr';
import { usePlayer } from '../../state/player';
import { useSettings } from '../../state/settings';
import { toast } from '../../state/toasts';
import { getWallet, useWallet } from '../../state/wallet';

const MAX_CONSECUTIVE_FAILURES = 2;

/**
 * Streams sats to a podcast's value recipients while a value-enabled episode plays: `satsPerMinute` for each
 * minute actually listened. It does nothing unless the user turned streaming on AND connected a wallet, it
 * never spends beyond the daily cap, and it switches itself off after repeated failures.
 *
 * Mount once, at the app root.
 */
export function useStreamingSats(): void {
  useEffect(() => {
    const meter = new StreamMeter();
    let owedMinutes = 0;
    let inFlight = false;
    let failures = 0;
    let capNoticeDay = 0;

    const settle = async (): Promise<void> => {
      if (inFlight || owedMinutes <= 0) return;
      const { v4v, senderName } = useSettings.getState();
      const wallet = getWallet();
      const { episodeId, position } = usePlayer.getState();
      if (!v4v.streaming || !wallet || !episodeId) {
        owedMinutes = 0;
        return;
      }

      inFlight = true;
      const minutes = owedMinutes;
      owedMinutes = 0;
      try {
        const episode = await db.episodes.get(episodeId);
        const podcast = episode && (await db.podcasts.get(episode.podcastId));
        const value = episode?.meta?.value ?? podcast?.meta?.value;
        if (!episode || !podcast || !isPayableValue(value)) return;

        const now = Date.now();
        const today = await db.ledger.where('ts').aboveOrEqual(startOfLocalDay(now)).toArray();
        const allowance = streamingAllowanceToday(today, v4v, now);
        const sats = Math.floor(Math.min(minutes * v4v.satsPerMinute, allowance));
        if (sats < 1) {
          if (capNoticeDay !== startOfLocalDay(now)) {
            capNoticeDay = startOfLocalDay(now);
            toast.info(`Daily streaming limit of ${v4v.dailyCapSats.toLocaleString()} sats reached. Streaming resumes tomorrow.`);
          }
          return;
        }

        const nostr = useNostr.getState();
        const args = {
          wallet,
          value,
          totalSats: sats,
          action: 'stream' as const,
          podcast: { id: podcast.id, title: podcast.title, url: podcast.url, guid: podcast.meta?.guid },
          episode: { id: episode.id, title: episode.title, guid: episode.guid },
          ts: position,
          speed: usePlayer.getState().playing ? useSettings.getState().playbackRate : 1,
          senderName: senderName || nostr.profile?.displayName || nostr.profile?.name || undefined,
          senderPubkey: nostr.pubkey,
        };
        const results = await payValue(args);
        await recordPayments(results, args);
        const { paidSats, failures: failed } = summarizePayments(results);
        if (paidSats > 0) {
          failures = 0;
          void useWallet.getState().refreshBalance();
        } else if (failed > 0) {
          failures++;
          if (failures >= MAX_CONSECUTIVE_FAILURES) {
            useSettings.getState().setV4v({ streaming: false });
            toast.error(`Streaming sats turned off after failed payments: ${results.find((r) => !r.ok)?.error ?? 'unknown error'}`);
          }
        }
      } catch (err) {
        failures++;
        if (failures >= MAX_CONSECUTIVE_FAILURES) {
          useSettings.getState().setV4v({ streaming: false });
          toast.error(`Streaming sats turned off: ${(err as Error).message}`);
        }
      } finally {
        inFlight = false;
        if (owedMinutes > 0) void settle();
      }
    };

    return usePlayer.subscribe((s, prev) => {
      if (s.episodeId !== prev.episodeId) {
        meter.reset();
        owedMinutes = 0;
      }
      if (s.position === prev.position && s.playing === prev.playing) return;
      const units = meter.tick(s.position, s.playing);
      if (units > 0 && useSettings.getState().v4v.streaming) {
        owedMinutes += units;
        void settle();
      }
    });
  }, []);
}
