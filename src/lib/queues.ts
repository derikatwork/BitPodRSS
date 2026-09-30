import { db, type Queue } from '../db';

/** Pure list operations on a queue's episode ids. */
export function insertUnique(ids: readonly number[], id: number, at: 'end' | 'next' | number): number[] {
  const without = ids.filter((x) => x !== id);
  const index = at === 'end' ? without.length : at === 'next' ? 0 : Math.min(Math.max(0, at), without.length);
  return [...without.slice(0, index), id, ...without.slice(index)];
}

export function moveItem(ids: readonly number[], index: number, delta: number): number[] {
  const target = Math.min(Math.max(0, index + delta), ids.length - 1);
  if (index < 0 || index >= ids.length || target === index) return [...ids];
  const copy = [...ids];
  const [item] = copy.splice(index, 1);
  copy.splice(target, 0, item!);
  return copy;
}

export const DEFAULT_QUEUE_NAME = 'Up next';

/** The first queue, creating "Up next" if the user has none yet. */
export async function getDefaultQueue(): Promise<Queue> {
  const first = await db.queues.orderBy('order').first();
  if (first) return first;
  const id = await db.queues.add({ name: DEFAULT_QUEUE_NAME, order: 0, episodeIds: [] });
  return (await db.queues.get(id))!;
}

export async function createQueue(name: string): Promise<number> {
  return db.queues.add({ name: name.trim() || 'New queue', order: await db.queues.count(), episodeIds: [] });
}

export async function addToQueue(queueId: number, episodeId: number, at: 'end' | 'next' = 'end'): Promise<void> {
  await db.transaction('rw', db.queues, async () => {
    const q = await db.queues.get(queueId);
    if (q) await db.queues.update(queueId, { episodeIds: insertUnique(q.episodeIds, episodeId, at) });
  });
}

export async function removeFromQueue(queueId: number, episodeId: number): Promise<void> {
  await db.transaction('rw', db.queues, async () => {
    const q = await db.queues.get(queueId);
    if (q) await db.queues.update(queueId, { episodeIds: q.episodeIds.filter((id) => id !== episodeId) });
  });
}

export async function moveInQueue(queueId: number, index: number, delta: number): Promise<void> {
  await db.transaction('rw', db.queues, async () => {
    const q = await db.queues.get(queueId);
    if (q) await db.queues.update(queueId, { episodeIds: moveItem(q.episodeIds, index, delta) });
  });
}

export async function deleteQueue(queueId: number): Promise<void> {
  await db.queues.delete(queueId);
}

/** Drop queue entries whose episodes were deleted (e.g. after unsubscribing). */
export async function pruneQueues(): Promise<void> {
  const queues = await db.queues.toArray();
  for (const q of queues) {
    const existing = new Set((await db.episodes.bulkGet(q.episodeIds)).filter(Boolean).map((e) => e!.id));
    const kept = q.episodeIds.filter((id) => existing.has(id));
    if (kept.length !== q.episodeIds.length) await db.queues.update(q.id, { episodeIds: kept });
  }
}
