import type { Item } from './items.js';

export interface WatchState {
  ready: boolean;
  items: Map<string, Item>;
}

export type WatchMessage =
  | { type: 'snapshot'; items: Item[] }
  | { type: 'item.created'; item: Item }
  | { type: 'item.updated'; item: Item }
  | { type: 'item.deleted'; id: string }
  | { type: 'presence'; devices: number };

export function createWatchState(): WatchState {
  return { ready: false, items: new Map() };
}

function byCreated(a: Item, b: Item): number {
  return a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1);
}

export function applyWatch(state: WatchState, message: WatchMessage): Item[] {
  if (message.type === 'snapshot') {
    const created = state.ready
      ? message.items.filter(item => !state.items.has(item.id)).sort(byCreated)
      : [];
    state.items = new Map(message.items.map(item => [item.id, item]));
    state.ready = true;
    return created;
  }
  if (!state.ready) return [];
  if (message.type === 'item.created' || message.type === 'item.updated') {
    const isNew = !state.items.has(message.item.id);
    state.items.set(message.item.id, message.item);
    return isNew ? [message.item] : [];
  }
  if (message.type === 'item.deleted') state.items.delete(message.id);
  return [];
}

export function nextDelay(attempt: number, random = Math.random()): number {
  const capped = Math.min(16, Math.max(0, attempt));
  const base = Math.min(30_000, 500 * 2 ** capped);
  return Math.round(base * (0.5 + random * 0.5));
}

export async function watchLoop(options: {
  connect: () => Promise<{ messages: AsyncIterable<string>; close: () => void }>;
  onItems: (items: Item[]) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  signal: AbortSignal;
  isFatal: (error: unknown) => boolean;
  state?: WatchState;
}): Promise<void> {
  const state = options.state ?? createWatchState();
  let attempt = 0;
  while (!options.signal.aborted) {
    let connection: { messages: AsyncIterable<string>; close: () => void } | undefined;
    try {
      connection = await options.connect();
      attempt = 0;
      for await (const raw of connection.messages) {
        if (options.signal.aborted) break;
        const created = applyWatch(state, JSON.parse(raw) as WatchMessage);
        if (created.length) await options.onItems(created);
      }
    } catch (error) {
      if (options.isFatal(error)) throw error;
    } finally {
      connection?.close();
    }
    if (options.signal.aborted) return;
    await options.sleep(nextDelay(attempt));
    attempt += 1;
  }
}
