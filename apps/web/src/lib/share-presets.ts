export type SharePresets = { hours: number[]; days: number[]; months: number[]; views: number[] }

export const emptySharePresets: SharePresets = { hours: [], days: [], months: [], views: [] }
export const defaultShareDays = [1, 3, 7]
export const defaultShareViews = [1, 5, 10]
export const expiryUnits = {
  hours: { label: '小时', suffix: 'h', max: 87600, hours: 1 },
  days: { label: '天', suffix: 'd', max: 3650, hours: 24 },
  months: { label: '个月', suffix: 'mo', max: 121, hours: 720 },
} as const
export type ExpiryUnit = keyof typeof expiryUnits

export function customShareExpiries(presets: SharePresets) {
  return (Object.keys(expiryUnits) as ExpiryUnit[]).flatMap((kind) => presets[kind].map((value) => ({
    kind, value, hours: value * expiryUnits[kind].hours,
    expiresIn: `${value}${expiryUnits[kind].suffix}`, label: `${value} ${expiryUnits[kind].label}`,
  }))).sort((a, b) => a.hours - b.hours)
}

export function shareExpiryChoices(presets: SharePresets) {
  const defaults = customShareExpiries({ ...emptySharePresets, hours: [1], days: defaultShareDays })
  return [...defaults, ...customShareExpiries(presets)]
    .filter((entry, index, all) => all.findIndex((other) => other.hours === entry.hours) === index)
    .sort((a, b) => a.hours - b.hours)
}

export function shareChoices(defaults: number[], custom: number[]) {
  return [...new Set([...defaults, ...custom])].sort((a, b) => a - b)
}
