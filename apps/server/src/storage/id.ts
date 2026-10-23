const SAFE_OBJECT_ID = /^[A-Za-z0-9_-]{1,128}$/

export function assertObjectId(id: string): void {
  if (!SAFE_OBJECT_ID.test(id)) {
    throw new Error('Invalid object id')
  }
}
