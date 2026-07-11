import { app, shell, BrowserWindow, ipcMain } from 'electron';
import { join } from 'path';
import fs from 'fs';
import { electronApp, optimizer, is } from '@electron-toolkit/utils';
import icon from '../../resources/icon.png?asset';

// Services imports
import { vaultService } from './services/vault.service';
import { dbService } from './services/db.service';
import { ffmpegService } from './services/ffmpeg.service';
import { r2Service } from './services/r2.service';
import { schedulerService } from './services/scheduler.service';

function createWindow(): void {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 1024,
    height: 768,
    show: false,
    autoHideMenuBar: true,
    title: 'PadelView - Control de Canchas y Grabación',
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  });

  mainWindow.on('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url);
    return { action: 'deny' };
  });

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

// Register IPC handlers for renderer communication
function registerIpcHandlers(): void {
  // 1. Config management
  ipcMain.handle('config:get', () => {
    return {
      SUPABASE_URL: vaultService.getSecret('SUPABASE_URL') || '',
      SUPABASE_SERVICE_ROLE_KEY: vaultService.getSecret('SUPABASE_SERVICE_ROLE_KEY') || '',
      SUPABASE_KEY: vaultService.getSecret('SUPABASE_KEY') || '',
      R2_ACCESS_KEY_ID: vaultService.getSecret('R2_ACCESS_KEY_ID') || '',
      R2_SECRET_ACCESS_KEY: vaultService.getSecret('R2_SECRET_ACCESS_KEY') || '',
      R2_ENDPOINT: vaultService.getSecret('R2_ENDPOINT') || '',
      R2_BUCKET_NAME: vaultService.getSecret('R2_BUCKET_NAME') || 'padelview-matches',
    };
  });

  ipcMain.handle('config:save', (_, config: Record<string, string>) => {
    try {
      for (const [key, value] of Object.entries(config)) {
        vaultService.setSecret(key, value);
      }
      // Reset db service client so it re-initializes with the new credentials next time it's used
      dbService.resetClient();
      return { success: true };
    } catch (error) {
      console.error('Failed to save config:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  // Court specific RTSP URLs
  ipcMain.handle('config:get-rtsp', (_, courtId: string) => {
    return vaultService.getSecret(`RTSP_URL_${courtId}`) || '';
  });

  ipcMain.handle('config:save-rtsp', (_, courtId: string, url: string) => {
    try {
      vaultService.setSecret(`RTSP_URL_${courtId}`, url);
      return { success: true };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  // 2. FFmpeg check
  ipcMain.handle('ffmpeg:check', () => {
    const ffmpegPath = ffmpegService.getFFmpegPath();
    const exists = fs.existsSync(ffmpegPath);
    return {
      path: ffmpegPath,
      exists: exists
    };
  });

  // 3. Manual action to terminate a recording
  ipcMain.handle('recordings:kill', (_, matchId: string) => {
    const success = ffmpegService.killRecording(matchId);
    return { success };
  });

  // 4. Manual action to terminate an upload
  ipcMain.handle('uploads:cancel', async (_, matchId: string) => {
    const success = await r2Service.cancelUpload(matchId);
    return { success };
  });

  // 5. Get current scheduler & active states
  ipcMain.handle('scheduler:state', () => {
    return {
      activeRecordingsCount: ffmpegService.getActiveCount(),
    };
  });

  // 6. DB operations routed from frontend to protect credentials and use service key
  ipcMain.handle('db:get-courts', async () => {
    try {
      const db = dbService.getClient();
      const { data, error } = await db.from('courts').select('*').order('name', { ascending: true });
      if (error) throw error;
      return { success: true, data };
    } catch (error) {
      console.error('db:get-courts error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle('db:create-court', async (_, name: string, rtspUrlKey: string) => {
    try {
      const db = dbService.getClient();
      const { data, error } = await db.from('courts').insert([{ name, rtsp_url_key: rtspUrlKey }]).select();
      if (error) throw error;
      return { success: true, data };
    } catch (error) {
      console.error('db:create-court error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle('db:get-matches', async () => {
    try {
      const db = dbService.getClient();
      // Fetch matches from today onwards
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const { data, error } = await db
        .from('matches')
        .select('*, courts(name)')
        .gte('start_time', today.toISOString())
        .order('start_time', { ascending: true });
      if (error) throw error;
      return { success: true, data };
    } catch (error) {
      console.error('db:get-matches error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle('db:create-match', async (_, match: {
    court_id: string;
    start_time: string;
    end_time: string;
    player_name: string;
    player_phone: string;
  }) => {
    try {
      const db = dbService.getClient();
      const { data, error } = await db
        .from('matches')
        .insert([{
          court_id: match.court_id,
          start_time: match.start_time,
          end_time: match.end_time,
          player_name: match.player_name,
          player_phone: match.player_phone,
          status: 'SCHEDULED'
        }])
        .select();
      if (error) throw error;
      return { success: true, data };
    } catch (error) {
      console.error('db:create-match error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle('db:delete-match', async (_, matchId: string) => {
    try {
      const db = dbService.getClient();
      const { error } = await db.from('matches').delete().eq('id', matchId);
      if (error) throw error;
      return { success: true };
    } catch (error) {
      console.error('db:delete-match error:', error);
      return { success: false, error: (error as Error).message };
    }
  });
}

app.whenReady().then(() => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.electron');

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window);
  });

  // Setup IPC
  registerIpcHandlers();

  // Create UI window
  createWindow();

  // Start background scheduler service
  schedulerService.start();

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    schedulerService.stop();
    app.quit();
  }
});
