export type SharePresets = { days: number[]; views: number[] }

export const emptySharePresets: SharePresets = { days: [], views: [] }
export const defaultShareDays = [1, 7]
export const defaultShareViews = [1, 5, 10]

export function shareChoices(defaults: number[], custom: number[]) {
  return [...new Set([...defaults, ...custom])].sort((a, b) => a - b)
}
