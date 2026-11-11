import { randomUUID } from 'crypto'
import { app } from 'electron'
import Store from 'electron-store'
import { dbService } from './db.service'

export type SupportModeStatus = 'inactive' | 'active' | 'expired' | 'revoked'
export type DiagnosticLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal'
export type DiagnosticEventStatus =
  | 'started'
  | 'success'
  | 'failed'
  | 'cancelled'
  | 'skipped'

export interface SupportModeSession {
  status: SupportModeStatus
  supportSessionId: string
  profileId: string
  installationId: string
  activatedAt: string
  expiresAt: string
}

export interface DiagnosticEvent {
  eventId: string
  timestamp: string
  level: DiagnosticLevel
  event: string
  component: string
  action: string
  status: DiagnosticEventStatus
  message: string
  appVersion: string
  platform: string
  installationId: string
  supportSessionId: string
  profileId?: string
  correlationId?: string
  durationMs?: number
  metadata?: Record<string, unknown>
  error?: {
    name?: string
    message: string
    code?: string
    stack?: string
  }
}

interface SupportStoreSchema {
  installationId: string
  session: SupportModeSession | null
  queue: DiagnosticEvent[]
}

const MAX_QUEUE_SIZE = 5000
const MAX_BATCH_SIZE = 100

function sanitizeValue(value: unknown, key = ''): unknown {
  const sensitiveKey = /password|secret|token|authorization|api[_-]?key|credential|signedurl|rtsp/i
  if (sensitiveKey.test(key)) return '[REDACTED]'

  if (typeof value === 'string') {
    return value
      .replace(/bearer\s+[^\s]+/gi, 'Bearer [REDACTED]')
      .replace(/(rtsp:\/\/)([^@\s]+)@/gi, '$1[REDACTED]@')
      .replace(
        /([?&](?:access_token|refresh_token|provider_token|id_token|code)=)[^&#\s]+/gi,
        '$1[REDACTED]'
      )
  }

  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, key))

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [
        childKey,
        sanitizeValue(childValue, childKey)
      ])
    )
  }

  return value
}

function serializeError(error: unknown): DiagnosticEvent['error'] | undefined {
  if (!error) return undefined
  if (error instanceof Error) {
    return {
      name: error.name,
      message: sanitizeValue(error.message) as string,
      stack: sanitizeValue(error.stack) as string | undefined
    }
  }
  return { message: String(sanitizeValue(error)) }
}

class SupportDiagnosticsService {
  private readonly store: Store<SupportStoreSchema>

  constructor() {
    const StoreClass = (
      typeof Store === 'function' ? Store : (Store as any).default
    ) as typeof Store
    this.store = new StoreClass({
      name: 'padelview-support-diagnostics',
      defaults: {
        installationId: randomUUID(),
        session: null,
        queue: []
      }
    }) as unknown as Store<SupportStoreSchema>
  }

  public getInstallationId(): string {
    return this.store.get('installationId')
  }

  public getStatus(): {
    status: SupportModeStatus
    session: SupportModeSession | null
    pendingEvents: number
  } {
    const session = this.store.get('session')
    if (session && session.status === 'active' && Date.now() >= Date.parse(session.expiresAt)) {
      const expiredSession = { ...session, status: 'expired' as const }
      this.store.set('session', expiredSession)
      return {
        status: 'expired',
        session: expiredSession,
        pendingEvents: this.store.get('queue').length
      }
    }

    return {
      status: session?.status || 'inactive',
      session,
      pendingEvents: this.store.get('queue').length
    }
  }

  public async activate(code: string): Promise<{
    success: boolean
    error?: string
    session?: SupportModeSession
  }> {
    try {
      const profileId = dbService.getProfileId()
      if (!profileId) return { success: false, error: 'No hay una sesión de usuario activa.' }

      const { data, error } = await dbService.getClient().rpc('activate_support_session', {
        input_code: code.trim(),
        installation: this.getInstallationId(),
        app_version: app.getVersion()
      })

      if (error || !data?.[0]) {
        return { success: false, error: error?.message || 'Código de soporte inválido.' }
      }

      const row = data[0]
      const session: SupportModeSession = {
        status: 'active',
        supportSessionId: row.support_session_id,
        profileId: row.profile_id,
        installationId: this.getInstallationId(),
        activatedAt: row.activated_at,
        expiresAt: row.expires_at
      }
      this.store.set('session', session)
      this.record({
        level: 'info',
        event: 'support.mode.activated',
        component: 'support',
        action: 'activate',
        status: 'success',
        message: 'El modo soporte fue activado correctamente.',
        metadata: { expiresAt: session.expiresAt }
      })
      return { success: true, session }
    } catch (error) {
      console.warn('[Support] Could not activate support mode:', error)
      return { success: false, error: (error as Error).message }
    }
  }

  public record(input: {
    level: DiagnosticLevel
    event: string
    component: string
    action: string
    status: DiagnosticEventStatus
    message: string
    correlationId?: string
    durationMs?: number
    metadata?: Record<string, unknown>
    error?: unknown
  }): void {
    const { status, session } = this.getStatus()
    if (status !== 'active' || !session) return

    const event: DiagnosticEvent = {
      eventId: randomUUID(),
      timestamp: new Date().toISOString(),
      level: input.level,
      event: input.event,
      component: input.component,
      action: input.action,
      status: input.status,
      message: sanitizeValue(input.message) as string,
      appVersion: app.getVersion(),
      platform: process.platform,
      installationId: session.installationId,
      supportSessionId: session.supportSessionId,
      profileId: session.profileId,
      correlationId: input.correlationId,
      durationMs: input.durationMs,
      metadata: sanitizeValue(input.metadata || {}) as Record<string, unknown>,
      error: serializeError(input.error)
    }

    const queue = this.store.get('queue')
    const nextQueue = [...queue, event]
    if (nextQueue.length > MAX_QUEUE_SIZE) {
      const firstErrorIndex = nextQueue.findIndex(
        (queuedEvent) => queuedEvent.level === 'debug' || queuedEvent.level === 'info'
      )
      if (firstErrorIndex >= 0) nextQueue.splice(firstErrorIndex, 1)
      else nextQueue.shift()
    }
    this.store.set('queue', nextQueue)
  }

  public async flush(): Promise<{
    success: boolean
    uploaded: number
    pending: number
    error?: string
  }> {
    const { status, session } = this.getStatus()
    if (status !== 'active' || !session) {
      return { success: false, uploaded: 0, pending: this.store.get('queue').length }
    }

    const queue = this.store.get('queue')
    if (!queue.length) return { success: true, uploaded: 0, pending: 0 }

    const batch = queue.slice(0, MAX_BATCH_SIZE)
    try {
      const { data, error } = await dbService.getClient().rpc('ingest_support_events', {
        target_session_id: session.supportSessionId,
        events: batch.map((event) => ({
          event_id: event.eventId,
          timestamp: event.timestamp,
          level: event.level,
          event: event.event,
          component: event.component,
          action: event.action,
          status: event.status,
          message: event.message,
          app_version: event.appVersion,
          platform: event.platform,
          installation_id: event.installationId,
          profile_id: event.profileId,
          correlation_id: event.correlationId,
          duration_ms: event.durationMs,
          metadata: event.metadata,
          error: event.error
        }))
      })
      if (error) throw error

      const uploaded = Number(data?.[0]?.accepted_count || 0) + Number(data?.[0]?.duplicate_count || 0)
      this.store.set('queue', queue.slice(batch.length))
      return { success: true, uploaded, pending: queue.length - batch.length }
    } catch (error) {
      console.warn('[Support] Diagnostic upload failed:', error)
      return {
        success: false,
        uploaded: 0,
        pending: queue.length,
        error: (error as Error).message
      }
    }
  }

  public getQueueStatus(): { pendingEvents: number; status: SupportModeStatus } {
    const status = this.getStatus()
    return { pendingEvents: status.pendingEvents, status: status.status }
  }
}

export const supportDiagnosticsService = new SupportDiagnosticsService()
