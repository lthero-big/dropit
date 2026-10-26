import { describe, expect, it } from 'vitest'
import { adoptResume, matchResumeFile, memoryStore, receivedRatio, resumeKey, type ResumeRecord } from './chunked-upload.ts'
import { claimUpload, heartbeatUploads, ownsUpload, releaseUploads } from './upload-claims.ts'

function file(name: string, size: number, lastModified: number) {
  return new File([new Uint8Array(size)], name, { type: 'text/plain', lastModified })
}

function record(target: File, patch: Partial<ResumeRecord> = {}): ResumeRecord {
  return {
    key: resumeKey('/api/spaces/s1', target),
    base: '/api/spaces/s1',
    uploadId: 'up-1',
    chunkSize: 4,
    expiresAt: 1_800_000_000_000,
    size: target.size,
    name: target.name || '截图',
    ...patch,
  }
}

describe('resume file match', () => {
  const original = file('notes.txt', 8, 1_700_000_000_000)

  it('matches the same name, size, and lastModified', () => {
    expect(matchResumeFile(record(original), original)).toEqual({ kind: 'match' })
  })

  it('asks before continuing when only lastModified differs', () => {
    const shifted = file('notes.txt', 8, original.lastModified + 5)
    expect(matchResumeFile(record(original), shifted)).toEqual({ kind: 'mtime' })
  })

  it('names the field that differs and does not treat that as a time mismatch', () => {
    expect(matchResumeFile(record(original), file('other.txt', 8, original.lastModified))).toEqual({ kind: 'mismatch', fields: ['文件名'] })
    expect(matchResumeFile(record(original), file('notes.txt', 9, original.lastModified))).toEqual({ kind: 'mismatch', fields: ['大小'] })
    expect(matchResumeFile(record(original), file('other.txt', 9, original.lastModified + 5))).toEqual({ kind: 'mismatch', fields: ['文件名', '大小'] })
  })

  it('rekeys an existing session without opening a new upload id', () => {
    const store = memoryStore()
    const saved = record(original)
    store.put(saved)
    const shifted = file('notes.txt', 8, original.lastModified + 5)
    const next = adoptResume(store, saved, shifted)
    expect(next.uploadId).toBe('up-1')
    expect(store.get(saved.key)).toBeNull()
    expect(store.get(resumeKey('/api/spaces/s1', shifted))?.uploadId).toBe('up-1')
  })

  it('counts received chunk bytes without inventing a speed', () => {
    expect(receivedRatio(8, 4, [0])).toBe(0.5)
    expect(receivedRatio(8, 4, [0, 0, 1])).toBe(1)
  })
})

describe('upload claims', () => {
  it('lets an expired lock be taken over and ignores a live foreign lock', () => {
    localStorage.clear()
    expect(claimUpload('up-1', 'tab-b', 1_000, 15_000)).toBe(true)
    expect(claimUpload('up-1', 'tab-a', 2_000, 15_000)).toBe(false)
    expect(ownsUpload('up-1', 'tab-b', 2_000)).toBe(true)
    expect(claimUpload('up-1', 'tab-a', 20_000, 15_000)).toBe(true)
    expect(ownsUpload('up-1', 'tab-a', 20_000)).toBe(true)
    heartbeatUploads(['up-1'], 'tab-a', 21_000, 15_000)
    expect(ownsUpload('up-1', 'tab-a', 35_000)).toBe(true)
    releaseUploads(['up-1'], 'tab-b')
    expect(ownsUpload('up-1', 'tab-a', 22_000)).toBe(true)
    releaseUploads(['up-1'], 'tab-a')
    expect(ownsUpload('up-1', 'tab-a', 22_000)).toBe(false)
  })
})
