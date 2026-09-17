import { createHash, randomBytes } from 'crypto'

export interface HttpCredentials {
  username: string
  password: string
}

export interface HttpRequestOptions {
  credentials?: HttpCredentials
  timeoutMs?: number
  signal?: AbortSignal
}

export class RecorderHttpError extends Error {
  public readonly status: number
  public readonly endpoint: string

  constructor(message: string, status: number, endpoint: string) {
    super(message)
    this.name = 'RecorderHttpError'
    this.status = status
    this.endpoint = endpoint
  }
}

export class RecorderAuthError extends RecorderHttpError {
  constructor(endpoint: string) {
    super('El grabador rechazó las credenciales.', 401, endpoint)
    this.name = 'RecorderAuthError'
  }
}

export class RecorderTimeoutError extends Error {
  constructor(endpoint: string) {
    super('El grabador no respondió a tiempo.')
    this.name = 'RecorderTimeoutError'
    this.endpoint = endpoint
  }

  public readonly endpoint: string
}

export async function requestText(
  endpoint: string,
  init: RequestInit = {},
  options: HttpRequestOptions = {}
): Promise<string> {
  const response = await request(endpoint, init, options)
  return response.text()
}

export async function requestBytes(
  endpoint: string,
  init: RequestInit = {},
  options: HttpRequestOptions = {}
): Promise<{ data: Uint8Array; contentType: string }> {
  const response = await request(endpoint, init, options)
  return {
    data: new Uint8Array(await response.arrayBuffer()),
    contentType: response.headers.get('content-type') || 'application/octet-stream'
  }
}

export async function request(
  endpoint: string,
  init: RequestInit = {},
  options: HttpRequestOptions = {}
): Promise<Response> {
  const timeoutMs = Math.min(Math.max(Math.floor(options.timeoutMs ?? 6000), 500), 30000)
  const firstResponse = await fetchWithTimeout(endpoint, init, timeoutMs, options.signal)

  if (firstResponse.status !== 401 || !options.credentials) {
    return ensureSuccessful(firstResponse, endpoint)
  }

  const challenge = firstResponse.headers.get('www-authenticate') || ''
  const authorization = createAuthorization(challenge, options.credentials, init.method || 'GET', endpoint)
  const headers = new Headers(init.headers)
  headers.set('Authorization', authorization)

  const authenticatedResponse = await fetchWithTimeout(
    endpoint,
    { ...init, headers },
    timeoutMs,
    options.signal
  )
  return ensureSuccessful(authenticatedResponse, endpoint)
}

export function buildHttpUrl(host: string, port: number, path: string, secure = false): string {
  const protocol = secure ? 'https' : 'http'
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  return `${protocol}://${host}:${port}${normalizedPath}`
}

export function buildRtspUrl(
  host: string,
  port: number,
  credentials: HttpCredentials | undefined,
  path: string
): string {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  const url = new URL(`rtsp://${host}:${port}${normalizedPath}`)
  if (credentials?.username) {
    url.username = credentials.username
    url.password = credentials.password
  }
  return url.toString()
}

export function redactUrl(value: string): string {
  return value.replace(/(rtsp|https?|onvif):\/\/[^\s/@:]+(?::[^\s/@]*)?@/gi, '$1://***:***@')
}

async function fetchWithTimeout(
  endpoint: string,
  init: RequestInit,
  timeoutMs: number,
  parentSignal?: AbortSignal
): Promise<Response> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  const abortParent = (): void => controller.abort()

  if (parentSignal) {
    if (parentSignal.aborted) controller.abort()
    else parentSignal.addEventListener('abort', abortParent, { once: true })
  }

  try {
    return await fetch(endpoint, { ...init, signal: controller.signal })
  } catch (error) {
    if (controller.signal.aborted) {
      if (parentSignal?.aborted) throw new Error('La operación fue cancelada.')
      throw new RecorderTimeoutError(endpoint)
    }
    throw error
  } finally {
    clearTimeout(timeout)
    parentSignal?.removeEventListener('abort', abortParent)
  }
}

function ensureSuccessful(response: Response, endpoint: string): Response {
  if (response.status === 401 || response.status === 403) {
    throw new RecorderAuthError(endpoint)
  }
  if (!response.ok) {
    throw new RecorderHttpError(
      `El grabador respondió con un error HTTP (${response.status}).`,
      response.status,
      endpoint
    )
  }
  return response
}

function createAuthorization(
  challenge: string,
  credentials: HttpCredentials,
  method: string,
  endpoint: string
): string {
  if (/^Basic\b/i.test(challenge)) {
    return `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')}`
  }

  if (!/^Digest\b/i.test(challenge)) {
    return `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')}`
  }

  const values = parseChallenge(challenge)
  if (!values.realm || !values.nonce) {
    throw new RecorderAuthError(endpoint)
  }

  const uri = new URL(endpoint).pathname + new URL(endpoint).search
  const qop = values.qop
    ?.split(',')
    .map((item) => item.trim())
    .find((item) => item === 'auth')
  const nc = '00000001'
  const cnonce = randomBytes(16).toString('hex')
  const ha1 = md5(`${credentials.username}:${values.realm}:${credentials.password}`)
  const ha2 = md5(`${method.toUpperCase()}:${uri}`)
  const response = qop
    ? md5(`${ha1}:${values.nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
    : md5(`${ha1}:${values.nonce}:${ha2}`)

  const parts = [
    `username="${escapeHeaderValue(credentials.username)}"`,
    `realm="${escapeHeaderValue(values.realm)}"`,
    `nonce="${escapeHeaderValue(values.nonce)}"`,
    `uri="${uri}"`,
    `response="${response}"`
  ]
  if (values.algorithm) parts.push(`algorithm=${values.algorithm}`)
  if (values.opaque) parts.push(`opaque="${escapeHeaderValue(values.opaque)}"`)
  if (qop) {
    parts.push(`qop=${qop}`)
    parts.push(`nc=${nc}`)
    parts.push(`cnonce="${cnonce}"`)
  }

  return `Digest ${parts.join(', ')}`
}

function parseChallenge(challenge: string): Record<string, string> {
  const values: Record<string, string> = {}
  const expression = /([a-zA-Z][a-zA-Z0-9_-]*)=("(?:\\.|[^"])*"|[^,\s]+)/g
  let match: RegExpExecArray | null
  const digestChallenge = challenge.replace(/^Digest\s+/i, '')

  while ((match = expression.exec(digestChallenge))) {
    values[match[1]] = match[2].replace(/^"|"$/g, '').replace(/\\([\\"])/g, '$1')
  }

  return values
}

function md5(value: string): string {
  return createHash('md5').update(value).digest('hex')
}

function escapeHeaderValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}
