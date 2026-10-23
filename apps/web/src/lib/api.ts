import type { Item } from './types.ts'

export class ApiError extends Error {
  status: number
  code: string
  retryAfter: number | null

  constructor(status: number, code: string, retryAfter: number | null) {
    super(code)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.retryAfter = retryAfter
  }
}

const labels: Record<string, string> = {
  INVALID_INPUT: '输入无效',
  INVALID_JSON: '请求格式无效',
  JSON_REQUIRED: '请求格式无效',
  EMPTY_TEXT: '文本不能为空',
  EMPTY_FILE: '文件是空的',
  UPLOAD_TIMEOUT: '上传超时',
  INVALID_FILENAME: '文件名无效',
  OAUTH_STATE_INVALID: '登录状态已失效，请重试',
  OAUTH_DENIED: '登录被取消',
  OAUTH_PROVIDER_ERROR: '登录服务暂时不可用',
  UNAUTHENTICATED: '请先登录',
  FORBIDDEN: '没有权限',
  ORIGIN_REJECTED: '请求来源被拒绝',
  USER_DISABLED: '账号已停用',
  INVITATION_REQUIRED: '需要邀请才能注册',
  INVITE_INVALID: '邀请无效',
  VERIFIED_EMAIL_REQUIRED: '需要已验证的邮箱',
  NOT_FOUND: '内容不存在或已过期',
  PROVIDER_UNAVAILABLE: '该登录方式未配置',
  LAST_ADMIN: '必须保留至少一位管理员',
  EMAIL_IN_USE: '该邮箱已有账号',
  BODY_TOO_LARGE: '内容超过大小上限',
  TEXT_TOO_LARGE: '文本超过长度上限',
  FILE_TOO_LARGE: '文件超过大小上限',
  QUOTA_EXCEEDED: '已超过配额',
  ITEM_LIMIT: '条目数量已达上限',
  INVALID_IMAGE: '图片无法处理',
  RATE_LIMITED: '请求过于频繁',
  UPLOAD_BUSY: '上传过于频繁',
  SOCKET_LIMIT: '连接数已达上限',
  INTERNAL_ERROR: '服务暂时不可用',
}

const oauthLoginErrors = new Set([
  'OAUTH_STATE_INVALID',
  'OAUTH_DENIED',
  'OAUTH_PROVIDER_ERROR',
  'INVITE_INVALID',
  'INVITATION_REQUIRED',
  'USER_DISABLED',
  'VERIFIED_EMAIL_REQUIRED',
  'RATE_LIMITED',
  'INTERNAL_ERROR',
])

export function loginErrorText(code: string | null): string | null {
  if (!code || !oauthLoginErrors.has(code)) return null
  return labels[code] ?? null
}

export function errorText(error: unknown): string {
  if (error instanceof ApiError) {
    const label = labels[error.code] ?? '请求失败'
    return error.retryAfter ? `${label}，${error.retryAfter} 秒后再试` : label
  }
  return '网络异常，请重试'
}

async function readError(response: Response): Promise<ApiError> {
  let code = 'INTERNAL_ERROR'
  try {
    const body = (await response.json()) as { error?: { code?: string } }
    if (body.error?.code) code = body.error.code
  } catch {
    // Non-JSON errors still surface as a status code.
  }
  const retry = response.headers.get('Retry-After')
  const retryAfter = retry && /^\d+$/.test(retry) ? Number(retry) : null
  return new ApiError(response.status, code, retryAfter)
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { ...init, credentials: 'same-origin' })
  if (!response.ok) throw await readError(response)
  if (response.status === 204) return undefined as T
  const text = await response.text()
  return (text ? JSON.parse(text) : undefined) as T
}

export function uploadFile(
  base: string,
  file: File,
  onProgress: (ratio: number) => void,
): Promise<{ item: Item }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', `${base}/items/file`)
    xhr.withCredentials = true
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream')
    xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name || 'clipboard'))
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total)
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(JSON.parse(xhr.responseText) as { item: Item })
        return
      }
      let code = 'INTERNAL_ERROR'
      try {
        code = (JSON.parse(xhr.responseText) as { error?: { code?: string } }).error?.code ?? code
      } catch {
        // Keep the fallback code.
      }
      const retry = xhr.getResponseHeader('Retry-After')
      reject(new ApiError(xhr.status, code, retry && /^\d+$/.test(retry) ? Number(retry) : null))
    }
    xhr.onerror = () => reject(new ApiError(0, 'INTERNAL_ERROR', null))
    xhr.send(file)
  })
}
