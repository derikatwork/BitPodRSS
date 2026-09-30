import { useMemo, useState } from 'react';
import { computeSplits } from '../../../shared/value';
import { Icon } from '../../components/Icon';
import { Modal } from '../../components/Modal';
import { formatSats, truncateMiddle } from '../../lib/format';
import { needsConfirmation, parseSats } from '../../lib/spending';
import { payValue, recordPayments, summarizePayments, type RecipientResult } from '../../lib/v4v';
import { useNav } from '../../state/nav';
import { useNostr } from '../../state/nostr';
import { usePlayer } from '../../state/player';
import { useSettings } from '../../state/settings';
import { toast } from '../../state/toasts';
import { getWallet, useWallet } from '../../state/wallet';
import { useEpisodeValue } from './useEpisodeValue';

const PRESETS = [100, 500, 1000, 5000];

/** Send a one-off boost (with an optional message) to everyone in an episode's value block. */
export function BoostDialog({ episodeId, onClose }: { episodeId: number; onClose: () => void }) {
  const { episode, podcast, value } = useEpisodeValue(episodeId);
  const v4v = useSettings((s) => s.v4v);
  const senderSetting = useSettings((s) => s.senderName);
  const nostr = useNostr();
  const wallet = useWallet();
  const go = useNav((s) => s.go);

  const [amountText, setAmountText] = useState(String(v4v.boostSats));
  const [message, setMessage] = useState('');
  const [name, setName] = useState(senderSetting || nostr.profile?.displayName || nostr.profile?.name || '');
  const [phase, setPhase] = useState<'form' | 'confirm' | 'sending' | 'done'>('form');
  const [results, setResults] = useState<RecipientResult[]>([]);

  const amount = parseSats(amountText);
  const preview = useMemo(() => (amount && value ? computeSplits(amount, value.recipients) : []), [amount, value]);
  const connected = wallet.status === 'connected';
  const enoughBalance = wallet.balanceSats === undefined || !amount || wallet.balanceSats >= amount;

  const send = async () => {
    const provider = getWallet();
    if (!provider || !amount || !value || !episode || !podcast) return;
    setPhase('sending');
    const player = usePlayer.getState();
    const args = {
      wallet: provider,
      value,
      totalSats: amount,
      action: 'boost' as const,
      podcast: { id: podcast.id, title: podcast.title, url: podcast.url, guid: podcast.meta?.guid },
      episode: { id: episode.id, title: episode.title, guid: episode.guid },
      ts: player.episodeId === episode.id ? player.position : undefined,
      message: message.trim() || undefined,
      senderName: name.trim() || undefined,
      senderPubkey: nostr.pubkey,
    };
    try {
      const r = await payValue(args);
      await recordPayments(r, args);
      setResults(r);
      void useWallet.getState().refreshBalance();
      const { paidSats, failures } = summarizePayments(r);
      if (failures === 0) toast.ok(`Boosted ${formatSats(paidSats)}. Thank you for supporting ${podcast.title}!`);
      else if (paidSats > 0) toast.info(`Sent ${formatSats(paidSats)}; ${failures} payment${failures === 1 ? '' : 's'} failed.`);
      else toast.error('The boost could not be sent.');
    } catch (err) {
      setResults([{ recipient: value.recipients[0]!, sats: amount, ok: false, error: (err as Error).message }]);
      toast.error('The boost could not be sent.');
    }
    setPhase('done');
  };

  const primaryLabel = phase === 'confirm' ? `Yes, send ${amount ? formatSats(amount) : ''}` : 'Send boost';

  return (
    <Modal
      title="Boost this episode"
      onClose={onClose}
      actions={
        phase === 'done' ? (
          <button className="btn primary" onClick={onClose}>
            Done
          </button>
        ) : (
          <>
            <button className="btn" data-close onClick={phase === 'confirm' ? () => setPhase('form') : onClose} disabled={phase === 'sending'}>
              {phase === 'confirm' ? 'Back' : 'Cancel'}
            </button>
            <button
              className="btn primary"
              disabled={!connected || !amount || !value || !enoughBalance || phase === 'sending'}
              onClick={() => (phase === 'form' && amount && needsConfirmation(amount, v4v) ? setPhase('confirm') : void send())}
            >
              <Icon name="zap" size={16} /> {phase === 'sending' ? 'Sending…' : primaryLabel}
            </button>
          </>
        )
      }
    >
      {!value ? (
        <div className="notice warn">This episode has no Lightning value information, so it cannot be boosted.</div>
      ) : phase === 'done' ? (
        <div className="stack">
          <table className="data-table">
            <thead>
              <tr>
                <th>Recipient</th>
                <th className="num">Sats</th>
                <th>Result</th>
              </tr>
            </thead>
            <tbody>
              {results.map((r, i) => (
                <tr key={i}>
                  <td>{r.recipient.name || truncateMiddle(r.recipient.address, 8)}</td>
                  <td className="num">{r.sats}</td>
                  <td>{r.ok ? 'Sent' : <span style={{ color: 'var(--bad)' }}>Failed: {r.error}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="stack">
          {!connected && (
            <div className="notice warn">
              Connect a Lightning wallet first.{' '}
              <button className="btn" onClick={() => { onClose(); go('wallet'); }}>
                Open wallet settings
              </button>
            </div>
          )}
          <div>
            <div className="small secondary" style={{ marginBottom: 4 }}>
              Amount (sats)
            </div>
            <div className="row wrap">
              {PRESETS.map((p) => (
                <button key={p} className="btn" aria-pressed={amount === p} style={amount === p ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : undefined} onClick={() => setAmountText(String(p))} disabled={phase !== 'form'}>
                  {p.toLocaleString()}
                </button>
              ))}
              <input className="input" style={{ width: 120 }} value={amountText} onChange={(e) => setAmountText(e.target.value)} inputMode="numeric" aria-label="Custom amount in sats" disabled={phase !== 'form'} />
            </div>
            {amountText && !amount && <div className="small" style={{ color: 'var(--bad)', marginTop: 4 }}>Enter a whole number of sats.</div>}
            {!enoughBalance && <div className="small" style={{ color: 'var(--bad)', marginTop: 4 }}>Your wallet balance ({formatSats(wallet.balanceSats ?? 0)}) is lower than this amount.</div>}
          </div>
          <label className="field">
            Message (optional)
            <textarea className="textarea" value={message} onChange={(e) => setMessage(e.target.value)} maxLength={300} disabled={phase !== 'form'} placeholder="Say something nice to the creators" />
          </label>
          <label className="field">
            Your name (optional)
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} disabled={phase !== 'form'} />
          </label>
          {preview.length > 0 && (
            <div>
              <div className="small secondary" style={{ marginBottom: 4 }}>
                Who receives it
              </div>
              <table className="data-table">
                <tbody>
                  {preview.map(({ recipient, sats }, i) => (
                    <tr key={i}>
                      <td>
                        {recipient.name || truncateMiddle(recipient.address, 8)} {recipient.fee && <span className="badge">fee</span>}
                      </td>
                      <td className="num">{sats.toLocaleString()} sats</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {phase === 'confirm' && amount && <div className="notice warn">This is a larger payment ({formatSats(amount)}). Please confirm you want to send it.</div>}
        </div>
      )}
    </Modal>
  );
}
