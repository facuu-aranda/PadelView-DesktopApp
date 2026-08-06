import { app, BrowserWindow, Notification } from 'electron'
import icon from '../../../resources/icon.png?asset'
import path from 'path'
import fs from 'fs'
import { dbService } from './db.service'
import { ffmpegService } from './ffmpeg.service'
import { r2Service } from './r2.service'
import { vaultService } from './vault.service'

export interface Match {
  id: string
  court_id: string
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
  private tempDir: string
  private lastCleanupTime: number = 0

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

  /**
   * Main scheduler tick logic.
   */
  private async tick(): Promise<void> {
    if (this.isProcessing) return

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
      const db = dbService.getClient()

      // 1. Fetch scheduled matches starting soon (e.g. within next 2 hours or already passed)
      // and not yet recorded or processed.
      const { data: matches, error } = await db
        .from('matches')
        .select('*')
        .eq('status', 'SCHEDULED')
        .order('start_time', { ascending: true })

      if (error) throw error
      if (!matches || matches.length === 0) {
        this.isProcessing = false
        return
      }

      for (const match of matches as Match[]) {
        const startTime = new Date(match.start_time)
        const endTime = new Date(match.end_time)

        // Check if current time is within recording window
        // We start if we are within 1 minute of start_time or if the match has already started (and not ended)
        const isTimeForRecording = now >= new Date(startTime.getTime() - 60000) && now < endTime

        if (isTimeForRecording && !ffmpegService.isRecording(match.id)) {
          await this.processRecordingStart(match, now, endTime)
        } else if (now >= endTime && !ffmpegService.isRecording(match.id)) {
          // If the match end time is passed and it was never recorded
          console.warn(
            `Match ${match.id} end time passed but was never recorded. Marking as FAILED.`
          )
          await db
            .from('matches')
            .update({
              status: 'FAILED',
              error_log: 'Match time window expired without recording starting.'
            })
            .eq('id', match.id)
          this.notifyUI('match-updated', match.id)
        }
      }

      // 2. Perform periodic cleanup of old videos (once every 6 hours)
      if (now.getTime() - this.lastCleanupTime > 6 * 60 * 60 * 1000) {
        this.lastCleanupTime = now.getTime()
        const retentionDaysStr = vaultService.getSecret('VIDEO_RETENTION_DAYS') || '30'
        const retentionDays = parseInt(retentionDaysStr, 10)
        
        if (retentionDays > 0) {
          r2Service.deleteOldVideos(retentionDays).catch(err => {
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

  /**
   * Handle starting a recording session.
   */
  private async processRecordingStart(match: Match, now: Date, endTime: Date): Promise<void> {
    const db = dbService.getClient()

    // 1. Retrieve court configuration for RTSP URL
    const { data: court, error: courtErr } = await db
      .from('courts')
      .select('*')
      .eq('id', match.court_id)
      .single()

    if (courtErr || !court) {
      console.error(`Court configuration not found for match ${match.id}:`, courtErr)
      await db
        .from('matches')
        .update({ status: 'FAILED', error_log: `Court config missing: ${courtErr?.message}` })
        .eq('id', match.id)
      return
    }

    // Resolve RTSP URL from vault or default to config
    let rtspUrl = vaultService.getSecret(`RTSP_URL_${court.id}`) || court.rtsp_url_key
    if (!rtspUrl) {
      console.error(`RTSP URL not found for court ${court.id}`)
      await db
        .from('matches')
        .update({ status: 'FAILED', error_log: `RTSP Stream URL is not configured.` })
        .eq('id', match.id)
      return
    }

    // Calculate remaining duration in seconds
    const durationSeconds = Math.max(Math.floor((endTime.getTime() - now.getTime()) / 1000), 10)
    const outputFilePath = path.join(this.tempDir, `${match.id}.mp4`)

    console.log(`Starting recording for match ${match.id}. Duration: ${durationSeconds}s`)

    try {
      // 2. Set status to RECORDING in Supabase
      const { error: updateErr } = await db
        .from('matches')
        .update({ status: 'RECORDING' })
        .eq('id', match.id)

      if (updateErr) throw updateErr
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
        onProgress: (prog) => {
          this.notifyUI('recording-progress', {
            matchId: prog.matchId,
            elapsedSeconds: prog.elapsedSeconds,
            durationSeconds
          })
        },
        onComplete: async (savedPath) => {
          console.log(`Recording complete for match ${match.id}. Local file: ${savedPath}`)
          this.showNotification(
            'Grabación Finalizada',
            `La grabación para ${match.player_name} finalizó. Procesando subida...`
          )
          await this.processUploadStart(match, savedPath)
        },
        onError: async (err) => {
          console.error(`Recording error for match ${match.id}:`, err)
          this.showNotification(
            'Error de Grabación',
            `Ocurrió un error al grabar el partido de ${match.player_name}.`
          )
          await db
            .from('matches')
            .update({ status: 'FAILED', error_log: err.message })
            .eq('id', match.id)
          this.notifyUI('match-updated', match.id)
        }
      })
    } catch (err) {
      console.error(`Failed to initialize recording for match ${match.id}:`, err)
      await db
        .from('matches')
        .update({ status: 'FAILED', error_log: (err as Error).message })
        .eq('id', match.id)
      this.notifyUI('match-updated', match.id)
    }
  }

  /**
   * Handle uploading a completed video.
   */
  private async processUploadStart(match: Match, filePath: string): Promise<void> {
    const db = dbService.getClient()

    try {
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
      console.error(`Failed uploading match video ${match.id}:`, err)
      this.showNotification(
        'Error de Subida',
        `No se pudo subir el video de ${match.player_name} a la nube.`
      )
      await db
        .from('matches')
        .update({
          status: 'FAILED',
          error_log: `Upload failed: ${(err as Error).message}`
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

    const db = dbService.getClient()
    console.log('Checking for orphaned or interrupted recordings...')

    // Find any matches in 'RECORDING' or 'UPLOADING' state
    const { data: matches, error } = await db
      .from('matches')
      .select('*')
      .in('status', ['RECORDING', 'UPLOADING'])

    if (error) throw error
    if (!matches || matches.length === 0) {
      console.log('No orphaned matches found.')
      return
    }

    for (const match of matches as Match[]) {
      const filePath = path.join(this.tempDir, `${match.id}.mp4`)

      if (match.status === 'RECORDING') {
        // If it was recording, checking if the file is valid to save it as partial
        if (fs.existsSync(filePath)) {
          const stats = fs.statSync(filePath)
          if (stats.size > 1024 * 1024) {
            // > 1MB partial video
            console.log(
              `Recovered partial recording file for match ${match.id}. Queuing for upload.`
            )
            // Queue for upload
            this.processUploadStart(match, filePath).catch((err) => {
              console.error(`Error recovering upload for match ${match.id}:`, err)
            })
          } else {
            console.log(
              `Found empty or corrupt recording file for match ${match.id}. Marking as FAILED.`
            )
            await db
              .from('matches')
              .update({
                status: 'FAILED',
                error_log: 'Recording interrupted (power outage or crash) and file is empty.'
              })
              .eq('id', match.id)
            // Cleanup empty file
            fs.unlink(filePath, () => {})
          }
        } else {
          console.log(
            `No recording file found for interrupted match ${match.id}. Marking as FAILED.`
          )
          await db
            .from('matches')
            .update({ status: 'FAILED', error_log: 'Recording interrupted and file not found.' })
            .eq('id', match.id)
        }
      } else if (match.status === 'UPLOADING') {
        // If it was uploading, check if local file is still there and retry
        if (fs.existsSync(filePath)) {
          console.log(`Resuming interrupted upload for match ${match.id}...`)
          this.processUploadStart(match, filePath).catch((err) => {
            console.error(`Error resuming upload for match ${match.id}:`, err)
          })
        } else {
          console.log(`Local file for upload ${match.id} was lost. Marking as FAILED.`)
          await db
            .from('matches')
            .update({
              status: 'FAILED',
              error_log: 'Upload interrupted and local video file was deleted.'
            })
            .eq('id', match.id)
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
