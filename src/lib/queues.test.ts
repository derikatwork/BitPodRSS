import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../db';
import { DEFAULT_QUEUE_NAME, addToQueue, createQueue, deleteQueue, getDefaultQueue, insertUnique, moveInQueue, moveItem, pruneQueues, removeFromQueue } from './queues';

describe('insertUnique', () => {
  it('appends, plays next, or inserts at an index, never duplicating', () => {
    expect(insertUnique([1, 2, 3], 4, 'end')).toEqual([1, 2, 3, 4]);
    expect(insertUnique([1, 2, 3], 4, 'next')).toEqual([4, 1, 2, 3]);
    expect(insertUnique([1, 2, 3], 3, 'next')).toEqual([3, 1, 2]);
    expect(insertUnique([1, 2, 3], 1, 'end')).toEqual([2, 3, 1]);
    expect(insertUnique([1, 2, 3], 9, 1)).toEqual([1, 9, 2, 3]);
    expect(insertUnique([1, 2], 9, 99)).toEqual([1, 2, 9]);
    expect(insertUnique([], 5, 'end')).toEqual([5]);
  });
});

describe('moveItem', () => {
  it('moves up and down and clamps at the ends', () => {
    expect(moveItem([1, 2, 3], 2, -1)).toEqual([1, 3, 2]);
    expect(moveItem([1, 2, 3], 0, 1)).toEqual([2, 1, 3]);
    expect(moveItem([1, 2, 3], 0, -1)).toEqual([1, 2, 3]);
    expect(moveItem([1, 2, 3], 2, 5)).toEqual([1, 2, 3]);
    expect(moveItem([1, 2, 3], 7, 1)).toEqual([1, 2, 3]);
  });
  it('does not mutate its input', () => {
    const a = [1, 2, 3];
    moveItem(a, 0, 2);
    expect(a).toEqual([1, 2, 3]);
  });
});

describe('queue persistence', () => {
  beforeEach(async () => {
    await Promise.all(db.tables.map((t) => t.clear()));
  });

  it('creates the default queue on demand and reuses it', async () => {
    const q = await getDefaultQueue();
    expect(q.name).toBe(DEFAULT_QUEUE_NAME);
    expect((await getDefaultQueue()).id).toBe(q.id);
    expect(await db.queues.count()).toBe(1);
  });

  it('adds, reorders and removes episodes', async () => {
    const id = await createQueue('Commute');
    await addToQueue(id, 10);
    await addToQueue(id, 11);
    await addToQueue(id, 12, 'next');
    expect((await db.queues.get(id))!.episodeIds).toEqual([12, 10, 11]);
    await addToQueue(id, 10); // already present: moves to the end
    expect((await db.queues.get(id))!.episodeIds).toEqual([12, 11, 10]);
    await moveInQueue(id, 2, -2);
    expect((await db.queues.get(id))!.episodeIds).toEqual([10, 12, 11]);
    await removeFromQueue(id, 12);
    expect((await db.queues.get(id))!.episodeIds).toEqual([10, 11]);
  });

  it('keeps several independent queues in order, and deletes them', async () => {
    const a = await createQueue('A');
    const b = await createQueue('  ');
    expect((await db.queues.orderBy('order').toArray()).map((q) => q.name)).toEqual(['A', 'New queue']);
    await addToQueue(a, 1);
    await addToQueue(b, 2);
    await deleteQueue(a);
    expect(await db.queues.count()).toBe(1);
    expect((await db.queues.get(b))!.episodeIds).toEqual([2]);
  });

  it('prunes entries for episodes that no longer exist', async () => {
    const podcastId = await db.podcasts.add({ url: 'https://p.example/rss', title: 'P', description: '', groupIds: [], addedAt: 1 });
    const keep = await db.episodes.add({ podcastId, guid: 'a', title: 'A', publishedAt: 1, summary: '', enclosureUrl: 'https://x/a.mp3', played: 0, position: 0, addedAt: 1 });
    const q = await createQueue('Q');
    await addToQueue(q, keep);
    await addToQueue(q, 9999);
    await pruneQueues();
    expect((await db.queues.get(q))!.episodeIds).toEqual([keep]);
  });
});
