import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ValueBlock } from '../../shared/types';
import { db } from '../db';
import { payValue, recordPayments, summarizePayments, type PayValueArgs } from './v4v';
import { invoiceSats, payLightningAddress, type KeysendArgs, type WalletProvider } from './wallet';

function fakeWallet(opts: { failFor?: string } = {}) {
  const keysends: KeysendArgs[] = [];
  const invoices: string[] = [];
  const wallet: WalletProvider = {
    kind: 'nwc',
    getInfo: async () => ({}),
    getBalanceSats: async () => 1000,
    payInvoice: async (bolt11) => {
      invoices.push(bolt11);
      return { preimage: 'p' };
    },
    keysend: async (a) => {
      if (opts.failFor === a.pubkey) throw new Error('no route');
      keysends.push(a);
      return { preimage: 'p' };
    },
    makeInvoice: async () => 'lnbc',
    close: () => undefined,
  };
  return { wallet, keysends, invoices };
}

const value: ValueBlock = {
  type: 'lightning',
  method: 'keysend',
  recipients: [
    { name: 'Show', type: 'node', address: '02show', split: 90 },
    { name: 'Alby user', type: 'node', address: '03host', split: 10, customKey: '696969', customValue: 'acct1' },
    { name: 'App', type: 'node', address: '03app', split: 5, fee: true },
  ],
};

const base = (wallet: WalletProvider, extra: Partial<PayValueArgs> = {}): PayValueArgs => ({
  wallet,
  value,
  totalSats: 100,
  action: 'boost',
  podcast: { id: 1, title: 'Sats & Stories', url: 'https://x.example/rss', guid: 'guid-1' },
  episode: { id: 2, title: 'Ep 2', guid: 'ep-2' },
  ts: 61.7,
  senderName: 'Sam',
  message: 'Great show!',
  ...extra,
});

describe('payValue', () => {
  it('splits the amount (fees first), keysends each node with a boostagram and custom records', async () => {
    const { wallet, keysends } = fakeWallet();
    const results = await payValue(base(wallet));
    expect(results.map((r) => [r.recipient.name, r.sats, r.ok])).toEqual([['Show', 86, true], ['Alby user', 9, true], ['App', 5, true]]);
    expect(results.reduce((s, r) => s + r.sats, 0)).toBe(100);

    const show = keysends.find((k) => k.pubkey === '02show')!;
    const boost = JSON.parse(show.records['7629169']!);
    expect(boost).toMatchObject({ action: 'boost', app_name: 'BitPodRSS', podcast: 'Sats & Stories', episode: 'Ep 2', ts: 61, sender_name: 'Sam', message: 'Great show!', name: 'Show', value_msat: 86_000, value_msat_total: 100_000 });
    expect(show.records['696969']).toBeUndefined();
    expect(keysends.find((k) => k.pubkey === '03host')!.records['696969']).toBe('acct1');
  });

  it('keeps going when one recipient fails, and reports which', async () => {
    const { wallet, keysends } = fakeWallet({ failFor: '03host' });
    const results = await payValue(base(wallet));
    expect(results.map((r) => r.ok)).toEqual([true, false, true]);
    expect(results[1]!.error).toBe('no route');
    expect(keysends.map((k) => k.pubkey).sort()).toEqual(['02show', '03app']);
    expect(summarizePayments(results)).toEqual({ paidSats: 91, failedSats: 9, failures: 1 });
  });

  it('pays Lightning-address recipients via LNURL with the boost message as the comment', async () => {
    const { wallet, keysends } = fakeWallet();
    const payAddress = vi.fn(async () => ({ preimage: 'p' }));
    const v: ValueBlock = { ...value, recipients: [{ name: 'Host', type: 'lnaddress', address: 'host@getalby.com', split: 100 }] };
    const results = await payValue(base(wallet, { value: v }), { payAddress });
    expect(results[0]).toMatchObject({ ok: true, sats: 100 });
    expect(payAddress).toHaveBeenCalledWith(wallet, 'host@getalby.com', 100, { comment: 'Sam: Great show!' });
    expect(keysends).toHaveLength(0);
  });

  it('refuses unsupported recipient types without paying them', async () => {
    const { wallet, keysends } = fakeWallet();
    const v: ValueBlock = { ...value, recipients: [{ name: 'X', type: 'hive', address: 'someone', split: 100 }] };
    const results = await payValue(base(wallet, { value: v }));
    expect(results[0]).toMatchObject({ ok: false, error: expect.stringMatching(/Unsupported/) });
    expect(keysends).toHaveLength(0);
  });

  it('does nothing for a zero amount', async () => {
    const { wallet, keysends } = fakeWallet();
    expect(await payValue(base(wallet, { totalSats: 0 }))).toEqual([]);
    expect(keysends).toHaveLength(0);
  });

  it('marks streaming payments as such and omits the message', async () => {
    const { wallet, keysends } = fakeWallet();
    await payValue(base(wallet, { action: 'stream', message: undefined, totalSats: 10 }));
    const boost = JSON.parse(keysends[0]!.records['7629169']!);
    expect(boost.action).toBe('stream');
    expect(boost.message).toBeUndefined();
  });
});

describe('payLightningAddress', () => {
  const { wallet } = fakeWallet();
  it('pays the invoice when its amount matches the request', async () => {
    const f = fakeWallet();
    const r = await payLightningAddress(f.wallet, 'a@b.com', 21, { fetchInvoice: async () => ({ paymentRequest: 'lnbc21', satoshi: 21 }) });
    expect(r.preimage).toBe('p');
    expect(f.invoices).toEqual(['lnbc21']);
  });

  it('refuses an invoice for a different amount (a hostile server asking for more)', async () => {
    const f = fakeWallet();
    await expect(payLightningAddress(f.wallet, 'a@b.com', 21, { fetchInvoice: async () => ({ paymentRequest: 'lnbc9999', satoshi: 9999 }) })).rejects.toThrow(/instead of 21/);
    expect(f.invoices).toEqual([]);
  });

  it('validates the address and amount before any network call', async () => {
    const fetchInvoice = vi.fn();
    await expect(payLightningAddress(wallet, 'not-an-address', 5, { fetchInvoice })).rejects.toThrow(/valid Lightning address/);
    await expect(payLightningAddress(wallet, 'a@b.com', 0, { fetchInvoice })).rejects.toThrow(/whole number/);
    await expect(payLightningAddress(wallet, 'a@b.com', 1.5, { fetchInvoice })).rejects.toThrow(/whole number/);
    expect(fetchInvoice).not.toHaveBeenCalled();
  });
});

describe('invoiceSats', () => {
  // Example from the BOLT #11 specification: 2500 micro-BTC = 250,000 sats.
  const SPEC_INVOICE =
    'lnbc2500u1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpuaztrnwngzn3kdzw5hydlzf03qdgm2hdq27cqv3agm2awhz5se903vruatfhq77w3ls4evs3ch9zw97j25emudupq63nyw24cg27h2rspfj9srp';

  it('decodes the amount from a real BOLT11 invoice', async () => {
    expect(await invoiceSats(SPEC_INVOICE)).toBe(250_000);
    expect(await invoiceSats(`  ${SPEC_INVOICE}  `)).toBe(250_000);
  });

  it('returns undefined for garbage and for invoices with a corrupted checksum', async () => {
    expect(await invoiceSats('definitely not an invoice')).toBeUndefined();
    expect(await invoiceSats(SPEC_INVOICE.slice(0, -3) + 'qqq')).toBeUndefined();
  });
});

describe('recordPayments', () => {
  beforeEach(async () => db.ledger.clear());
  it('writes one ledger row per recipient, including failures', async () => {
    const { wallet } = fakeWallet({ failFor: '03host' });
    const args = base(wallet);
    const results = await payValue(args);
    await recordPayments(results, args, 1_700_000_000_000);
    const rows = await db.ledger.toArray();
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => [r.recipient, r.sats, r.ok])).toEqual([['Show', 86, 1], ['Alby user', 9, 0], ['App', 5, 1]]);
    expect(rows[1]).toMatchObject({ error: 'no route', kind: 'boost', podcastId: 1, episodeId: 2, ts: 1_700_000_000_000 });
  });
});
