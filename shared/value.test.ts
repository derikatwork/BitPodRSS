import { describe, expect, it } from 'vitest';
import { BOOSTAGRAM_TLV, buildBoostagram, computeSplits, customRecordsFor, isPayableValue, satsFromSuggested, utf8ToHex } from './value';
import type { ValueRecipient } from './types';

const r = (name: string, split: number, extra: Partial<ValueRecipient> = {}): ValueRecipient => ({
  name,
  type: 'node',
  address: `03${name.padEnd(10, '0')}`,
  split,
  ...extra,
});

const amounts = (payments: ReturnType<typeof computeSplits>) => payments.map((p) => [p.recipient.name, p.sats]);

describe('satsFromSuggested', () => {
  it('converts the spec decimal BTC amount to sats', () => {
    expect(satsFromSuggested('0.00000015000')).toBe(15);
    expect(satsFromSuggested('0.00000005')).toBe(5);
    expect(satsFromSuggested(0.000001)).toBe(100);
  });
  it('rejects junk', () => {
    expect(satsFromSuggested(undefined)).toBeUndefined();
    expect(satsFromSuggested('')).toBeUndefined();
    expect(satsFromSuggested('abc')).toBeUndefined();
    expect(satsFromSuggested('-1')).toBeUndefined();
  });
});

describe('computeSplits', () => {
  it('divides proportionally to shares', () => {
    expect(amounts(computeSplits(100, [r('show', 90), r('host', 5), r('guest', 5)]))).toEqual([['show', 90], ['host', 5], ['guest', 5]]);
  });

  it('allocates leftover sats so the total is exact', () => {
    const p = computeSplits(10, [r('a', 1), r('b', 1), r('c', 1)]);
    expect(p.reduce((s, x) => s + x.sats, 0)).toBe(10);
    expect(p.map((x) => x.sats).sort()).toEqual([3, 3, 4]);
  });

  it('pays fee recipients first as a percentage of the total', () => {
    expect(amounts(computeSplits(100, [r('app', 10, { fee: true }), r('show', 90), r('host', 10)]))).toEqual([['app', 10], ['show', 81], ['host', 9]]);
  });

  it('drops recipients whose share rounds to zero', () => {
    const p = computeSplits(1, [r('a', 50), r('b', 30), r('c', 20)]);
    expect(amounts(p)).toEqual([['a', 1]]);
  });

  it('never pays out more than the total, even with oversized fees', () => {
    const p = computeSplits(100, [r('app', 150, { fee: true }), r('show', 100)]);
    expect(p.reduce((s, x) => s + x.sats, 0)).toBeLessThanOrEqual(100);
  });

  it('ignores invalid recipients and non-positive totals', () => {
    expect(computeSplits(0, [r('a', 1)])).toEqual([]);
    expect(computeSplits(-5, [r('a', 1)])).toEqual([]);
    expect(computeSplits(10, [r('a', 0), { ...r('b', 1), address: '' }])).toEqual([]);
    expect(computeSplits(Number.NaN, [r('a', 1)])).toEqual([]);
  });

  it('always sums to the total when there are non-fee recipients (property)', () => {
    let seed = 42;
    const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    for (let n = 0; n < 500; n++) {
      const count = 1 + Math.floor(rand() * 6);
      const recipients = Array.from({ length: count }, (_, i) => r(`r${i}`, 1 + Math.floor(rand() * 100), { fee: rand() < 0.2 && i > 0 }));
      const total = 1 + Math.floor(rand() * 5000);
      const paid = computeSplits(total, recipients).reduce((s, x) => s + x.sats, 0);
      expect(paid).toBe(total);
    }
  });
});

describe('boostagram', () => {
  it('omits empty fields and carries amounts in msat', () => {
    const json = JSON.parse(
      buildBoostagram({ appName: 'BitPodRSS', action: 'boost', podcast: 'Show', episode: 'Ep 1', ts: 61.9, message: '', valueMsat: 5000, valueMsatTotal: 10000, senderName: 'Sam' }),
    );
    expect(json).toEqual({ action: 'boost', app_name: 'BitPodRSS', podcast: 'Show', episode: 'Ep 1', ts: 61, sender_name: 'Sam', value_msat: 5000, value_msat_total: 10000 });
  });

  it('builds TLV records with the boostagram and the recipient custom key', () => {
    const rec = customRecordsFor(r('alby', 1, { customKey: '696969', customValue: 'abc123' }), '{"a":1}');
    expect(rec).toEqual({ [String(BOOSTAGRAM_TLV)]: '{"a":1}', '696969': 'abc123' });
    expect(customRecordsFor(r('plain', 1))).toEqual({});
  });

  it('hex-encodes utf8', () => {
    expect(utf8ToHex('hi')).toBe('6869');
    expect(utf8ToHex('⚡')).toBe('e29aa1');
  });
});

describe('isPayableValue', () => {
  it('requires lightning with a node or lightning-address recipient', () => {
    expect(isPayableValue(undefined)).toBe(false);
    expect(isPayableValue({ type: 'lightning', method: 'keysend', recipients: [r('a', 1)] })).toBe(true);
    expect(isPayableValue({ type: 'lightning', method: 'keysend', recipients: [r('a', 1, { type: 'lnaddress', address: 'a@b.com' })] })).toBe(true);
    expect(isPayableValue({ type: 'hive', method: 'x', recipients: [r('a', 1)] })).toBe(false);
    expect(isPayableValue({ type: 'lightning', method: 'keysend', recipients: [r('a', 1, { type: 'other' })] })).toBe(false);
    expect(isPayableValue({ type: 'lightning', method: 'keysend', recipients: [] })).toBe(false);
  });
});
