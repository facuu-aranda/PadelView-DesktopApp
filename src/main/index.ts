import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { join, resolve } from 'path'
import fs from 'fs'
import { spawn, ChildProcess } from 'child_process'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { autoUpdater } from 'electron-updater'
import icon from '../../resources/icon.png?asset'

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
}

// Services imports
import { vaultService } from './services/vault.service'
import { dbService } from './services/db.service'
import { ffmpegService } from './services/ffmpeg.service'
import { r2Service } from './services/r2.service'
import { schedulerService } from './services/scheduler.service'
import { discoveryService } from './services/discovery.service'

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
      sandbox: false
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

  // Set Auth Token for DB Service
  ipcMain.handle('session:set-token', (_, token: string | null) => {
    dbService.setAccessToken(token)
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

  // Court specific RTSP URLs
  ipcMain.handle('config:get-rtsp', (_, courtId: string) => {
    return vaultService.getSecret(`RTSP_URL_${courtId}`) || ''
  })

  ipcMain.handle('config:save-rtsp', (_, courtId: string, url: string) => {
    try {
      vaultService.setSecret(`RTSP_URL_${courtId}`, url)
      return { success: true }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })

  // Get signed video URL from R2
  ipcMain.handle('config:get-signed-url', async (_, key: string, forDownload?: boolean) => {
    try {
      const url = await r2Service.getSignedVideoUrl(key, 3600, forDownload)
      return { success: true, url }
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

  // 3. Manual action to terminate a recording
  ipcMain.handle('recordings:kill', (_, matchId: string) => {
    const success = ffmpegService.killRecording(matchId)
    return { success }
  })

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

  // 6. DB operations routed from frontend to protect credentials and use service key
  ipcMain.handle('db:get-courts', async () => {
    try {
      const db = dbService.getClient()
      const { data, error } = await db.from('courts').select('*').order('name', { ascending: true })
      if (error) throw error
      return { success: true, data }
    } catch (error) {
      console.error('db:get-courts error:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle('db:create-court', async (_, name: string, rtspUrlKey: string, profileId: string) => {
    try {
      const db = dbService.getClient()
      const { data, error } = await db
        .from('courts')
        .insert([{ name, rtsp_url_key: rtspUrlKey, profile_id: profileId }])
        .select()
      if (error) throw error
      return { success: true, data }
    } catch (error) {
      console.error('db:create-court error:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle('db:delete-court', async (_, courtId: string) => {
    try {
      const db = dbService.getClient()
      const { data, error } = await db.from('courts').delete().eq('id', courtId).select()
      if (error) throw error

      // Clean up the local RTSP URL secret associated with this court
      vaultService.deleteSecret(`RTSP_URL_${courtId}`)

      return { success: true, data }
    } catch (error) {
      console.error('db:delete-court error:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle('db:get-matches', async () => {
    try {
      const db = dbService.getClient()
      // Fetch matches from today onwards
      const today = new Date()
      today.setHours(0, 0, 0, 0)
      const { data, error } = await db
        .from('matches')
        .select('*, courts(name)')
        .gte('start_time', today.toISOString())
        .order('start_time', { ascending: true })
      if (error) throw error
      return { success: true, data }
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
        const db = dbService.getClient()
        const { data, error } = await db
          .from('matches')
          .insert([
            {
              court_id: match.court_id,
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

  ipcMain.handle('db:delete-match', async (_, matchId: string) => {
    try {
      const db = dbService.getClient()
      
      // Fetch match to get video_key
      const { data: match } = await db.from('matches').select('video_key').eq('id', matchId).single()
      
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

      const { error } = await db.from('matches').delete().eq('id', matchId)
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

  // 11. Live Camera Streaming handlers (RTSP -> JSMpeg / IPC)
  ipcMain.handle('stream:start', (event, { courtId, rtspUrl }) => {
    console.log(`[IPC] stream:start requested for court ${courtId} with RTSP URL: ${rtspUrl}`)
    if (activeStreams.has(courtId)) {
      console.log(`[IPC] Stream for court ${courtId} is already active.`)
      return { success: true, message: 'Stream already active' }
    }

    try {
      const ffmpegPath = ffmpegService.getFFmpegPath()
      const args = [
        '-rtsp_transport',
        'tcp',
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

      console.log(`[IPC] Spawning FFmpeg stream process: ${ffmpegPath} ${args.join(' ')}`)
      const proc = spawn(ffmpegPath, args)
      activeStreams.set(courtId, proc)

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

      proc.stderr.on('data', (data) => {
        // Keep a log of FFmpeg stderr to debug connection or codec issues
        console.log(`[FFmpeg Stream ${courtId} Stderr]:`, data.toString().trim())
      })

      proc.on('close', (code) => {
        console.log(
          `[IPC] FFmpeg Stream process for court ${courtId} closed with exit code ${code}`
        )
        activeStreams.delete(courtId)
      })

      return { success: true }
    } catch (error) {
      console.error(`[IPC] Failed to start streaming for court ${courtId}:`, error)
      return { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle('stream:stop', (_, courtId) => {
    const proc = activeStreams.get(courtId)
    if (proc) {
      proc.kill('SIGKILL')
      activeStreams.delete(courtId)
      return { success: true }
    }
    return { success: false, error: 'No stream active' }
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

  if (process.platform !== 'darwin') {
    schedulerService.stop()
    app.quit()
  }
})
