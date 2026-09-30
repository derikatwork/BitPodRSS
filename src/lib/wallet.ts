import { utf8ToHex } from '../../shared/value';

export interface WalletInfo {
  alias?: string;
  pubkey?: string;
  /** The wallet's own Lightning address, when it advertises one. */
  lud16?: string;
  network?: string;
  methods?: string[];
}

export interface WalletTx {
  type: 'incoming' | 'outgoing';
  sats: number;
  description?: string;
  /** Unix ms. */
  time: number;
  state?: string;
}

export interface KeysendArgs {
  pubkey: string;
  sats: number;
  /** TLV records: numeric key (as a string) to UTF-8 value. */
  records: Record<string, string>;
}

/** What the app needs from a Lightning wallet, independent of how it is connected. */
export interface WalletProvider {
  readonly kind: 'webln' | 'nwc';
  getInfo(): Promise<WalletInfo>;
  /** Spendable balance in sats, if the wallet reports one. */
  getBalanceSats(): Promise<number | undefined>;
  payInvoice(bolt11: string): Promise<{ preimage: string }>;
  keysend(args: KeysendArgs): Promise<{ preimage: string }>;
  makeInvoice(sats: number, memo?: string): Promise<string>;
  listTransactions?(limit: number): Promise<WalletTx[]>;
  close(): void;
}

// ---------------------------------------------------------------------------------------------
// WebLN (Alby browser extension and compatible)
// ---------------------------------------------------------------------------------------------

interface WebLN {
  enable(): Promise<void>;
  getInfo(): Promise<{ node?: { alias?: string; pubkey?: string }; methods?: string[]; supports?: string[] }>;
  getBalance?(): Promise<{ balance: number }>;
  sendPayment(paymentRequest: string): Promise<{ preimage: string }>;
  keysend?(args: { destination: string; amount: string | number; customRecords?: Record<string, string> }): Promise<{ preimage: string }>;
  makeInvoice(args: { amount: string | number; defaultMemo?: string }): Promise<{ paymentRequest: string }>;
}

declare global {
  interface Window {
    webln?: WebLN;
    nostr?: Nip07;
  }
}

export interface Nip07 {
  getPublicKey(): Promise<string>;
  signEvent(event: { kind: number; created_at: number; tags: string[][]; content: string }): Promise<{ id: string; pubkey: string; sig: string; kind: number; created_at: number; tags: string[][]; content: string }>;
}

export function weblnAvailable(): boolean {
  return typeof window !== 'undefined' && !!window.webln;
}

/** The Alby extension injects window.webln a moment after page load, so wait briefly for it. */
export async function waitForWebLN(timeoutMs = 1500): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (weblnAvailable()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return weblnAvailable();
}

export async function connectWebLN(): Promise<WalletProvider> {
  if (!(await waitForWebLN())) throw new Error('No WebLN wallet found. Install the Alby browser extension (getalby.com) and reload this page.');
  const webln = window.webln!;
  await webln.enable();

  return {
    kind: 'webln',
    async getInfo() {
      const info = await webln.getInfo();
      return { alias: info.node?.alias, pubkey: info.node?.pubkey, methods: info.methods ?? info.supports };
    },
    async getBalanceSats() {
      try {
        return (await webln.getBalance?.())?.balance;
      } catch {
        return undefined; // the user may have declined this permission
      }
    },
    payInvoice: async (bolt11) => ({ preimage: (await webln.sendPayment(bolt11)).preimage }),
    async keysend({ pubkey, sats, records }) {
      if (!webln.keysend) throw new Error('This wallet does not support keysend, which podcast value payments need.');
      const r = await webln.keysend({ destination: pubkey, amount: sats, customRecords: records });
      return { preimage: r.preimage };
    },
    makeInvoice: async (sats, memo) => (await webln.makeInvoice({ amount: sats, defaultMemo: memo })).paymentRequest,
    close() {
      // The extension owns the connection; nothing to tear down.
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Nostr Wallet Connect (Alby Hub, Alby account, and other NIP-47 wallets)
// ---------------------------------------------------------------------------------------------

export function isNwcUrl(input: string): boolean {
  return /^nostr\+?walletconnect:\/\//i.test(input.trim());
}

export async function connectNwc(connectionUrl: string): Promise<WalletProvider> {
  const url = connectionUrl.trim();
  if (!isNwcUrl(url)) throw new Error('That does not look like a Nostr Wallet Connect string. It should start with nostr+walletconnect://');
  const { NWCClient } = await import('@getalby/sdk/nwc');
  let client: InstanceType<typeof NWCClient>;
  try {
    client = new NWCClient({ nostrWalletConnectUrl: url });
  } catch (err) {
    throw new Error(`Invalid connection string: ${(err as Error).message}`);
  }

  return {
    kind: 'nwc',
    async getInfo() {
      const info = await client.getInfo();
      return { alias: info.alias, pubkey: info.pubkey, network: info.network, methods: info.methods, lud16: info.lud16 ?? client.lud16 };
    },
    async getBalanceSats() {
      const { balance } = await client.getBalance(); // msats
      return Math.floor(balance / 1000);
    },
    async payInvoice(bolt11) {
      const r = await client.payInvoice({ invoice: bolt11 });
      return { preimage: r.preimage };
    },
    async keysend({ pubkey, sats, records }) {
      const r = await client.payKeysend({
        pubkey,
        amount: sats * 1000,
        tlv_records: Object.entries(records).map(([type, value]) => ({ type: Number(type), value: utf8ToHex(value) })),
      });
      return { preimage: r.preimage };
    },
    async makeInvoice(sats, memo) {
      const r = await client.makeInvoice({ amount: sats * 1000, description: memo });
      return r.invoice;
    },
    async listTransactions(limit) {
      const r = await client.listTransactions({ limit });
      return r.transactions.map((t) => ({ type: t.type, sats: Math.floor(t.amount / 1000), description: t.description || undefined, time: (t.settled_at || t.created_at) * 1000, state: t.state }));
    },
    close() {
      client.close();
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Lightning addresses (LNURL-pay)
// ---------------------------------------------------------------------------------------------

export const LN_ADDRESS = /^[a-z0-9._+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;

export interface PayAddressOptions {
  comment?: string;
  /** Replaceable for tests. */
  fetchInvoice?: (address: string, sats: number, comment?: string) => Promise<{ paymentRequest: string; satoshi: number }>;
}

/** Fetch an invoice from a Lightning address, straight from the browser (no third-party proxy). */
async function fetchInvoiceFromAddress(address: string, sats: number, comment?: string): Promise<{ paymentRequest: string; satoshi: number }> {
  const { LightningAddress } = await import('@getalby/lightning-tools/lnurl');
  const ln = new LightningAddress(address, { proxy: false });
  await ln.fetch();
  const data = ln.lnurlpData;
  if (!data) throw new Error(`${address} does not accept Lightning payments.`);
  const msats = sats * 1000;
  if (msats < data.min || msats > data.max) {
    throw new Error(`${address} accepts between ${Math.ceil(data.min / 1000)} and ${Math.floor(data.max / 1000)} sats.`);
  }
  const allowed = data.commentAllowed ?? 0;
  const invoice = await ln.requestInvoice({ satoshi: sats, comment: comment && allowed > 0 ? comment.slice(0, allowed) : undefined });
  return { paymentRequest: invoice.paymentRequest, satoshi: invoice.satoshi };
}

/**
 * Pay `sats` to a Lightning address. The invoice's own amount is checked against what was asked for
 * before anything is paid, so a misbehaving server cannot charge more.
 */
export async function payLightningAddress(wallet: WalletProvider, address: string, sats: number, opts: PayAddressOptions = {}): Promise<{ preimage: string }> {
  if (!LN_ADDRESS.test(address)) throw new Error(`"${address}" is not a valid Lightning address.`);
  if (!Number.isInteger(sats) || sats < 1) throw new Error('Amount must be a whole number of sats.');
  const { paymentRequest, satoshi } = await (opts.fetchInvoice ?? fetchInvoiceFromAddress)(address, sats, opts.comment);
  if (satoshi !== sats) throw new Error(`${address} returned an invoice for ${satoshi} sats instead of ${sats}. Payment cancelled.`);
  return wallet.payInvoice(paymentRequest);
}

/** Amount (in sats) encoded in a BOLT11 invoice, or undefined for "any amount" / undecodable invoices. */
export async function invoiceSats(bolt11: string): Promise<number | undefined> {
  const { decodeInvoice } = await import('@getalby/lightning-tools/bolt11');
  const decoded = decodeInvoice(bolt11.trim());
  return decoded && decoded.satoshi > 0 ? decoded.satoshi : undefined;
}
