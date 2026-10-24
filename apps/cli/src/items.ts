import { CliError } from './errors.js';

export interface Item {
  id: string;
  spaceId: string;
  userId: string | null;
  kind: 'text' | 'file';
  text: string | null;
  filename: string | null;
  mime: string | null;
  size: number;
  hasThumbnail?: boolean;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  pinned: boolean;
  tags: string[];
}

export interface SpaceInfo {
  id: string;
  name: string;
  ownerId: string | null;
  expiresAt: number | null;
}

export function latestItem(items: readonly Item[]): Item | undefined {
  let best: Item | undefined;
  for (const item of items) {
    if (!best || item.createdAt > best.createdAt || (item.createdAt === best.createdAt && item.id > best.id)) best = item;
  }
  return best;
}

export function pickSpace(spaces: readonly SpaceInfo[], userId: string, requested?: string, saved?: string): SpaceInfo {
  if (requested) {
    const matches = spaces.filter(space => space.id === requested || space.name === requested);
    if (matches.length === 1) return matches[0]!;
    if (matches.length === 0) throw new CliError('NOT_FOUND', `没有匹配的空间：${requested}`);
    throw new CliError('AMBIGUOUS', '空间名称对应多个空间，请改用 id');
  }
  if (saved) {
    const found = spaces.find(space => space.id === saved);
    if (found) return found;
  }
  const owned = spaces.filter(space => space.ownerId === userId);
  if (owned.length === 1) return owned[0]!;
  if (spaces.length === 1) return spaces[0]!;
  throw new CliError('SPACE_REQUIRED', '有多个空间，请用 --space 指定');
}
