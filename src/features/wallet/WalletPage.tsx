import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useState } from 'react';
import { Icon } from '../../components/Icon';
import { Modal } from '../../components/Modal';
import { db } from '../../db';
import { formatSats, truncateMiddle } from '../../lib/format';
import { DEFAULT_V4V, parseSats, spentSince, startOfLocalDay } from '../../lib/spending';
import { LN_ADDRESS, invoiceSats, isNwcUrl, payLightningAddress, weblnAvailable, type WalletTx } from '../../lib/wallet';
import { useSettings } from '../../state/settings';
import { errorMessage, toast } from '../../state/toasts';
import { getWallet, useWallet } from '../../state/wallet';
import { PriceCard } from '../bitcoin/PriceCard';

export function WalletPage() {
  return (
    <div className="container stack" style={{ gap: 20 }}>
      <PriceCard />
      <WalletCard />
      <ValueCard />
      <HistoryCard />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

function WalletCard() {
  const w = useWallet();
  const [nwc, setNwc] = useState('');
  const [sending, setSending] = useState(false);
  const [receiving, setReceiving] = useState(false);
  const [txs, setTxs] = useState<WalletTx[] | null>(null);
  const [hasWebln, setHasWebln] = useState(weblnAvailable());

  useEffect(() => {
    // The extension injects window.webln shortly after load.
    const t = setTimeout(() => setHasWebln(weblnAvailable()), 800);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    if (w.status !== 'connected') return setTxs(null);
    const provider = getWallet();
    provider?.listTransactions?.(15).then(setTxs).catch(() => setTxs(null));
  }, [w.status, w.balanceSats]);

  const connected = w.status === 'connected';

  return (
    <section className="card stack" aria-labelledby="wallet-heading">
      <div className="row">
        <Icon name="wallet" />
        <h2 id="wallet-heading" className="grow" style={{ fontSize: 17 }}>
          Lightning wallet
        </h2>
        {connected && (
          <button className="btn" onClick={w.disconnect}>
            Disconnect
          </button>
        )}
      </div>

      {connected ? (
        <div className="stack">
          <div className="row wrap" style={{ gap: 20, alignItems: 'flex-end' }}>
            <div>
              <div className="small muted">Balance</div>
              <div style={{ fontSize: 28, fontWeight: 650 }}>{w.balanceSats !== undefined ? formatSats(w.balanceSats) : 'Not reported'}</div>
            </div>
            <div className="small secondary">
              <div>
                {w.info?.alias ?? 'Connected wallet'} <span className="badge">{w.kind === 'webln' ? 'Alby extension (WebLN)' : 'Nostr Wallet Connect'}</span>
              </div>
              {w.info?.pubkey && <div className="mono muted">{truncateMiddle(w.info.pubkey, 8)}</div>}
            </div>
            <div className="grow" />
            <button className="btn" onClick={() => void w.refreshBalance()}>
              <Icon name="refresh" size={16} /> Balance
            </button>
            <button className="btn" onClick={() => setReceiving(true)}>
              <Icon name="arrow-down" size={16} /> Receive
            </button>
            <button className="btn primary" onClick={() => setSending(true)}>
              <Icon name="arrow-up" size={16} /> Send
            </button>
          </div>
          {w.info?.methods && !w.info.methods.includes('pay_keysend') && w.kind === 'nwc' && (
            <div className="notice warn">
              This connection does not allow <code>pay_keysend</code>, which podcast Value-for-Value payments need. Create a new connection in Alby Hub that includes it.
            </div>
          )}
          {txs && txs.length > 0 && (
            <table className="data-table">
              <caption className="sr-only">Recent wallet transactions</caption>
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Description</th>
                  <th scope="col" className="num">Amount</th>
                </tr>
              </thead>
              <tbody>
                {txs.map((t, i) => (
                  <tr key={i}>
                    <td>{new Date(t.time).toLocaleString()}</td>
                    <td className="ellipsis" style={{ maxWidth: 260 }}>{t.description ?? (t.type === 'incoming' ? 'Received' : 'Sent')}</td>
                    <td className="num" style={{ color: t.type === 'incoming' ? 'var(--good)' : undefined }}>
                      {t.type === 'incoming' ? '+' : '−'}
                      {t.sats.toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ) : (
        <div className="grid-2">
          <div className="card stack" style={{ background: 'var(--surface-2)' }}>
            <strong>Alby browser extension</strong>
            <p className="small secondary" style={{ margin: 0 }}>
              The simplest option if you use the Alby extension. Each payment is approved by the extension.
            </p>
            <button className="btn primary" disabled={w.status === 'connecting'} onClick={() => void w.connectWebLN()}>
              Connect Alby extension
            </button>
            {!hasWebln && (
              <div className="tiny muted">
                Not detected yet. Get it at{' '}
                <a href="https://getalby.com" target="_blank" rel="noopener noreferrer">
                  getalby.com
                </a>{' '}
                and reload.
              </div>
            )}
          </div>
          <div className="card stack" style={{ background: 'var(--surface-2)' }}>
            <strong>Nostr Wallet Connect</strong>
            <p className="small secondary" style={{ margin: 0 }}>
              Works with Alby Hub and Alby accounts. In Alby Hub, open <em>Connections → Add connection</em>, allow “pay invoices”, “pay keysend” and “read balance”, and <strong>set a monthly budget</strong>. Then paste the connection string:
            </p>
            <input className="input mono" type="password" placeholder="nostr+walletconnect://…" value={nwc} onChange={(e) => setNwc(e.target.value)} autoComplete="off" spellCheck={false} aria-label="Nostr Wallet Connect connection string" />
            <button className="btn primary" disabled={w.status === 'connecting' || !isNwcUrl(nwc)} onClick={() => void w.connectNwc(nwc).then(() => setNwc(''))}>
              {w.status === 'connecting' ? 'Connecting…' : 'Connect'}
            </button>
          </div>
        </div>
      )}

      {w.error && <div className="notice error">{w.error}</div>}
      {!connected && (
        <p className="tiny muted" style={{ margin: 0 }}>
          The connection string can spend from your wallet, so it is stored only in this browser. A budget in your wallet is the real safety net: use one.
        </p>
      )}

      {sending && <SendDialog onClose={() => setSending(false)} />}
      {receiving && <ReceiveDialog onClose={() => setReceiving(false)} />}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------

function SendDialog({ onClose }: { onClose: () => void }) {
  const confirmAbove = useSettings((s) => s.v4v.confirmAboveSats);
  const [target, setTarget] = useState('');
  const [amountText, setAmountText] = useState('');
  const [comment, setComment] = useState('');
  const [invoiceAmount, setInvoiceAmount] = useState<number | undefined>();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = target.trim().replace(/^lightning:/i, '');
  const isAddress = LN_ADDRESS.test(trimmed);
  const isInvoice = /^ln(bc|tb|bcrt)/i.test(trimmed);

  useEffect(() => {
    setInvoiceAmount(undefined);
    if (isInvoice) void invoiceSats(trimmed).then(setInvoiceAmount);
  }, [trimmed, isInvoice]);

  const sats = isAddress ? parseSats(amountText) : invoiceAmount;
  const valid = (isAddress && !!sats) || (isInvoice && !!sats);

  const pay = async () => {
    const wallet = getWallet();
    if (!wallet || !sats) return;
    setBusy(true);
    setError(null);
    try {
      if (isAddress) await payLightningAddress(wallet, trimmed, sats, { comment: comment.trim() || undefined });
      else await wallet.payInvoice(trimmed);
      await db.ledger.add({ ts: Date.now(), kind: isAddress ? 'lnaddress' : 'invoice', sats, ok: 1, recipient: isAddress ? trimmed : truncateMiddle(trimmed, 10) });
      toast.ok(`Sent ${formatSats(sats)}.`);
      void useWallet.getState().refreshBalance();
      onClose();
    } catch (err) {
      await db.ledger.add({ ts: Date.now(), kind: isAddress ? 'lnaddress' : 'invoice', sats, ok: 0, recipient: isAddress ? trimmed : truncateMiddle(trimmed, 10), error: errorMessage(err) });
      setError(errorMessage(err));
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Send sats"
      onClose={onClose}
      actions={
        <>
          <button className="btn" data-close onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn primary" disabled={!valid || busy} onClick={() => (sats && sats >= confirmAbove && !confirming ? setConfirming(true) : void pay())}>
            <Icon name="zap" size={16} /> {busy ? 'Sending…' : confirming ? `Yes, send ${sats ? formatSats(sats) : ''}` : 'Send'}
          </button>
        </>
      }
    >
      <div className="stack">
        <label className="field">
          Lightning invoice or Lightning address
          <textarea className="textarea mono" value={target} onChange={(e) => setTarget(e.target.value)} placeholder="lnbc… or name@getalby.com" rows={3} spellCheck={false} />
        </label>
        {isAddress && (
          <>
            <label className="field">
              Amount (sats)
              <input className="input" value={amountText} onChange={(e) => setAmountText(e.target.value)} inputMode="numeric" />
            </label>
            <label className="field">
              Message (optional)
              <input className="input" value={comment} onChange={(e) => setComment(e.target.value)} maxLength={140} />
            </label>
          </>
        )}
        {isInvoice && (invoiceAmount ? <div className="notice">This invoice is for <strong>{formatSats(invoiceAmount)}</strong>.</div> : <div className="notice warn">This invoice has no fixed amount (or could not be read), so it cannot be sent from here.</div>)}
        {target.trim() && !isAddress && !isInvoice && <div className="small muted">Enter a BOLT11 invoice (starts with lnbc) or an address like name@domain.com.</div>}
        {confirming && sats && <div className="notice warn">This is a larger payment ({formatSats(sats)}). Please confirm.</div>}
        {error && <div className="notice error">{error}</div>}
      </div>
    </Modal>
  );
}

function ReceiveDialog({ onClose }: { onClose: () => void }) {
  const [amountText, setAmountText] = useState('1000');
  const [memo, setMemo] = useState('');
  const [invoice, setInvoice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sats = parseSats(amountText);

  const create = async () => {
    const wallet = getWallet();
    if (!wallet || !sats) return;
    setBusy(true);
    setError(null);
    try {
      setInvoice(await wallet.makeInvoice(sats, memo.trim() || undefined));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Receive sats"
      onClose={onClose}
      actions={
        <>
          <button className="btn" data-close onClick={onClose}>
            Close
          </button>
          {!invoice && (
            <button className="btn primary" disabled={!sats || busy} onClick={() => void create()}>
              {busy ? 'Creating…' : 'Create invoice'}
            </button>
          )}
        </>
      }
    >
      <div className="stack">
        {!invoice ? (
          <>
            <label className="field">
              Amount (sats)
              <input className="input" value={amountText} onChange={(e) => setAmountText(e.target.value)} inputMode="numeric" />
            </label>
            <label className="field">
              Description (optional)
              <input className="input" value={memo} onChange={(e) => setMemo(e.target.value)} maxLength={100} />
            </label>
          </>
        ) : (
          <>
            <textarea className="textarea mono" readOnly rows={6} value={invoice} onFocus={(e) => e.currentTarget.select()} aria-label="Lightning invoice" />
            <div className="row">
              <button
                className="btn"
                onClick={() => {
                  void navigator.clipboard?.writeText(invoice).then(() => toast.ok('Invoice copied.'));
                }}
              >
                <Icon name="copy" size={16} /> Copy
              </button>
              <a className="btn" href={`lightning:${invoice}`}>
                Open in wallet app
              </a>
            </div>
          </>
        )}
        {error && <div className="notice error">{error}</div>}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------------

function ValueCard() {
  const v4v = useSettings((s) => s.v4v);
  const setV4v = useSettings((s) => s.setV4v);
  const senderName = useSettings((s) => s.senderName);
  const set = useSettings((s) => s.set);
  const connected = useWallet((s) => s.status === 'connected');
  const [confirmEnable, setConfirmEnable] = useState(false);
  const today = useLiveQuery(() => db.ledger.where('ts').aboveOrEqual(startOfLocalDay(Date.now())).toArray(), []) ?? [];
  const spentStreaming = spentSince(today, 0, ['stream']);

  const numberField = (label: string, key: keyof typeof DEFAULT_V4V, help?: string) => (
    <label className="field">
      {label}
      <input
        className="input"
        inputMode="numeric"
        defaultValue={String(v4v[key] as number)}
        onBlur={(e) => {
          const n = parseSats(e.target.value);
          if (n) setV4v({ [key]: n });
          else e.target.value = String(v4v[key] as number);
        }}
      />
      {help && <span className="tiny muted">{help}</span>}
    </label>
  );

  return (
    <section className="card stack" aria-labelledby="v4v-heading">
      <div className="row">
        <Icon name="zap" />
        <h2 id="v4v-heading" style={{ fontSize: 17 }}>
          Value-for-Value & spending limits
        </h2>
      </div>
      <p className="small secondary" style={{ margin: 0 }}>
        Podcasts that support Podcasting 2.0 “value” can be paid in sats. You can send a one-off <strong>boost</strong> from any episode, or <strong>stream</strong> a small amount for every minute you listen. Nothing is ever sent automatically unless you turn streaming on below.
      </p>

      <div className="row wrap">
        <label className="switch">
          <input
            type="checkbox"
            checked={v4v.streaming}
            disabled={!connected && !v4v.streaming}
            onChange={(e) => (e.target.checked ? setConfirmEnable(true) : setV4v({ streaming: false }))}
          />
          <strong>Stream sats while I listen</strong>
        </label>
        {!connected && <span className="small muted">Connect a wallet to enable.</span>}
        {v4v.streaming && (
          <span className="badge">
            Today: {formatSats(spentStreaming)} of {formatSats(v4v.dailyCapSats)}
          </span>
        )}
      </div>

      <div className="grid-2">
        {numberField('Sats per minute', 'satsPerMinute', 'Split between the show’s recipients.')}
        {numberField('Daily streaming limit (sats)', 'dailyCapSats', 'Streaming stops for the day once this is reached.')}
        {numberField('Default boost (sats)', 'boostSats')}
        {numberField('Ask me to confirm payments of at least (sats)', 'confirmAboveSats')}
      </div>
      <label className="field" style={{ maxWidth: 360 }}>
        Name sent with boosts (optional)
        <input className="input" value={senderName} onChange={(e) => set({ senderName: e.target.value })} maxLength={60} placeholder="Anonymous" />
      </label>

      {confirmEnable && (
        <Modal
          title="Turn on streaming sats?"
          onClose={() => setConfirmEnable(false)}
          actions={
            <>
              <button className="btn" data-close onClick={() => setConfirmEnable(false)}>
                Cancel
              </button>
              <button
                className="btn primary"
                onClick={() => {
                  setV4v({ streaming: true });
                  setConfirmEnable(false);
                }}
              >
                Turn on
              </button>
            </>
          }
        >
          <div className="stack">
            <p style={{ margin: 0 }}>
              While an episode that supports value payments is playing, BitPodRSS will send <strong>{formatSats(v4v.satsPerMinute)} per minute</strong> from your connected wallet, up to <strong>{formatSats(v4v.dailyCapSats)} per day</strong>.
            </p>
            <p className="small secondary" style={{ margin: 0 }}>
              Only time actually listened counts; pausing or skipping ahead does not. It turns itself off if payments fail twice in a row. You can change these limits or stop at any time.
            </p>
          </div>
        </Modal>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------

function HistoryCard() {
  const rows = useLiveQuery(() => db.ledger.orderBy('ts').reverse().limit(50).toArray(), []) ?? [];
  if (rows.length === 0) return null;
  return (
    <section className="card stack" aria-labelledby="history-heading">
      <h2 id="history-heading" style={{ fontSize: 17 }}>
        Payments made from BitPodRSS
      </h2>
      <div style={{ overflow: 'auto' }}>
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">When</th>
              <th scope="col">Type</th>
              <th scope="col">To</th>
              <th scope="col" className="num">Sats</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{new Date(r.ts).toLocaleString()}</td>
                <td>{r.kind}</td>
                <td className="ellipsis" style={{ maxWidth: 240 }} title={r.note}>
                  {r.recipient}
                  {r.note ? <span className="muted"> · {r.note}</span> : null}
                </td>
                <td className="num">{r.sats.toLocaleString()}</td>
                <td>{r.ok ? 'Sent' : <span style={{ color: 'var(--bad)' }} title={r.error}>Failed</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
