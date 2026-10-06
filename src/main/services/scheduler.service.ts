import { app, BrowserWindow, Notification } from 'electron'
import icon from '../../../resources/icon.png?asset'
import path from 'path'
import fs from 'fs'
import { dbService } from './db.service'
import { ffmpegService, type RecordingCompletion } from './ffmpeg.service'
import { r2Service } from './r2.service'
import { vaultService } from './vault.service'
import { localCourtService } from './local-court.service'
import { videoSourceResolver } from './video-source-resolver.service'
import { mediaMtxService } from './media-mtx.service'

export interface Match {
  id: string
  court_id: string
  court_name?: string | null
  profile_id?: string | null
  start_time: string
  end_time: string
  status: 'SCHEDULED' | 'RECORDING' | 'UPLOADING' | 'DONE' | 'FAILED'
  video_key: string | null
  player_phone: string
  player_name: string
  error_log: string | null
}

class SchedulerService {
  private timer: NodeJS.Timeout | null = null
  private isProcessing = false
  private isSessionReady = false
  private readyProfileId: string | null = null
  private tempDir: string
  private lastCleanupTime: number = 0
  private onDemandStarts = new Map<string, Promise<{ match: Match; alreadyActive: boolean }>>()

  constructor() {
    this.tempDir = path.join(app.getPath('userData'), 'temp_recordings')
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true })
    }
  }

  /**
   * Start the scheduler background loop.
   */
  public start(): void {
    if (this.timer) return

    console.log('Starting Scheduler Service...')

    // Run recovery check once on startup
    this.recoverOrphanedMatches().catch((err) => {
      console.error('Error during startup recovery:', err)
    })

    // Run loop every 15 seconds for responsiveness
    this.timer = setInterval(() => {
      this.tick().catch((err) => {
        console.error('Error in scheduler tick:', err)
      })
    }, 15000)
  }

  /**
   * Stop the scheduler background loop.
   */
  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
      console.log('Scheduler Service stopped.')
    }
  }

  public sessionTokenUpdated(profileId: string | null): void {
    if (!profileId || this.readyProfileId !== profileId) {
      this.isSessionReady = false
      this.readyProfileId = profileId
    }
  }

  public sessionClosed(): void {
    this.isSessionReady = false
    this.readyProfileId = null
  }

  public sessionReady(): void {
    this.isSessionReady = true
    this.readyProfileId = dbService.getProfileId()
    this.recoverOrphanedMatches().catch((err) => {
      console.error('Error during session recovery:', err)
    })
    this.tick().catch((err) => {
      console.error('Error during session scheduler tick:', err)
    })
  }

  private matchContext(match: Match): string {
    const court = match.court_name || match.court_id || 'unknown court'
    const player = match.player_name || 'unknown match'
    return `match ${match.id} (${player}, court ${court})`
  }

  private getMatchWindow(
    match: Match
  ): { startTime: Date; endTime: Date; durationMs: number } | null {
    const startTime = new Date(match.start_time)
    const endTime = new Date(match.end_time)
    const durationMs = endTime.getTime() - startTime.getTime()

    if (!Number.isFinite(startTime.getTime()) || !Number.isFinite(endTime.getTime())) {
      return null
    }
    if (durationMs <= 0) return null

    return { startTime, endTime, durationMs }
  }

  private async markMatchFailed(match: Match, reason: string): Promise<void> {
    const message = `${this.matchContext(match)}: ${reason}`
    console.error(message)
    const { error } = await dbService
      .getClient()
      .from('matches')
      .update({ status: 'FAILED', error_log: message })
      .eq('id', match.id)

    if (error) console.error(`Could not mark ${this.matchContext(match)} as FAILED:`, error)
    this.notifyUI('match-updated', match.id)
  }

  /**
   * Main scheduler tick logic.
   */
  private async tick(): Promise<void> {
    if (this.isProcessing || !this.isSessionReady || !dbService.getProfileId()) return

    // Verify client configurations exist before making queries
    try {
      dbService.getClient()
    } catch {
      // Configuration not ready yet
      this.notifyUI('config-error', 'Credentials missing. Setup Supabase and R2 in config.')
      return
    }

    this.isProcessing = true

    try {
      const now = new Date()
      const profileId = dbService.getProfileId()
      if (!profileId) return

      const db = dbService.getClient()

      // 1. Fetch scheduled matches starting soon (e.g. within next 2 hours or already passed)
      // and not yet recorded or processed.
      const { data: matches, error } = await db
        .from('matches')
        .select('*')
        .eq('profile_id', profileId)
        .eq('status', 'SCHEDULED')
        .order('start_time', { ascending: true })

      if (error) throw error
      if (!matches || matches.length === 0) {
        this.isProcessing = false
        return
      }

      for (const match of matches as Match[]) {
        const window = this.getMatchWindow(match)
        if (!window) {
          await this.markMatchFailed(
            match,
            `invalid recording window: start_time and end_time must be valid and end_time must be after start_time (received start=${match.start_time}, end=${match.end_time})`
          )
          continue
        }

        const { startTime, endTime } = window
        // Check if current time is within recording window. The duration passed to
        // FFmpeg is derived from this same validated window; it is never guessed.
        const isTimeForRecording = now >= new Date(startTime.getTime() - 60000) && now < endTime

        if (isTimeForRecording && !ffmpegService.isRecording(match.id)) {
          await this.processRecordingStart(match, now, endTime)
        } else if (now >= endTime && !ffmpegService.isRecording(match.id)) {
          await this.markMatchFailed(match, 'recording window expired without recording starting')
        }
      }

      // 2. Perform periodic cleanup of old videos (once every 6 hours)
      if (now.getTime() - this.lastCleanupTime > 6 * 60 * 60 * 1000) {
        this.lastCleanupTime = now.getTime()
        const retentionDaysStr = vaultService.getSecret('VIDEO_RETENTION_DAYS') || '30'
        const retentionDays = parseInt(retentionDaysStr, 10)

        if (retentionDays > 0) {
          r2Service.deleteOldVideos(retentionDays).catch((err) => {
            console.error('Error during auto-cleanup of old videos:', err)
          })
        }
      }
    } catch (err) {
      console.error('Error during scheduler tick:', err)
    } finally {
      this.isProcessing = false
    }
  }

  public async startRecordingOnDemand(
    courtId: string,
    profileId: string
  ): Promise<{ match: Match; alreadyActive: boolean }> {
    const lockKey = `${profileId}:${courtId}`
    const pending = this.onDemandStarts.get(lockKey)
    if (pending) return pending

    const operation = this.createAndStartOnDemandRecording(courtId, profileId)
    this.onDemandStarts.set(lockKey, operation)
    try {
      return await operation
    } finally {
      if (this.onDemandStarts.get(lockKey) === operation) this.onDemandStarts.delete(lockKey)
    }
  }

  private async createAndStartOnDemandRecording(
    courtId: string,
    profileId: string
  ): Promise<{ match: Match; alreadyActive: boolean }> {
    const court = localCourtService.getById(courtId, profileId)
    if (!court) throw new Error('La cancha seleccionada no existe en el almacenamiento local.')

    const db = dbService.getClient()
    const now = new Date()
    const endTime = new Date(now.getTime() + 90 * 60000)
    const { data: activeMatches, error: activeError } = await db
      .from('matches')
      .select('*')
      .eq('court_id', courtId)
      .eq('profile_id', profileId)
      .in('status', ['SCHEDULED', 'RECORDING', 'UPLOADING'])
      .order('start_time', { ascending: true })

    if (activeError) throw activeError

    const existingManual = (activeMatches || []).find(
      (match) => match.player_name === 'Grabación Manual'
    ) as Match | undefined
    if (existingManual) {
      if (existingManual.status === 'SCHEDULED') {
        const { data: claimedMatch, error } = await db
          .from('matches')
          .update({ status: 'RECORDING', error_log: null })
          .eq('id', existingManual.id)
          .eq('status', 'SCHEDULED')
          .select()
          .maybeSingle()
        if (error) throw error
        if (!claimedMatch) {
          const { data: currentMatch, error: currentError } = await db
            .from('matches')
            .select('*')
            .eq('id', existingManual.id)
            .maybeSingle()
          if (currentError) throw currentError
          if (currentMatch) return { match: currentMatch as Match, alreadyActive: true }
          throw new Error('La grabación manual dejó de estar disponible.')
        }
        const startedMatch = claimedMatch as Match
        await this.processRecordingStart(startedMatch, now, endTime, true)
        return { match: startedMatch, alreadyActive: true }
      }
      return { match: existingManual, alreadyActive: true }
    }

    if (activeMatches && activeMatches.length > 0) {
      throw new Error('La cancha ya tiene un partido programado o una grabación activa.')
    }

    const { data, error } = await db
      .from('matches')
      .insert({
        court_id: court.id,
        court_name: court.name,
        start_time: now.toISOString(),
        end_time: endTime.toISOString(),
        player_name: 'Grabación Manual',
        player_phone: '+5490000000000',
        status: 'RECORDING',
        profile_id: profileId
      })
      .select()
      .single()

    if (error || !data) throw error || new Error('No se pudo crear la grabación manual.')
    const match = data as Match
    await this.processRecordingStart(match, now, endTime, true)
    return { match, alreadyActive: false }
  }

  /**
   * Handle starting a recording session.
   */
  private async processRecordingStart(
    match: Match,
    now: Date,
    endTime: Date,
    statusAlreadySet = false
  ): Promise<void> {
    const db = dbService.getClient()
    const profileId = match.profile_id || dbService.getProfileId()
    const matchWindow = this.getMatchWindow(match)
    const nowMs = now.getTime()
    const endTimeMs = endTime.getTime()

    if (
      !matchWindow ||
      !Number.isFinite(nowMs) ||
      !Number.isFinite(endTimeMs) ||
      endTimeMs <= nowMs
    ) {
      await this.markMatchFailed(
        match,
        `invalid recording timing: start=${match.start_time}, end=${match.end_time}, now=${now.toISOString()}`
      )
      return
    }

    const durationSeconds = Math.floor((endTimeMs - nowMs) / 1000)
    if (!Number.isFinite(durationSeconds) || durationSeconds < 1) {
      await this.markMatchFailed(
        match,
        `invalid remaining recording duration: ${durationSeconds}s (start=${match.start_time}, end=${match.end_time})`
      )
      return
    }

    // Resolve the local video source. The scheduler does not know recorder vendors or RTSP paths.
    const court = profileId ? localCourtService.getById(match.court_id, profileId) : null
    if (!court || !profileId) {
      await this.markMatchFailed(match, 'local court configuration is missing')
      return
    }

    let rtspUrl: string
    let releaseVideoSource: (() => Promise<void>) | undefined
    try {
      if (court.video_source.type === 'recorder') {
        const mediaSource = await mediaMtxService.startPreview(
          court.video_source,
          profileId,
          'main'
        )
        rtspUrl = mediaSource.localRtspUrl
        let released = false
        releaseVideoSource = async () => {
          if (released) return
          released = true
          await mediaMtxService.stopPreview(mediaSource)
        }
      } else {
        const resolvedSource = await videoSourceResolver.resolveVideoSource(
          court.id,
          profileId,
          'recording'
        )
        rtspUrl = resolvedSource.recordingUrl
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      await this.markMatchFailed(match, `video source resolution failed: ${detail}`)
      return
    }

    const outputFilePath = path.join(this.tempDir, `${match.id}.mp4`)
    const recordingStartedAt = Date.now()

    console.log(`Starting ${this.matchContext(match)}. Duration: ${durationSeconds}s`)

    try {
      // 2. Set status to RECORDING in Supabase unless an on-demand start already did it.
      if (!statusAlreadySet) {
        const { error: updateErr } = await db
          .from('matches')
          .update({ status: 'RECORDING' })
          .eq('id', match.id)

        if (updateErr) throw updateErr
      }
      this.notifyUI('match-updated', match.id)
      this.showNotification(
        'Grabación Iniciada',
        `Se ha iniciado la grabación para ${match.player_name} en la cancha ${court.name}.`
      )

      // 3. Trigger FFmpeg recording
      ffmpegService.startRecording({
        matchId: match.id,
        rtspUrl,
        durationSeconds,
        outputFilePath,
        includeAudio: court.video_source.type === 'direct-camera',
        onProgress: (prog) => {
          this.notifyUI('recording-progress', {
            matchId: prog.matchId,
            elapsedSeconds: prog.elapsedSeconds,
            durationSeconds
          })
        },
        onComplete: async (savedPath, completion: RecordingCompletion) => {
          // A manually requested stop is an intentional partial recording and
          // must continue through the upload flow. An early completion without
          // that explicit marker is still treated as a failed recording.
          const elapsedSeconds = Math.floor((Date.now() - recordingStartedAt) / 1000)
          if (elapsedSeconds < durationSeconds && !completion.manualStop) {
            await releaseVideoSource?.()
            await this.markMatchFailed(
              match,
              `recording ended early after ${elapsedSeconds}s; expected ${durationSeconds}s. The local file cannot be treated as complete.`
            )
            return
          }

          console.log(
            `Recording ${completion.manualStop ? 'manually stopped' : 'complete'} for ${this.matchContext(match)}. Local file: ${savedPath}`
          )
          await releaseVideoSource?.()
          this.showNotification(
            completion.manualStop ? 'Grabación Parcial Lista' : 'Grabación Finalizada',
            completion.manualStop
              ? `La grabación parcial de ${match.player_name} se está subiendo.`
              : `La grabación para ${match.player_name} finalizó. Procesando subida...`
          )
          await this.processUploadStart(match, savedPath)
        },
        onError: async (err) => {
          const detail = err instanceof Error ? err.message : String(err)
          console.error(`Recording error for ${this.matchContext(match)}:`, detail)
          await releaseVideoSource?.()
          this.showNotification(
            'Error de Grabación',
            `Ocurrió un error al grabar el partido de ${match.player_name}.`
          )
          await this.markMatchFailed(match, `recording failed: ${detail}`)
        }
      })
    } catch (err) {
      await releaseVideoSource?.()
      const detail = err instanceof Error ? err.message : String(err)
      await this.markMatchFailed(match, `failed to initialize recording: ${detail}`)
    }
  }

  /**
   * Handle uploading a completed video.
   */
  private async processUploadStart(match: Match, filePath: string): Promise<void> {
    const db = dbService.getClient()

    try {
      const window = this.getMatchWindow(match)
      if (!window) {
        throw new Error(
          `invalid recording window (start=${match.start_time}, end=${match.end_time})`
        )
      }
      if (!fs.existsSync(filePath) || fs.statSync(filePath).size <= 0) {
        throw new Error('local video file is missing or empty')
      }

      // 1. Update status to UPLOADING in Supabase
      await db.from('matches').update({ status: 'UPLOADING' }).eq('id', match.id)
      this.notifyUI('match-updated', match.id)

      // Define destination key (e.g. 'videos/cancha_1/2026-07-10_matchId.mp4')
      const dateStr = new Date(match.start_time).toISOString().split('T')[0]
      const destinationKey = `videos/court_${match.court_id}/${dateStr}_${match.id}.mp4`

      // 2. Perform R2 Multipart upload
      await r2Service.uploadVideo({
        matchId: match.id,
        localFilePath: filePath,
        destinationKey,
        onProgress: (prog) => {
          this.notifyUI('upload-progress', {
            matchId: prog.matchId,
            percentage: prog.percentage
          })
        }
      })

      // 3. Update status to DONE and set the video_key
      await db
        .from('matches')
        .update({
          status: 'DONE',
          video_key: destinationKey,
          error_log: null
        })
        .eq('id', match.id)
      this.notifyUI('match-updated', match.id)
      this.showNotification(
        'Video Listo',
        `El partido de ${match.player_name} se subió con éxito a la nube.`
      )

      // 4. Delete the local temp video file
      fs.unlink(filePath, (err) => {
        if (err) console.error(`Error deleting temp file ${filePath}:`, err)
        else console.log(`Deleted local temp file: ${filePath}`)
      })
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      const message = `${this.matchContext(match)}: upload failed: ${detail}`
      console.error(message)
      this.showNotification(
        'Error de Subida',
        `No se pudo subir el video de ${match.player_name} a la nube.`
      )
      await db
        .from('matches')
        .update({
          status: 'FAILED',
          error_log: message
        })
        .eq('id', match.id)
      this.notifyUI('match-updated', match.id)
    }
  }

  /**
   * Recover matches interrupted by crashes or power cuts (Robustness).
   */
  private async recoverOrphanedMatches(): Promise<void> {
    try {
      dbService.getClient()
    } catch {
      return // Config not set up
    }

    const profileId = dbService.getProfileId()
    if (!profileId) return

    const db = dbService.getClient()
    console.log('Checking for orphaned or interrupted recordings...')

    // Find any matches in 'RECORDING' or 'UPLOADING' state for the active profile.
    const { data: matches, error } = await db
      .from('matches')
      .select('*')
      .eq('profile_id', profileId)
      .in('status', ['RECORDING', 'UPLOADING'])

    if (error) throw error
    if (!matches || matches.length === 0) {
      console.log('No orphaned matches found.')
      return
    }

    for (const match of matches as Match[]) {
      const filePath = path.join(this.tempDir, `${match.id}.mp4`)
      const hasLocalFile = fs.existsSync(filePath)
      let fileSize = 0

      if (hasLocalFile) {
        try {
          fileSize = fs.statSync(filePath).size
        } catch (error) {
          console.error(`Could not inspect local file for ${this.matchContext(match)}:`, error)
        }
      }

      if (match.status === 'RECORDING') {
        if (!hasLocalFile) {
          await this.markMatchFailed(
            match,
            'recording was interrupted and the local file was not found'
          )
        } else if (fileSize <= 0) {
          await this.markMatchFailed(match, 'recording was interrupted and the local file is empty')
          fs.unlink(filePath, () => {})
        } else {
          // A sizeable file only proves that bytes were written. Without a media
          // duration probe, uploading it would present an unverified partial as DONE.
          await this.markMatchFailed(
            match,
            `recording was interrupted; local file (${fileSize} bytes) exists but its duration cannot be validated`
          )
        }
      } else if (match.status === 'UPLOADING') {
        // UPLOADING may contain a valid file, but this file cannot be proven to
        // cover the scheduled window with the APIs available here. Do not retry
        // the upload because a successful retry would turn an unverified partial
        // into DONE; leave the file for manual inspection/recovery.
        if (!hasLocalFile) {
          await this.markMatchFailed(
            match,
            'upload was interrupted and the local video file was deleted'
          )
        } else {
          await this.markMatchFailed(
            match,
            `upload was interrupted; local file (${fileSize} bytes) exists but its duration cannot be validated`
          )
        }
      }
    }
  }

  /**
   * Helper to send real-time events to React renderer over IPC.
   */
  private notifyUI(channel: string, payload: any): void {
    BrowserWindow.getAllWindows().forEach((win) => {
      if (!win.isDestroyed()) {
        win.webContents.send(channel, payload)
      }
    })
  }

  /**
   * Helper to show native system notifications at the OS/Windows level.
   */
  private showNotification(title: string, body: string): void {
    const notificationsEnabled = vaultService.getSecret('NOTIFICATIONS_ENABLED') !== 'false'
    if (notificationsEnabled && Notification.isSupported()) {
      new Notification({
        title,
        body,
        icon: icon,
        silent: false
      }).show()
    }
  }
}

export const schedulerService = new SchedulerService()
