import { randomUUID } from 'crypto'
import Store from 'electron-store'
import { vaultService } from './vault.service'
import type { VideoSource } from '../../shared/video-source'

export const LOCAL_COURT_STORAGE_VERSION = 2

export interface LocalCourt {
  id: string
  name: string
  created_at: string
  updated_at: string
  profile_id: string
  is_dvr: boolean
  video_source: VideoSource
}

export interface LocalCourtUpdate {
  name?: string
  is_dvr?: boolean
  video_source?: VideoSource
}

export interface CloudCourtRecord {
  id: string
  name: string
  created_at?: string | null
  rtsp_url_key?: string | null
}

interface StoredCourt {
  id: string
  name: string
  created_at: string
  updated_at?: string
  profile_id: string
  is_dvr?: boolean
  video_source?: VideoSource
}

interface LocalCourtSchema {
  courts: StoredCourt[]
  migrations: Record<string, number>
}

class LocalCourtService {
  private store: Store<LocalCourtSchema>

  constructor() {
    const StoreClass = (
      typeof Store === 'function' ? Store : (Store as unknown as { default: typeof Store }).default
    ) as typeof Store

    this.store = new StoreClass({
      name: 'padelview-local-courts',
      defaults: {
        courts: [] as StoredCourt[],
        migrations: {} as Record<string, number>
      }
    })
  }

  public list(profileId: string): LocalCourt[] {
    if (!profileId) return []

    return this.store
      .get('courts')
      .filter((court) => court.profile_id === profileId)
      .sort((a, b) => a.name.localeCompare(b.name, 'es'))
      .map((court) => this.toLocalCourt(court))
  }

  public getById(courtId: string, profileId?: string): LocalCourt | null {
    if (!courtId) return null

    const court = this.store.get('courts').find(
      (candidate) =>
        candidate.id === courtId && (!profileId || candidate.profile_id === profileId)
    )

    return court ? this.toLocalCourt(court) : null
  }

  public create(
    name: string,
    profileId: string,
    isDvr = false,
    videoSource?: VideoSource
  ): LocalCourt {
    const normalizedName = this.normalizeName(name)
    this.assertProfileId(profileId)

    const now = new Date().toISOString()
    const id = randomUUID()
    const source = videoSource || { type: 'direct-camera', rtspKey: `RTSP_URL_${id}` }
    const court: StoredCourt = {
      id,
      name: normalizedName,
      created_at: now,
      updated_at: now,
      profile_id: profileId,
      is_dvr: source.type === 'recorder' || Boolean(isDvr),
      video_source: source
    }

    this.store.set('courts', [...this.store.get('courts'), court])
    return this.toLocalCourt(court)
  }

  public update(courtId: string, profileId: string, updates: LocalCourtUpdate): LocalCourt {
    this.assertProfileId(profileId)

    const courts = this.store.get('courts')
    const index = courts.findIndex(
      (candidate) => candidate.id === courtId && candidate.profile_id === profileId
    )

    if (index < 0) {
      throw new Error('La cancha local no existe o no pertenece al usuario actual.')
    }

    const current = courts[index]
    const updated: StoredCourt = {
      ...current,
      ...(updates.name === undefined ? {} : { name: this.normalizeName(updates.name) }),
      ...(updates.video_source === undefined ? {} : { video_source: updates.video_source }),
      ...(updates.is_dvr === undefined && updates.video_source === undefined
        ? {}
        : {
            is_dvr:
              updates.video_source?.type === 'recorder' ||
              (updates.video_source === undefined ? Boolean(updates.is_dvr) : false)
          }),
      updated_at: new Date().toISOString()
    }

    const nextCourts = [...courts]
    nextCourts[index] = updated
    this.store.set('courts', nextCourts)
    return this.toLocalCourt(updated)
  }

  public delete(courtId: string, profileId: string): boolean {
    this.assertProfileId(profileId)

    const courts = this.store.get('courts')
    const court = courts.find(
      (candidate) => candidate.id === courtId && candidate.profile_id === profileId
    )

    if (!court) return false

    this.store.set(
      'courts',
      courts.filter((candidate) => candidate.id !== courtId)
    )
    vaultService.deleteSecret(`RTSP_URL_${courtId}`)
    if (court.video_source?.type === 'recorder' && court.video_source.manualRtspKey) {
      vaultService.deleteSecret(court.video_source.manualRtspKey)
    }
    return true
  }

  public needsCloudMigration(profileId: string): boolean {
    this.assertProfileId(profileId)
    return this.getMigrationVersion(profileId) < LOCAL_COURT_STORAGE_VERSION
  }

  public getMigrationVersion(profileId: string): number {
    if (!profileId) return 0
    return this.store.get('migrations')?.[profileId] || 0
  }

  public migrateFromCloud(profileId: string, cloudCourts: CloudCourtRecord[]): {
    importedCount: number
    skippedCount: number
    storageVersion: number
  } {
    this.assertProfileId(profileId)

    if (!this.needsCloudMigration(profileId)) {
      return {
        importedCount: 0,
        skippedCount: 0,
        storageVersion: LOCAL_COURT_STORAGE_VERSION
      }
    }

    const courts = this.store.get('courts')
    const importedCourts: StoredCourt[] = []
    const rtspUrlsToStore: Array<{ courtId: string; url: string }> = []
    let skippedCount = 0

    for (const cloudCourt of cloudCourts) {
      if (!cloudCourt.id || !cloudCourt.name?.trim()) {
        skippedCount++
        continue
      }

      const existingCourt = courts.find((court) => court.id === cloudCourt.id)
      if (existingCourt) {
        if (existingCourt.profile_id !== profileId) {
          skippedCount++
        } else if (cloudCourt.rtsp_url_key && !vaultService.getSecret(`RTSP_URL_${cloudCourt.id}`)) {
          rtspUrlsToStore.push({ courtId: cloudCourt.id, url: cloudCourt.rtsp_url_key })
        }
        continue
      }

      const createdAt = cloudCourt.created_at || new Date().toISOString()
      importedCourts.push({
        id: cloudCourt.id,
        name: this.normalizeName(cloudCourt.name),
        created_at: createdAt,
        updated_at: new Date().toISOString(),
        profile_id: profileId,
        is_dvr: false,
        video_source: {
          type: 'direct-camera',
          rtspKey: `RTSP_URL_${cloudCourt.id}`
        }
      })

      if (cloudCourt.rtsp_url_key) {
        rtspUrlsToStore.push({ courtId: cloudCourt.id, url: cloudCourt.rtsp_url_key })
      }
    }

    for (const { courtId, url } of rtspUrlsToStore) {
      if (!vaultService.getSecret(`RTSP_URL_${courtId}`)) {
        vaultService.setSecret(`RTSP_URL_${courtId}`, url)
      }
    }

    this.store.set('courts', [...courts, ...importedCourts])
    this.store.set('migrations', {
      ...this.store.get('migrations'),
      [profileId]: LOCAL_COURT_STORAGE_VERSION
    })

    return {
      importedCount: importedCourts.length,
      skippedCount,
      storageVersion: LOCAL_COURT_STORAGE_VERSION
    }
  }

  private toLocalCourt(court: StoredCourt): LocalCourt {
    return {
      id: court.id,
      name: court.name,
      created_at: court.created_at,
      updated_at: court.updated_at || court.created_at,
      profile_id: court.profile_id,
      is_dvr: court.video_source?.type === 'recorder' || Boolean(court.is_dvr),
      video_source:
        court.video_source || {
          type: 'direct-camera',
          rtspKey: `RTSP_URL_${court.id}`
        }
    }
  }

  private normalizeName(name: string): string {
    const normalizedName = name.trim()
    if (!normalizedName) {
      throw new Error('El nombre de la cancha es obligatorio.')
    }
    return normalizedName
  }

  private assertProfileId(profileId: string): void {
    if (!profileId) {
      throw new Error('No hay un usuario autenticado para asociar la cancha.')
    }
  }
}

export const localCourtService = new LocalCourtService()
