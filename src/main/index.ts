import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { randomUUID } from 'crypto'
import { join, resolve } from 'path'
import fs from 'fs'
import { spawn, ChildProcess } from 'child_process'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { autoUpdater } from 'electron-updater'
import icon from '../../resources/icon.png?asset'
import log from 'electron-log/main'

log.initialize()
Object.assign(console, log.functions)

// Custom protocol registration for OAuth
if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient('viewpadel', process.execPath, [resolve(process.argv[1])])
  }
} else {
  app.setAsDefaultProtocolClient('viewpadel')
}

const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  app.quit()
  process.exit(0)
}

// Services imports
import { vaultService } from './services/vault.service'
import { dbService } from './services/db.service'
import { ffmpegService } from './services/ffmpeg.service'
import { r2Service } from './services/r2.service'
import { schedulerService } from './services/scheduler.service'
import { discoveryService } from './services/discovery.service'
import { localCourtService } from './services/local-court.service'
import { recorderService } from './services/recorder/recorder.service'
import { videoSourceResolver } from './services/video-source-resolver.service'
import { mediaMtxService } from './services/media-mtx.service'
import type {
  RecorderChannel,
  RecorderSource,
  VideoSource
} from '../shared/video-source'

function createWindow(): void {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 1024,
    height: 768,
    show: false,
    autoHideMenuBar: true,
    title: 'ViewPadel',
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      webSecurity: false // Disabled to allow HTML5 video player to load R2 streams without CORS restrictions
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  // Redirect renderer logs to main console for diagnostics
  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    // Keep it clean: extract only the filename from the sourceId URL
    const file = sourceId ? sourceId.split('/').pop() : 'unknown'
    console.log(`[Renderer] [Lvl ${level}] ${message} (${file}:${line})`)
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// Register IPC handlers for renderer communication
function registerIpcHandlers(): void {
  // Auth external open
  ipcMain.handle('auth:open-url', (_, url: string) => {
    shell.openExternal(url)
    return { success: true }
  })

  // Set Auth Token and active profile for DB and scheduler services
  ipcMain.handle(
    'session:set-token',
    (_, token: string | null, profileId?: string | null) => {
      dbService.setAccessToken(token, profileId)
      if (token === null) {
        schedulerService.sessionClosed()
      } else {
        schedulerService.sessionTokenUpdated(profileId ?? dbService.getProfileId())
      }
      return { success: true }
    }
  )

  ipcMain.handle('session:ready', () => {
    schedulerService.sessionReady()
    return { success: true }
  })

  // 1. Config management
  ipcMain.handle('config:get', () => {
    return {
      SUPABASE_URL: vaultService.getSecret('SUPABASE_URL') || '',
      SUPABASE_SERVICE_ROLE_KEY: vaultService.getSecret('SUPABASE_SERVICE_ROLE_KEY') || '',
      SUPABASE_KEY: vaultService.getSecret('SUPABASE_KEY') || '',
      R2_ACCESS_KEY_ID: vaultService.getSecret('R2_ACCESS_KEY_ID') || '',
      R2_SECRET_ACCESS_KEY: vaultService.getSecret('R2_SECRET_ACCESS_KEY') || '',
      R2_ENDPOINT: vaultService.getSecret('R2_ENDPOINT') || '',
      R2_BUCKET_NAME: vaultService.getSecret('R2_BUCKET_NAME') || 'padelview-matches'
    }
  })

  ipcMain.handle('config:save', (_, config: Record<string, string>) => {
    try {
      for (const [key, value] of Object.entries(config)) {
        vaultService.setSecret(key, value)
      }
      // Reset db service client so it re-initializes with the new credentials next time it's used
      dbService.resetClient()
      return { success: true }
    } catch (error) {
      console.error('Failed to save config:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  // Window title update
  ipcMain.on('window:set-title', (event, title: string) => {
    const webContents = event.sender
    const win = BrowserWindow.fromWebContents(webContents)
    if (win) {
      win.setTitle(title)
    }
  })

  // Court-specific RTSP URLs are stored only in the local vault.
  ipcMain.handle('config:get-rtsp', (_, courtId: string, profileId: string) => {
    if (!localCourtService.getById(courtId, profileId)) return ''
    return vaultService.getSecret(`RTSP_URL_${courtId}`) || ''
  })

  ipcMain.handle(
    'config:save-rtsp',
    (_, courtId: string, url: string, profileId: string) => {
      try {
        if (!localCourtService.getById(courtId, profileId)) {
          throw new Error('La cancha local no existe o no pertenece al usuario actual.')
        }
        vaultService.setSecret(`RTSP_URL_${courtId}`, url.trim())
        return { success: true }
      } catch (error) {
        return { success: false, error: (error as Error).message }
      }
    }
  )

  // Get signed video URL from R2
  ipcMain.handle('config:get-signed-url', async (_, key: string, forDownload?: boolean) => {
    try {
      const url = await r2Service.getSignedVideoUrl(key, 3600, forDownload)
      return { success: true, url }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })

  // List all videos directly from R2
  ipcMain.handle('r2:list-videos', async () => {
    try {
      const videos = await r2Service.listAllVideos()
      return { success: true, videos }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })

  // Delete video directly from R2 (and try DB just in case)
  ipcMain.handle('r2:delete-video', async (_, key: string) => {
    try {
      await r2Service.deleteVideo(key)
      // Attempt to clean up DB record if it exists (no error if it doesn't)
      try {
        const db = dbService.getClient()
        await db.from('matches').delete().eq('video_key', key)
      } catch (e) { /* ignore */ }
      return { success: true }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })

  // Get bucket usage
  ipcMain.handle('config:get-bucket-usage', async () => {
    try {
      const r2UsageBytes = await r2Service.getBucketUsage()
      
      // Calculate local recordings folder size
      let localUsageBytes = 0
      try {
        const localRecordingsPath = join(app.getPath('userData'), 'temp_recordings')
        if (fs.existsSync(localRecordingsPath)) {
          const files = fs.readdirSync(localRecordingsPath)
          for (const file of files) {
            const stats = fs.statSync(join(localRecordingsPath, file))
            localUsageBytes += stats.size
          }
        }
      } catch (err) {
        console.error('Error calculating local usage:', err)
      }

      return { success: true, usageBytes: r2UsageBytes + localUsageBytes }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })

  // 2. FFmpeg check
  ipcMain.handle('ffmpeg:check', () => {
    const ffmpegPath = ffmpegService.getFFmpegPath()
    const exists = fs.existsSync(ffmpegPath)
    return {
      path: ffmpegPath,
      exists: exists
    }
  })

  // 3. Idempotent manual recording start
  ipcMain.handle(
    'recordings:start',
    async (_, input: { courtId: string; profileId: string }) => {
      try {
        return {
          success: true,
          ...(await schedulerService.startRecordingOnDemand(input.courtId, input.profileId))
        }
      } catch (error) {
        console.error('recordings:start error:', error)
        return { success: false, error: (error as Error).message }
      }
    }
  )

  // 4. Manual action to terminate a recording and persist its real end time
  ipcMain.handle(
    'recordings:kill',
    async (_, input: { matchId: string; profileId: string }) => {
      const success = ffmpegService.killRecording(input.matchId)
      if (!success) return { success: false }

      try {
        const { error } = await dbService
          .getClient()
          .from('matches')
          .update({ end_time: new Date().toISOString() })
          .eq('id', input.matchId)
          .eq('profile_id', input.profileId)

        if (error) throw error
        return { success: true }
      } catch (error) {
        console.error('recordings:kill end time update error:', error)
        return {
          success: false,
          error: 'La grabación se detuvo, pero no se pudo actualizar su horario final.'
        }
      }
    }
  )

  // 4. Manual action to terminate an upload
  ipcMain.handle('uploads:cancel', async (_, matchId: string) => {
    const success = await r2Service.cancelUpload(matchId)
    return { success }
  })

  // 5. Get current scheduler & active states
  ipcMain.handle('scheduler:state', () => {
    return {
      activeRecordingsCount: ffmpegService.getActiveCount()
    }
  })

  // 5b. Local network scan for cameras
  ipcMain.handle('network:scan-cameras', async (event) => {
    try {
      const foundIPs = await discoveryService.scanNetwork((percent, currentFound) => {
        event.sender.send('network:scan-progress', { percent, foundIPs: currentFound })
      })
      return { success: true, foundIPs }
    } catch (error) {
      console.error('network:scan-cameras error:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  // Recorder operations are independent from the direct-camera LAN scanner.
  ipcMain.handle('recorders:list', (_, profileId: string) => {
    try {
      return {
        success: true,
        data: recorderService.list(profileId).map((recorder) => ({
          ...recorder,
          hasCredentials: true
        }))
      }
    } catch (error) {
      console.error('recorders:list error:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle('recorders:create', (_, input: Parameters<typeof recorderService.create>[0]) => {
    try {
      return { success: true, data: recorderService.create(input) }
    } catch (error) {
      console.error('recorders:create error:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle(
    'recorders:update',
    (_, input: { recorderId: string; profileId: string } & Parameters<typeof recorderService.update>[2]) => {
      try {
        const { recorderId, profileId, ...updates } = input
        return { success: true, data: recorderService.update(recorderId, profileId, updates) }
      } catch (error) {
        console.error('recorders:update error:', error)
        return { success: false, error: (error as Error).message }
      }
    }
  )

  ipcMain.handle('recorders:delete', (_, input: { recorderId: string; profileId: string }) => {
    try {
      const linkedCourts = localCourtService
        .list(input.profileId)
        .filter(
          (court) =>
            court.video_source.type === 'recorder' &&
            court.video_source.recorderId === input.recorderId
        )
      if (linkedCourts.length > 0) {
        throw new Error(
          `Este DVR/NVR está siendo utilizado por ${linkedCourts.length} cancha(s). Reasigná sus fuentes antes de eliminarlo.`
        )
      }
      return recorderService.delete(input.recorderId, input.profileId)
        ? { success: true }
        : { success: false, error: 'El grabador no existe o ya fue eliminado.' }
    } catch (error) {
      console.error('recorders:delete error:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle(
    'recorders:discover',
    async (
      event,
      input: { recorderId: string; profileId: string; requestId?: string; maxChannels?: number; timeoutMs?: number }
    ) => {
      const requestId = input.requestId || randomUUID()
      const controller = new AbortController()
      activeRecorderOperations.set(requestId, controller)
      try {
        const result = await recorderService.discover(input.recorderId, input.profileId, {
          maxChannels: input.maxChannels,
          timeoutMs: input.timeoutMs,
          signal: controller.signal,
          onProgress: (progress) => {
            if (!event.sender.isDestroyed()) {
              event.sender.send('recorders:progress', { requestId, ...progress })
            }
          }
        })
        return { success: true, requestId, data: result }
      } catch (error) {
        return { success: false, requestId, error: (error as Error).message }
      } finally {
        if (activeRecorderOperations.get(requestId) === controller) {
          activeRecorderOperations.delete(requestId)
        }
      }
    }
  )

  ipcMain.handle('recorders:cancel', (_, requestId: string) => {
    const controller = activeRecorderOperations.get(requestId)
    if (!controller) return { success: false, error: 'La búsqueda ya finalizó.' }
    controller.abort()
    return { success: true }
  })

  ipcMain.handle(
    'recorders:list-channels',
    async (_, input: { recorderId: string; profileId: string; maxChannels?: number }) => {
      try {
        const data = await recorderService.listChannels(input.recorderId, input.profileId, {
          maxChannels: input.maxChannels
        })
        return { success: true, data }
      } catch (error) {
        return { success: false, error: (error as Error).message }
      }
    }
  )

  ipcMain.handle(
    'recorders:get-snapshot',
    async (_, input: { recorderId: string; profileId: string; channel: RecorderChannel }) => {
      try {
        const snapshot = await recorderService.getSnapshot(
          input.recorderId,
          input.profileId,
          input.channel
        )
        return snapshot
          ? {
              success: true,
              contentType: snapshot.contentType,
              data: Buffer.from(snapshot.data).toString('base64')
            }
          : { success: false, error: 'Vista previa no disponible.' }
      } catch (error) {
        return { success: false, error: (error as Error).message }
      }
    }
  )

  ipcMain.handle(
    'recorders:test-channel',
    async (_, input: { recorderId: string; profileId: string; channel: RecorderChannel; stream?: 'main' | 'sub' }) => {
      try {
        const valid = await recorderService.testChannel(
          input.recorderId,
          input.profileId,
          input.channel,
          input.stream || 'main'
        )
        return valid
          ? { success: true }
          : { success: false, error: 'El stream no entregó una pista de video válida.' }
      } catch (error) {
        return { success: false, error: (error as Error).message }
      }
    }
  )

  ipcMain.handle(
    'recorders:save-manual-source',
    (_, input: { recorderId: string; profileId: string; url: string }) => {
      try {
        recorderService.get(input.recorderId, input.profileId)
        const parsed = new URL(input.url.trim())
        if (parsed.protocol !== 'rtsp:') throw new Error('La URL manual debe usar el protocolo RTSP.')
        const channelId = `manual:${randomUUID()}`
        const manualRtspKey = `RECORDER_${input.recorderId}_MANUAL_${channelId.replace(':', '_')}`
        vaultService.setSecret(manualRtspKey, input.url.trim())
        const source: RecorderSource = {
          type: 'recorder',
          recorderId: input.recorderId,
          channelId,
          stream: 'main',
          manualRtspKey
        }
        return { success: true, source }
      } catch (error) {
        return { success: false, error: (error as Error).message }
      }
    }
  )

  // 6. Local court operations. These handlers never use the Supabase courts table.
  ipcMain.handle('courts:list', (_, profileId: string) => {
    try {
      return { success: true, data: localCourtService.list(profileId) }
    } catch (error) {
      console.error('courts:list error:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle('courts:get', (_, courtId: string, profileId: string) => {
    try {
      return { success: true, data: localCourtService.getById(courtId, profileId) }
    } catch (error) {
      console.error('courts:get error:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle(
    'courts:create',
    (_, input: { name: string; rtspUrl?: string; profileId: string; isDvr?: boolean; videoSource?: VideoSource }) => {
      let court: ReturnType<typeof localCourtService.create> | null = null
      try {
        court = localCourtService.create(
          input.name,
          input.profileId,
          input.isDvr,
          input.videoSource
        )
        if (input.rtspUrl?.trim() && court.video_source.type === 'direct-camera') {
          vaultService.setSecret(court.video_source.rtspKey, input.rtspUrl.trim())
        }
        return { success: true, data: court }
      } catch (error) {
        if (court) localCourtService.delete(court.id, input.profileId)
        console.error('courts:create error:', error)
        return { success: false, error: (error as Error).message }
      }
    }
  )

  ipcMain.handle(
    'courts:update',
    (
      _,
      input: {
        courtId: string
        profileId: string
        name?: string
        rtspUrl?: string
        isDvr?: boolean
        videoSource?: VideoSource
      }
    ) => {
      try {
        const currentCourt = localCourtService.getById(input.courtId, input.profileId)
        if (!currentCourt) {
          throw new Error('La cancha local no existe o no pertenece al usuario actual.')
        }
        const source =
          input.videoSource ||
          (input.rtspUrl !== undefined
            ? { type: 'direct-camera' as const, rtspKey: `RTSP_URL_${input.courtId}` }
            : currentCourt.video_source)
        const court = localCourtService.update(input.courtId, input.profileId, {
          name: input.name,
          is_dvr: input.isDvr,
          video_source: source
        })
        if (input.rtspUrl !== undefined && source.type === 'direct-camera') {
          vaultService.setSecret(source.rtspKey, input.rtspUrl.trim())
        }
        return { success: true, data: court }
      } catch (error) {
        console.error('courts:update error:', error)
        return { success: false, error: (error as Error).message }
      }
    }
  )

  ipcMain.handle(
    'courts:delete',
    async (_, input: { courtId: string; profileId: string }) => {
      try {
        if (!localCourtService.getById(input.courtId, input.profileId)) {
          throw new Error('La cancha local no existe o no pertenece al usuario actual.')
        }

        const db = dbService.getClient()
        const { data: activeMatches, error } = await db
          .from('matches')
          .select('id, status')
          .eq('court_id', input.courtId)
          .in('status', ['SCHEDULED', 'RECORDING'])

        if (error) throw error
        if (activeMatches && activeMatches.length > 0) {
          const hasRecording = activeMatches.some((match) => match.status === 'RECORDING')
          throw new Error(
            hasRecording
              ? 'No se puede eliminar una cancha mientras tiene una grabación activa.'
              : 'No se puede eliminar una cancha con partidos programados. Cancela o reasigna esos partidos primero.'
          )
        }

        const deleted = localCourtService.delete(input.courtId, input.profileId)
        return deleted
          ? { success: true }
          : { success: false, error: 'La cancha local no existe o ya fue eliminada.' }
      } catch (error) {
        console.error('courts:delete error:', error)
        return { success: false, error: (error as Error).message }
      }
    }
  )

  // Read the cloud courts table only once per profile to migrate legacy installations.
  ipcMain.handle('courts:migrate', async (_, profileId: string) => {
    try {
      if (!localCourtService.needsCloudMigration(profileId)) {
        return { success: true, migrated: false, data: localCourtService.list(profileId) }
      }

      const db = dbService.getClient()
      const { data, error } = await db
        .from('courts')
        .select('id, name, created_at, rtsp_url_key')
        .eq('profile_id', profileId)
        .order('name', { ascending: true })

      if (error) throw error

      const migration = localCourtService.migrateFromCloud(profileId, data || [])
      return {
        success: true,
        migrated: true,
        ...migration,
        data: localCourtService.list(profileId)
      }
    } catch (error) {
      console.error('courts:migrate error:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle('db:get-matches', async (_, profileId: string) => {
    try {
      const db = dbService.getClient()
      // Fetch matches within the retention window (default 30 days)
      // This ensures videos are visible in the library until they are auto-deleted.
      const retentionDaysStr = vaultService.getSecret('VIDEO_RETENTION_DAYS') || '30'
      const retentionDays = parseInt(retentionDaysStr, 10)

      const cutoff = new Date()
      cutoff.setDate(cutoff.getDate() - (retentionDays > 0 ? retentionDays : 30))
      cutoff.setHours(0, 0, 0, 0)

      const { data, error } = await db
        .from('matches')
        .select('*')
        .eq('profile_id', profileId)
        .gte('start_time', cutoff.toISOString())
        .order('start_time', { ascending: true })
      if (error) throw error

      const matches = (data || []).map((match) => ({
        ...match,
        court_name:
          match.court_name || localCourtService.getById(match.court_id, profileId)?.name || null
      }))
      return { success: true, data: matches }
    } catch (error) {
      console.error('db:get-matches error:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle(
    'db:create-match',
    async (
      _,
      match: {
        court_id: string
        start_time: string
        end_time: string
        player_name: string
        player_phone: string
      },
      profileId: string
    ) => {
      try {
        const court = localCourtService.getById(match.court_id, profileId)
        if (!court) {
          throw new Error('La cancha seleccionada no existe en el almacenamiento local.')
        }

        const db = dbService.getClient()
        const { data, error } = await db
          .from('matches')
          .insert([
            {
              court_id: court.id,
              court_name: court.name,
              start_time: match.start_time,
              end_time: match.end_time,
              player_name: match.player_name,
              player_phone: match.player_phone,
              status: 'SCHEDULED',
              profile_id: profileId
            }
          ])
          .select()
        if (error) throw error
        return { success: true, data }
      } catch (error) {
        console.error('db:create-match error:', error)
        return { success: false, error: (error as Error).message }
      }
    }
  )

  ipcMain.handle('db:delete-match', async (_, matchId: string, profileId: string) => {
    try {
      const db = dbService.getClient()

      // Fetch match to get video_key
      const { data: match } = await db
        .from('matches')
        .select('video_key')
        .eq('id', matchId)
        .eq('profile_id', profileId)
        .single()

      if (match?.video_key) {
        try {
          await r2Service.deleteVideo(match.video_key)
        } catch (err) {
          console.error(`Error deleting video from R2 for match ${matchId}:`, err)
        }
      }

      // Delete local file if it exists
      try {
        const localPath = join(app.getPath('userData'), 'temp_recordings', `${matchId}.mp4`)
        if (fs.existsSync(localPath)) {
          fs.unlinkSync(localPath)
          console.log(`Deleted local file: ${localPath}`)
        }
      } catch (err) {
        console.error(`Error deleting local file for match ${matchId}:`, err)
      }

      const { error } = await db
        .from('matches')
        .delete()
        .eq('id', matchId)
        .eq('profile_id', profileId)
      if (error) throw error
      return { success: true }
    } catch (error) {
      console.error('db:delete-match error:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  // 7. Auto-start on login configuration
  ipcMain.handle('config:get-startup', () => {
    const settings = app.getLoginItemSettings()
    return settings.openAtLogin
  })

  ipcMain.handle('config:save-startup', (_, enabled: boolean) => {
    try {
      app.setLoginItemSettings({
        openAtLogin: enabled,
        path: app.getPath('exe')
      })
      return { success: true }
    } catch (error) {
      console.error('Failed to set login item settings:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  // 8. Session management (persists for 2 months if rememberMe is selected)
  ipcMain.handle('session:get', () => {
    const expiryStr = vaultService.getSecret('SESSION_EXPIRY')
    if (!expiryStr) return { loggedIn: false }

    const expiry = new Date(expiryStr)
    const now = new Date()
    if (now > expiry) {
      vaultService.deleteSecret('SESSION_EXPIRY')
      vaultService.deleteSecret('SESSION_OPERATOR')
      return { loggedIn: false }
    }

    return {
      loggedIn: true,
      operatorName: vaultService.getSecret('SESSION_OPERATOR') || 'Administrador',
      expiry: expiryStr
    }
  })

  ipcMain.handle('session:save', (_, operatorName: string, rememberMe: boolean) => {
    try {
      const expiry = new Date()
      if (rememberMe) {
        // 2 months duration
        expiry.setMonth(expiry.getMonth() + 2)
      } else {
        // 12 hours temporary session
        expiry.setHours(expiry.getHours() + 12)
      }
      vaultService.setSecret('SESSION_EXPIRY', expiry.toISOString())
      vaultService.setSecret('SESSION_OPERATOR', operatorName)
      return { success: true }
    } catch (error) {
      console.error('Failed to save session:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle('session:clear', () => {
    try {
      vaultService.deleteSecret('SESSION_EXPIRY')
      vaultService.deleteSecret('SESSION_OPERATOR')
      return { success: true }
    } catch (error) {
      console.error('Failed to clear session:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  // 9. Notifications configuration
  ipcMain.handle('config:get-notifications', () => {
    return vaultService.getSecret('NOTIFICATIONS_ENABLED') !== 'false'
  })

  ipcMain.handle('config:save-notifications', (_, enabled: boolean) => {
    try {
      vaultService.setSecret('NOTIFICATIONS_ENABLED', enabled ? 'true' : 'false')
      return { success: true }
    } catch (error) {
      console.error('Failed to save notifications setting:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  // 10. Native scale zoom configuration
  ipcMain.handle('config:set-zoom-factor', (event, factor: number) => {
    try {
      const webContents = event.sender
      webContents.setZoomFactor(factor)
      return { success: true }
    } catch (error) {
      console.error('Failed to set zoom factor:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  // 11. DVR/NVR preview through local MediaMTX + WebRTC.
  ipcMain.handle(
    'video-source:preview-start',
    async (
      _,
      input: { source: RecorderSource; profileId: string; profile?: 'main' | 'sub'; compatibility?: boolean }
    ) => {
      try {
        const handle = await mediaMtxService.startPreview(
          input.source,
          input.profileId,
          input.profile || 'sub',
          input.compatibility === true
        )
        return { success: true, data: handle }
      } catch (error) {
        console.error('video-source:preview-start error:', (error as Error).message)
        return { success: false, error: (error as Error).message }
      }
    }
  )

  ipcMain.handle(
    'video-source:preview-stop',
    async (_, handle: { key: string; pathName: string }) => {
      await mediaMtxService.stopPreview(handle)
      return { success: true }
    }
  )

  // 12. Legacy direct-camera preview. Kept unchanged for DirectCameraSource.
  ipcMain.handle(
    'stream:start',
    async (
      event,
      input: { courtId: string; profileId?: string; rtspUrl?: string; source?: RecorderSource }
    ) => {
      const { courtId } = input
      console.log(`[IPC] stream:start requested for source ${courtId}.`)
      if (activeStreams.has(courtId) || startingStreams.has(courtId)) {
        cancelledStreamStarts.delete(courtId)
        activeStreamRefs.set(courtId, (activeStreamRefs.get(courtId) || 0) + 1)
        console.log(`[IPC] Stream for court ${courtId} is already active or starting.`)
        return { success: true, message: 'Stream already active' }
      }

      startingStreams.add(courtId)
      activeStreamRefs.set(courtId, 1)

      try {
        const profileId = input.profileId || dbService.getProfileId()
        let rtspUrl = input.rtspUrl
        if (!rtspUrl && profileId) {
          const resolved = input.source
            ? await videoSourceResolver.resolveSource(input.source, profileId, 'preview')
            : await videoSourceResolver.resolveVideoSource(courtId, profileId, 'preview')
          rtspUrl = resolved.previewUrl || resolved.recordingUrl
        }
          if (!rtspUrl) throw new Error('No hay una fuente de video configurada para esta vista previa.')
        if (cancelledStreamStarts.has(courtId) || (activeStreamRefs.get(courtId) || 0) === 0) {
          startingStreams.delete(courtId)
          cancelledStreamStarts.delete(courtId)
          activeStreamRefs.delete(courtId)
          return { success: false, error: 'El preview fue cancelado antes de iniciar.' }
        }

        const ffmpegPath = ffmpegService.getFFmpegPath()
        const args = [
          '-rtsp_transport',
          'tcp',
          '-analyzeduration',
          '1000000',
          '-probesize',
          '1000000',
          '-fflags',
          'nobuffer',
          '-flags',
          'low_delay',
          '-i',
          rtspUrl,
        '-f',
        'mpegts',
        '-codec:v',
        'mpeg1video',
        '-s',
        '640x360',
        '-b:v',
        '800k',
        '-r',
        '25',
        '-bf',
        '0',
        '-'
      ]

        console.log(`[IPC] Spawning FFmpeg stream process for source ${courtId}.`)
        const proc = spawn(ffmpegPath, args)
        activeStreams.set(courtId, proc)
        startingStreams.delete(courtId)

        const webContents = event.sender
        let chunkCount = 0

        proc.stdout.on('data', (data: Buffer) => {
        chunkCount++
        if (chunkCount <= 5 || chunkCount % 100 === 0) {
          console.log(
            `[IPC] stream for court ${courtId}: sent chunk #${chunkCount} (size: ${data.length} bytes)`
          )
        }
        if (!webContents.isDestroyed()) {
          webContents.send(`stream:data:${courtId}`, data)
        }
      })

        proc.stderr.on('data', () => {
          // Do not log FFmpeg stderr because it can contain RTSP credentials.
        })

        proc.once('error', (error) => {
          activeStreams.delete(courtId)
          activeStreamRefs.delete(courtId)
          console.error(`[IPC] Failed to start streaming for source ${courtId}:`, error.message)
        })

        proc.on('close', (code) => {
          console.log(
            `[IPC] FFmpeg stream process for source ${courtId} closed with exit code ${code}`
          )
          activeStreams.delete(courtId)
          activeStreamRefs.delete(courtId)
        })

        return { success: true }
      } catch (error) {
        startingStreams.delete(courtId)
        activeStreamRefs.delete(courtId)
        console.error(`[IPC] Failed to start streaming for source ${courtId}:`, (error as Error).message)
        return { success: false, error: (error as Error).message }
      }
    }
  )

  ipcMain.handle('stream:stop', (_, courtId) => {
    const references = activeStreamRefs.get(courtId) || 0
    if (references > 1) {
      activeStreamRefs.set(courtId, references - 1)
      return { success: true, message: 'Stream remains active for another preview.' }
    }

    const proc = activeStreams.get(courtId)
    if (proc) {
      proc.kill('SIGKILL')
      activeStreams.delete(courtId)
      activeStreamRefs.delete(courtId)
      return { success: true }
    }
    if (startingStreams.has(courtId)) {
      const nextReferences = Math.max(references - 1, 0)
      activeStreamRefs.set(courtId, nextReferences)
      if (nextReferences === 0) cancelledStreamStarts.add(courtId)
      return { success: true, message: 'Stream startup cancellation requested.' }
    }
    activeStreamRefs.delete(courtId)
    return { success: false, error: 'No stream active' }
  })

  // Logs viewer
  ipcMain.handle('logs:view', () => {
    try {
      const logPath = log.transports.file.getFile().path
      const logContent = fs.readFileSync(logPath, 'utf8')
      const logWindow = new BrowserWindow({
        width: 1000,
        height: 700,
        title: 'ViewPadel Logs',
        autoHideMenuBar: true
      })
      logWindow.loadURL(`data:text/plain;charset=utf-8,${encodeURIComponent(logContent)}`)
      return { success: true }
    } catch (error) {
      console.error('Failed to view logs:', error)
      return { success: false, error: (error as Error).message }
    }
  })
}

app.whenReady().then(() => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('ViewPadel')

  // Listen for second instance (deep linking on Windows/Linux)
  app.on('second-instance', (_, commandLine) => {
    const mainWindow = BrowserWindow.getAllWindows()[0]
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
    const url = commandLine.pop()
    if (url && url.startsWith('viewpadel://')) {
      mainWindow?.webContents.send('auth:deep-link', url)
    }
  })

  // Listen for deep linking on macOS
  app.on('open-url', (event, url) => {
    event.preventDefault()
    const mainWindow = BrowserWindow.getAllWindows()[0]
    if (mainWindow) {
      mainWindow.webContents.send('auth:deep-link', url)
    }
  })

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // Setup IPC
  registerIpcHandlers()

  // Create UI window
  createWindow()

  // Start background scheduler service
  schedulerService.start()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })

  // Configure and check for updates
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
  
  if (is.dev) {
    // Optionally mock autoUpdater in dev if needed, or disable
    autoUpdater.logger = console
  } else {
    autoUpdater.checkForUpdatesAndNotify()
  }

  autoUpdater.on('update-available', () => {
    console.log('Update available, downloading...')
    autoUpdater.downloadUpdate()
  })

  autoUpdater.on('update-downloaded', () => {
    console.log('Update downloaded, it will be installed on restart')
    // We could notify the renderer here to show a toast
  })
})

const activeStreams = new Map<string, ChildProcess>()
const startingStreams = new Set<string>()
const cancelledStreamStarts = new Set<string>()
const activeStreamRefs = new Map<string, number>()
const activeRecorderOperations = new Map<string, AbortController>()

app.on('window-all-closed', () => {
  // Kill all live streaming processes
  for (const [courtId, proc] of activeStreams.entries()) {
    try {
      proc.kill('SIGKILL')
      console.log(`Terminated stream process for court ${courtId} on close.`)
    } catch (err) {
      console.error(`Error killing stream process:`, err)
    }
  }
  activeStreams.clear()
  void mediaMtxService.stop()

  if (process.platform !== 'darwin') {
    schedulerService.stop()
    app.quit()
  }
})
