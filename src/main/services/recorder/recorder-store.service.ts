import { randomUUID } from 'crypto'
import Store from 'electron-store'
import type { LocalRecorder, RecorderDeviceInfo, RecorderVendor } from '../../../shared/video-source'
import { vaultService } from '../vault.service'

export interface RecorderCreateInput {
  profileId: string
  name: string
  host: string
  httpPort?: number
  httpsPort?: number
  rtspPort?: number
  vendor?: RecorderVendor
  username: string
  password: string
}

export interface RecorderUpdateInput {
  name?: string
  host?: string
  httpPort?: number
  httpsPort?: number
  rtspPort?: number
  vendor?: RecorderVendor
  username?: string
  password?: string
}

interface StoredRecorder extends Omit<LocalRecorder, 'updated_at' | 'created_at'> {
  created_at: string
  updated_at?: string
}

interface RecorderStoreSchema {
  recorders: StoredRecorder[]
}

const USERNAME_KEY = (recorderId: string): string => `RECORDER_${recorderId}_USERNAME`
const PASSWORD_KEY = (recorderId: string): string => `RECORDER_${recorderId}_PASSWORD`

class RecorderStoreService {
  private store: Store<RecorderStoreSchema>

  constructor() {
    const StoreClass = (
      typeof Store === 'function' ? Store : (Store as unknown as { default: typeof Store }).default
    ) as typeof Store

    this.store = new StoreClass({
      name: 'padelview-local-recorders',
      defaults: { recorders: [] as StoredRecorder[] }
    })
  }

  public list(profileId: string): LocalRecorder[] {
    if (!profileId) return []
    return this.store
      .get('recorders')
      .filter((recorder) => recorder.profile_id === profileId)
      .sort((left, right) => left.name.localeCompare(right.name, 'es'))
      .map((recorder) => this.toLocalRecorder(recorder))
  }

  public getById(recorderId: string, profileId?: string): LocalRecorder | null {
    if (!recorderId) return null
    const recorder = this.store.get('recorders').find(
      (candidate) =>
        candidate.id === recorderId && (!profileId || candidate.profile_id === profileId)
    )
    return recorder ? this.toLocalRecorder(recorder) : null
  }

  public create(input: RecorderCreateInput): LocalRecorder {
    this.assertProfileId(input.profileId)
    const now = new Date().toISOString()
    const recorder: StoredRecorder = {
      id: randomUUID(),
      name: this.normalizeName(input.name),
      host: this.normalizeHost(input.host),
      httpPort: this.normalizePort(input.httpPort ?? 80),
      httpsPort: this.normalizePort(input.httpsPort ?? 443),
      rtspPort: this.normalizePort(input.rtspPort ?? 554),
      vendor: input.vendor || 'unknown',
      profile_id: input.profileId,
      created_at: now,
      updated_at: now
    }

    this.store.set('recorders', [...this.store.get('recorders'), recorder])
    this.saveCredentials(recorder.id, input.username, input.password)
    return this.toLocalRecorder(recorder)
  }

  public update(recorderId: string, profileId: string, updates: RecorderUpdateInput): LocalRecorder {
    this.assertProfileId(profileId)
    const recorders = this.store.get('recorders')
    const index = recorders.findIndex(
      (candidate) => candidate.id === recorderId && candidate.profile_id === profileId
    )
    if (index < 0) throw new Error('El grabador no existe o no pertenece al usuario actual.')

    const current = recorders[index]
    const updated: StoredRecorder = {
      ...current,
      ...(updates.name === undefined ? {} : { name: this.normalizeName(updates.name) }),
      ...(updates.host === undefined ? {} : { host: this.normalizeHost(updates.host) }),
      ...(updates.httpPort === undefined ? {} : { httpPort: this.normalizePort(updates.httpPort) }),
      ...(updates.httpsPort === undefined ? {} : { httpsPort: this.normalizePort(updates.httpsPort) }),
      ...(updates.rtspPort === undefined ? {} : { rtspPort: this.normalizePort(updates.rtspPort) }),
      ...(updates.vendor === undefined ? {} : { vendor: updates.vendor }),
      updated_at: new Date().toISOString()
    }

    const next = [...recorders]
    next[index] = updated
    this.store.set('recorders', next)

    if (updates.username !== undefined || updates.password !== undefined) {
      const currentCredentials = this.getCredentials(recorderId, profileId)
      this.saveCredentials(
        recorderId,
        updates.username ?? currentCredentials.username,
        updates.password ?? currentCredentials.password
      )
    }

    return this.toLocalRecorder(updated)
  }

  public delete(recorderId: string, profileId: string): boolean {
    this.assertProfileId(profileId)
    const recorders = this.store.get('recorders')
    const recorder = recorders.find(
      (candidate) => candidate.id === recorderId && candidate.profile_id === profileId
    )
    if (!recorder) return false

    this.store.set(
      'recorders',
      recorders.filter((candidate) => candidate.id !== recorderId)
    )
    vaultService.deleteSecret(USERNAME_KEY(recorderId))
    vaultService.deleteSecret(PASSWORD_KEY(recorderId))
    return true
  }

  public getCredentials(recorderId: string, profileId?: string): { username: string; password: string } {
    const recorder = this.getById(recorderId, profileId)
    if (!recorder) throw new Error('El grabador no existe o no pertenece al usuario actual.')
    return {
      username: vaultService.getSecret(USERNAME_KEY(recorderId)) || '',
      password: vaultService.getSecret(PASSWORD_KEY(recorderId)) || ''
    }
  }

  public hasCredentials(recorderId: string, profileId?: string): boolean {
    const credentials = this.getCredentials(recorderId, profileId)
    return Boolean(credentials.username && credentials.password)
  }

  public markDiscovery(recorderId: string, profileId: string, info: RecorderDeviceInfo): void {
    const recorders = this.store.get('recorders')
    const index = recorders.findIndex(
      (candidate) => candidate.id === recorderId && candidate.profile_id === profileId
    )
    if (index < 0) return

    const current = recorders[index]
    const updated: StoredRecorder = {
      ...current,
      vendor: info.vendor === 'unknown' ? current.vendor : info.vendor,
      model: info.model || current.model,
      serialNumber: info.serialNumber || current.serialNumber,
      onvifSupported: info.onvifSupported ?? current.onvifSupported,
      lastSuccessfulConnectionAt: new Date().toISOString(),
      lastDetectedVendor: info.vendor,
      lastDetectedModel: info.model || current.lastDetectedModel,
      updated_at: new Date().toISOString()
    }
    const next = [...recorders]
    next[index] = updated
    this.store.set('recorders', next)
  }

  private saveCredentials(recorderId: string, username: string, password: string): void {
    if (!username.trim()) throw new Error('El usuario del grabador es obligatorio.')
    if (!password) throw new Error('La contraseña del grabador es obligatoria.')
    vaultService.setSecret(USERNAME_KEY(recorderId), username.trim())
    vaultService.setSecret(PASSWORD_KEY(recorderId), password)
  }

  private toLocalRecorder(recorder: StoredRecorder): LocalRecorder {
    return {
      id: recorder.id,
      name: recorder.name,
      host: recorder.host,
      httpPort: recorder.httpPort,
      httpsPort: recorder.httpsPort,
      rtspPort: recorder.rtspPort,
      vendor: recorder.vendor,
      model: recorder.model,
      serialNumber: recorder.serialNumber,
      onvifSupported: recorder.onvifSupported,
      lastSuccessfulConnectionAt: recorder.lastSuccessfulConnectionAt,
      lastDetectedVendor: recorder.lastDetectedVendor,
      lastDetectedModel: recorder.lastDetectedModel,
      profile_id: recorder.profile_id,
      created_at: recorder.created_at,
      updated_at: recorder.updated_at || recorder.created_at
    }
  }

  private normalizeName(value: string): string {
    const normalized = value.trim()
    if (!normalized) throw new Error('El nombre del grabador es obligatorio.')
    return normalized
  }

  private normalizeHost(value: string): string {
    const normalized = value.trim()
    if (!normalized || /[\s/@]/.test(normalized) || normalized.includes('://')) {
      throw new Error('La dirección del grabador no es válida.')
    }
    return normalized
  }

  private normalizePort(value: number): number {
    if (!Number.isInteger(value) || value < 1 || value > 65535) {
      throw new Error('El puerto del grabador no es válido.')
    }
    return value
  }

  private assertProfileId(profileId: string): void {
    if (!profileId) throw new Error('No hay un usuario autenticado para asociar el grabador.')
  }
}

export const recorderStoreService = new RecorderStoreService()
export { USERNAME_KEY as recorderUsernameKey, PASSWORD_KEY as recorderPasswordKey }
