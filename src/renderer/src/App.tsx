import { useState, useEffect, useRef } from 'react'
import {
  Activity,
  Calendar,
  Settings,
  CloudLightning,
  Video,
  VideoOff,
  Trash2,
  Plus,
  RefreshCw,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Play,
  Square,
  Share2,
  Copy,
  Grid,
  ChevronLeft,
  ChevronRight,
  MoreVertical,
  Film,
  Download
} from 'lucide-react'
import padelCourtSvg from './assets/PadelCourt.svg'
import logoPng from './assets/logo.png'
import CameraScannerModal from './components/CameraScannerModal'
import LoginScreen from './components/LoginScreen'
import { supabase } from './lib/supabase'

interface Court {
  id: string
  name: string
  rtsp_url_key: string
  created_at: string
}

interface Match {
  id: string
  court_id: string
  start_time: string
  end_time: string
  status: 'SCHEDULED' | 'RECORDING' | 'UPLOADING' | 'DONE' | 'FAILED'
  video_key: string | null
  player_phone: string
  player_name: string
  error_log: string | null
  courts?: {
    name: string
  }
}

interface ActiveRecording {
  matchId: string
  elapsedSeconds: number
  durationSeconds: number
}

interface ActiveUpload {
  matchId: string
  percentage: number
}

interface CustomTheme {
  bg: string
  card: string
  text: string
  primary: string
  sidebar: string
}

const DEFAULT_CUSTOM_THEMES: CustomTheme[] = [
  {
    bg: '#0f172a',
    card: 'rgba(30, 41, 59, 0.7)',
    text: '#f8fafc',
    primary: '#3b82f6',
    sidebar: '#0f172a'
  },
  {
    bg: '#18181b',
    card: 'rgba(39, 39, 42, 0.7)',
    text: '#f4f4f5',
    primary: '#ec4899',
    sidebar: '#18181b'
  },
  {
    bg: '#120f26',
    card: 'rgba(25, 20, 48, 0.7)',
    text: '#f3f4f6',
    primary: '#8b5cf6',
    sidebar: '#120f26'
  }
]

interface LiveCourtStreamProps {
  courtId: string
  rtspUrl: string
}

function LiveCourtStream({ courtId, rtspUrl }: LiveCourtStreamProps): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const playerRef = useRef<any>(null)
  const sourceRef = useRef<any>(null)

  useEffect(() => {
    if (!rtspUrl) return

    const JSMpeg = (window as any).JSMpeg
    console.log(
      `[Renderer] LiveCourtStream useEffect mounted for court ${courtId}. JSMpeg exists:`,
      !!JSMpeg,
      'Canvas exists:',
      !!canvasRef.current
    )
    if (!JSMpeg || !canvasRef.current) {
      if (!JSMpeg) console.warn(`[Renderer] window.JSMpeg is NOT defined!`)
      return
    }

    let sourceInstance: any = null

    class CustomSource {
      destination: any = null
      streaming = true
      established = false
      progress = 0

      constructor() {
        sourceInstance = this
      }

      connect(destination: any) {
        this.destination = destination
      }

      start() {}
      resume() {}

      destroy() {
        this.destination = null
      }
    }

    // Initialize player with custom source
    const player = new JSMpeg.Player('', {
      source: CustomSource,
      canvas: canvasRef.current,
      autoplay: true,
      audio: false,
      videoBufferSize: 512 * 1024
    })

    playerRef.current = player
    sourceRef.current = sourceInstance

    // Start streaming process in main
    window.electron.ipcRenderer.invoke('stream:start', { courtId, rtspUrl })

    // Listen to IPC stream data chunk events
    let chunkCount = 0
    const handleData = (_event: any, chunk: Uint8Array) => {
      chunkCount++
      if (chunkCount <= 5 || chunkCount % 100 === 0) {
        console.log(
          `[Renderer] Received chunk #${chunkCount} for court ${courtId} (size: ${chunk.length})`
        )
      }
      if (sourceInstance && sourceInstance.destination) {
        sourceInstance.established = true
        sourceInstance.progress = 1
        // Create a clean copy of the ArrayBuffer from the pooled Uint8Array chunk
        const arrayBuffer = chunk.buffer.slice(
          chunk.byteOffset,
          chunk.byteOffset + chunk.byteLength
        )
        sourceInstance.destination.write(arrayBuffer)
      } else {
        console.warn(`[Renderer] No sourceInstance or destination for court ${courtId}!`)
      }
    }

    window.electron.ipcRenderer.on(`stream:data:${courtId}`, handleData)

    return () => {
      console.log(`[Renderer] LiveCourtStream useEffect cleanup for court ${courtId}`)
      // Clean up listeners and stop streaming in main
      window.electron.ipcRenderer.removeAllListeners(`stream:data:${courtId}`)
      window.electron.ipcRenderer.invoke('stream:stop', courtId)

      if (playerRef.current) {
        playerRef.current.destroy()
      }
    }
  }, [courtId, rtspUrl])

  if (!rtspUrl) {
    return (
      <div
        style={{
          position: 'relative',
          width: '100%',
          aspectRatio: '16/9',
          backgroundColor: '#000',
          borderRadius: '12px',
          overflow: 'hidden',
          border: '1px solid var(--color-border)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center'
        }}
      >
        <span className="text-secondary text-xs">Cámara no configurada</span>
      </div>
    )
  }

  return (
    <div
      style={{
        position: 'relative',
        width: '100%',
        aspectRatio: '16/9',
        backgroundColor: '#000',
        borderRadius: '12px',
        overflow: 'hidden',
        border: '1px solid var(--color-border)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center'
      }}
    >
      <canvas
        ref={canvasRef}
        style={{ display: 'block', width: '100%', height: '100%', objectFit: 'cover' }}
      />
      <span
        className="badge-live animate-pulse-fast"
        style={{
          position: 'absolute',
          top: '10px',
          left: '10px',
          zIndex: 10,
          fontSize: '10px',
          background: '#ef4444',
          color: '#fff',
          padding: '2px 6px',
          borderRadius: '4px',
          fontWeight: 'bold'
        }}
      >
        EN VIVO
      </span>
    </div>
  )
}

function App(): React.JSX.Element {
  const [activeTab, setActiveTab] = useState<
    'dashboard' | 'scheduler' | 'courts' | 'videos' | 'config' | 'profile'
  >('dashboard')
  const [ffmpegStatus, setFfmpegStatus] = useState<{ path: string; exists: boolean }>({
    path: '',
    exists: false
  })
  const [configError, setConfigError] = useState<string | null>(null)

  // Sidebar collapsed state
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    return localStorage.getItem('sidebarCollapsed') === 'true'
  })

  // Logs Viewer State
  const [showLogsModal, setShowLogsModal] = useState<boolean>(false)
  const [logsPassword, setLogsPassword] = useState<string>('')

  // Login States
  const [isLoggedIn, setIsLoggedIn] = useState<boolean>(false)
  const [isConfigured, setIsConfigured] = useState<boolean | null>(null)
  const [sessionUser, setSessionUser] = useState<any>(null)

  // Zoom / scale general state
  const [appScale, setAppScale] = useState<string>('100%')

  // Modal open states
  const [isCreateCourtModalOpen, setIsCreateCourtModalOpen] = useState<boolean>(false)
  const [isScanModalOpen, setIsScanModalOpen] = useState<boolean>(false)
  const [courtToDelete, setCourtToDelete] = useState<Court | null>(null)

  // Modal open states for Videos
  const [playingVideoId, setPlayingVideoId] = useState<string | null>(null)
  const [playingVideoUrl, setPlayingVideoUrl] = useState<string | null>(null)
  const [infoVideoId, setInfoVideoId] = useState<string | null>(null)

  // Court cards action dropdowns state (contains courtId if open)
  const [openDropdownCourtId, setOpenDropdownCourtId] = useState<string | null>(null)

  // App Settings States
  const [notificationsEnabled, setNotificationsEnabled] = useState<boolean>(true)
  const [launchOnStartup, setLaunchOnStartup] = useState<boolean>(false)
  const [defaultPreviewEnabled, setDefaultPreviewEnabled] = useState<boolean>(true)
  const [courtPreviewEnabled, setCourtPreviewEnabled] = useState<Record<string, boolean>>({})

  // Profile States
  const [profileName, setProfileName] = useState<string>('Operador Sportivo')
  const [profileAvatar, setProfileAvatar] = useState<string>('')
  const [clubName, setClubName] = useState<string>('Club Sportivo Belgrano')
  const [clubRole, setClubRole] = useState<string>('Administrador de Turnos')
  const [subType, setSubType] = useState<'free' | 'pro' | 'elite' | 'vitalicia'>('free')
  const [subExpiry, setSubExpiry] = useState<string>('N/A')

  // Theme Settings
  const [themeMode, setThemeMode] = useState<'light' | 'dark'>('dark')
  const [themePreset, setThemePreset] = useState<string>('emerald')
  const [customThemes, setCustomThemes] = useState<CustomTheme[]>(DEFAULT_CUSTOM_THEMES)

  // Database States
  const [courts, setCourts] = useState<Court[]>([])
  const [matches, setMatches] = useState<Match[]>([])
  const [r2Videos, setR2Videos] = useState<{ key: string; size: number; lastModified: Date }[]>([])
  const [loadingDb, setLoadingDb] = useState(false)

  // Active Process States (updated via IPC)
  const [activeRecordings, setActiveRecordings] = useState<Record<string, ActiveRecording>>({})
  const [activeUploads, setActiveUploads] = useState<Record<string, ActiveUpload>>({})
  const [bucketUsageBytes, setBucketUsageBytes] = useState<number>(0)

  // Form States
  const [newMatch, setNewMatch] = useState({
    court_id: '',
    date: new Date().toISOString().split('T')[0],
    time: '18:00',
    duration: '90', // minutes
    player_name: '',
    player_phone: ''
  })

  const [newCourt, setNewCourt] = useState({
    name: '',
    rtsp_url: ''
  })

  // Config States (Credentials read-only backend environment)
  const [config, setConfig] = useState({
    SUPABASE_URL: '',
    SUPABASE_SERVICE_ROLE_KEY: '',
    SUPABASE_KEY: '',
    R2_ACCESS_KEY_ID: '',
    R2_SECRET_ACCESS_KEY: '',
    R2_ENDPOINT: '',
    R2_BUCKET_NAME: 'padelview-matches'
  })

  // RTSP URLs per court (saved in vault)
  const [courtRtspUrls, setCourtRtspUrls] = useState<Record<string, string>>({})

  const [toast, setToast] = useState<{
    message: string
    type: 'success' | 'error' | 'info' | 'warning'
  } | null>(null)

  // Show temporary toast
  const showToast = (message: string, type: 'success' | 'error' | 'info' | 'warning' = 'info') => {
    setToast({ message, type })
    setTimeout(() => setToast(null), 4000)
  }

  // Toggle Sidebar
  const handleToggleSidebar = () => {
    const nextState = !sidebarCollapsed
    setSidebarCollapsed(nextState)
    localStorage.setItem('sidebarCollapsed', String(nextState))
  }

  // Close dropdown on window click
  useEffect(() => {
    const closeDropdown = () => setOpenDropdownCourtId(null)
    window.addEventListener('click', closeDropdown)
    return () => window.removeEventListener('click', closeDropdown)
  }, [])

  // Listen for token refreshes to keep Main Process authenticated
  useEffect(() => {
    const { data: authListener } = supabase.auth.onAuthStateChange(async (_event, session) => {
      if (session?.access_token && window.electron) {
        await window.electron.ipcRenderer.invoke('session:set-token', session.access_token)
      }
    })

    return () => {
      authListener.subscription.unsubscribe()
    }
  }, [])

  // Login success handler from LoginScreen
  const handleLoginSuccess = async (session: any) => {
    setIsLoggedIn(true)
    setSessionUser(session.user)
    
    // Set token in Main Process so dbService uses the Anon Key with RLS
    if (window.electron) {
      await window.electron.ipcRenderer.invoke('session:set-token', session.access_token)
    }
    
    // Check user profile for configuration status
    let { data: profile, error } = await supabase
      .from('profiles')
      .select('is_configured, full_name, club_name, club_role, subscription_type, subscription_expiry, avatar_url')
      .eq('id', session.user.id)
      .maybeSingle()

    // If profile doesn't exist (e.g. old user before triggers), create it
    if (!profile && !error) {
      const { data: newProfile, error: insertErr } = await supabase
        .from('profiles')
        .insert({
          id: session.user.id,
          email: session.user.email,
          full_name: session.user.user_metadata?.full_name || session.user.email,
          role: 'client'
        })
        .select('is_configured, full_name, club_name, club_role, subscription_type, subscription_expiry, avatar_url')
        .single()
      
      if (!insertErr && newProfile) {
        profile = newProfile
      }
    }
      
    if (profile) {
      setIsConfigured(profile.is_configured)
      const name = profile.full_name || session.user.email
      setProfileName(name)
      if (profile.club_name) setClubName(profile.club_name)
      if (profile.club_role) setClubRole(profile.club_role)
      if (profile.subscription_type) setSubType(profile.subscription_type.toLowerCase() as any)
      if (profile.subscription_expiry) setSubExpiry(new Date(profile.subscription_expiry).toLocaleDateString())
      if (profile.avatar_url) setProfileAvatar(profile.avatar_url)
      
      // Update window title dynamically
      if (window.electron) {
        window.electron.ipcRenderer.send('window:set-title', `ViewPadel - ${name}`)
      }
      
      // If configured, fetch config from DB and save it to the local vault securely!
      if (profile.is_configured) {
        const { data: clientConfig } = await supabase
          .from('client_configs')
          .select('*')
          .eq('profile_id', session.user.id)
          .single()
          
        if (clientConfig) {
          if (window.electron) {
            await window.electron.ipcRenderer.invoke('config:save', {
              R2_BUCKET_NAME: clientConfig.r2_bucket_name,
              R2_ACCESS_KEY_ID: clientConfig.r2_access_key_id,
              R2_SECRET_ACCESS_KEY: clientConfig.r2_secret_access_key,
              R2_ENDPOINT: clientConfig.r2_endpoint
            })
          }
          fetchData()
        }
      }
    } else {
      console.error('Profile fetch error:', error)
      setIsConfigured(false)
    }
  }

  // Logout handler
  const handleLogout = async () => {
    await supabase.auth.signOut()
    if (window.electron) {
      await window.electron.ipcRenderer.invoke('session:clear')
      await window.electron.ipcRenderer.invoke('session:set-token', null)
      window.electron.ipcRenderer.send('window:set-title', 'ViewPadel')
    }
    setIsLoggedIn(false)
    setIsConfigured(null)
    setSessionUser(null)
    showToast('Sesión cerrada.', 'info')
  }

  // Play video handler
  // Direct R2 handlers for Video Library
  const handlePlayR2Video = async (key: string) => {
    setPlayingVideoId(key)
    setPlayingVideoUrl(null)
    if (window.electron) {
      const res = await window.electron.ipcRenderer.invoke('config:get-signed-url', key)
      if (res.success) {
        setPlayingVideoUrl(res.url)
      } else {
        showToast('Error al obtener URL del video', 'error')
        setPlayingVideoId(null)
      }
    }
  }

  const handleDownloadR2Video = async (key: string) => {
    if (window.electron) {
      const res = await window.electron.ipcRenderer.invoke('config:get-signed-url', key, true)
      if (res.success) {
        const a = document.createElement('a')
        a.href = res.url
        a.download = ''
        document.body.appendChild(a)
        a.click()
        a.remove()
        showToast('Iniciando descarga...', 'success')
      } else {
        showToast('Error al obtener URL del video', 'error')
      }
    }
  }

  const handleDeleteR2Video = async (key: string) => {
    if (!confirm('¿Estás seguro de que deseas eliminar este video permanentemente?') || !window.electron) return
    const res = await window.electron.ipcRenderer.invoke('r2:delete-video', key)
    if (res.success) {
      showToast('Video eliminado exitosamente.', 'success')
      fetchData()
    } else {
      showToast(`Error: ${res.error}`, 'error')
    }
  }

  // Apply visual theme and zoom scaling to document element
  useEffect(() => {
    const root = document.documentElement
    root.style.removeProperty('--color-bg')
    root.style.removeProperty('--color-bg-card')
    root.style.removeProperty('--color-text-primary')
    root.style.removeProperty('--color-primary')
    root.style.removeProperty('--color-primary-hover')
    root.style.removeProperty('--color-sidebar')

    if (themeMode === 'light') {
      document.body.classList.add('light-theme')
    } else {
      document.body.classList.remove('light-theme')
    }

    if (themePreset === 'emerald') {
      root.style.setProperty('--color-primary', '#10b981')
      root.style.setProperty('--color-primary-hover', '#059669')
    } else if (themePreset === 'slate') {
      root.style.setProperty('--color-primary', '#64748b')
      root.style.setProperty('--color-primary-hover', '#475569')
    } else if (themePreset === 'blue') {
      root.style.setProperty('--color-primary', '#3b82f6')
      root.style.setProperty('--color-primary-hover', '#2563eb')
    } else if (themePreset.startsWith('custom')) {
      const idx = themePreset === 'custom1' ? 0 : themePreset === 'custom2' ? 1 : 2
      const t = customThemes[idx]
      if (t) {
        if (t.bg) root.style.setProperty('--color-bg', t.bg)
        if (t.card) root.style.setProperty('--color-bg-card', t.card)
        if (t.text) root.style.setProperty('--color-text-primary', t.text)
        if (t.primary) {
          root.style.setProperty('--color-primary', t.primary)
          root.style.setProperty('--color-primary-hover', t.primary + 'cc')
        }
        if (t.sidebar) root.style.setProperty('--color-sidebar', t.sidebar)
      }
    }
  }, [themeMode, themePreset, customThemes])

  // Apply native zoom factor
  useEffect(() => {
    const factorMap: Record<string, number> = {
      '40%': 0.4,
      '60%': 0.6,
      '90%': 0.9,
      '100%': 1.0,
      '120%': 1.2,
      '150%': 1.5
    }
    const factor = factorMap[appScale] || 1.0
    if (window.electron) {
      window.electron.ipcRenderer.invoke('config:set-zoom-factor', factor)
    }

    if (config.R2_BUCKET_NAME) {
      console.log(`ViewPadel S3 bucket initialized: ${config.R2_BUCKET_NAME}`)
    }
  }, [appScale, config])

  // Load settings on mount
  useEffect(() => {
    const loadSettings = async () => {
      const savedCustomThemes = localStorage.getItem('customThemes')
      if (savedCustomThemes) {
        try {
          setCustomThemes(JSON.parse(savedCustomThemes))
        } catch (err) {
          console.error(err)
        }
      }
      const savedThemePreset = localStorage.getItem('themePreset')
      if (savedThemePreset) setThemePreset(savedThemePreset)

      const savedThemeMode = localStorage.getItem('themeMode')
      if (savedThemeMode) setThemeMode(savedThemeMode as 'light' | 'dark')

      const savedScale = localStorage.getItem('appScale') || '100%'
      setAppScale(savedScale)

      const defaultPreview = localStorage.getItem('defaultPreviewEnabled') !== 'false'
      setDefaultPreviewEnabled(defaultPreview)

      // Load native Windows notifications preference
      if (window.electron) {
        const notifyEnabled = await window.electron.ipcRenderer.invoke('config:get-notifications')
        setNotificationsEnabled(notifyEnabled)
      }

      // (Profile settings are now fetched on login from DB)
    }
    loadSettings()
  }, [])

  // Fetch all initial data
  const fetchData = async () => {
    setLoadingDb(true)
    try {
      // Check FFmpeg
      if (window.electron) {
        const ffmpeg = await window.electron.ipcRenderer.invoke('ffmpeg:check')
        setFfmpegStatus(ffmpeg)
      }

      // Load Config
      if (window.electron) {
        const savedConfig = await window.electron.ipcRenderer.invoke('config:get')
        setConfig(savedConfig)
      }

      // Load Bucket Usage
      if (window.electron) {
        const usageRes = await window.electron.ipcRenderer.invoke('config:get-bucket-usage')
        if (usageRes.success) {
          setBucketUsageBytes(usageRes.usageBytes)
        }
      }

      // Load Auto-start
      if (window.electron) {
        const startup = await window.electron.ipcRenderer.invoke('config:get-startup')
        setLaunchOnStartup(startup)
      }

      // Refresh Profile Data
      const { data: sessionData } = await supabase.auth.getSession()
      if (sessionData.session?.user) {
        const { data: profile } = await supabase
          .from('profiles')
          .select('is_configured, full_name, club_name, club_role, subscription_type, subscription_expiry, avatar_url')
          .eq('id', sessionData.session.user.id)
          .maybeSingle()
          
        if (profile) {
          setIsConfigured(profile.is_configured)
          setProfileName(profile.full_name || sessionData.session.user.email || 'Operador')
          if (profile.club_name) setClubName(profile.club_name)
          if (profile.club_role) setClubRole(profile.club_role)
          if (profile.subscription_type) setSubType(profile.subscription_type.toLowerCase() as any)
          if (profile.subscription_expiry) setSubExpiry(new Date(profile.subscription_expiry).toLocaleDateString())
          else setSubExpiry('N/A')
          
          if (profile.avatar_url) setProfileAvatar(profile.avatar_url)
          else setProfileAvatar('')
          
          if (window.electron) {
            window.electron.ipcRenderer.send('window:set-title', `ViewPadel - ${profile.full_name || sessionData.session.user.email}`)
          }
        }
      }

      // Load database records
      if (window.electron) {
        const courtsRes = await window.electron.ipcRenderer.invoke('db:get-courts')
        if (courtsRes.success) {
          setCourts(courtsRes.data)
          if (courtsRes.data.length > 0 && !newMatch.court_id) {
            setNewMatch((prev) => ({ ...prev, court_id: courtsRes.data[0].id }))
          }

          // Fetch RTSP urls for courts
          const rtspDict: Record<string, string> = {}
          for (const c of courtsRes.data) {
            const url = await window.electron.ipcRenderer.invoke('config:get-rtsp', c.id)
            rtspDict[c.id] = url || c.rtsp_url_key
          }
          setCourtRtspUrls(rtspDict)
        } else {
          if (courtsRes.error.includes('configuration missing')) {
            setConfigError('Por favor configura Supabase y Cloudflare R2 para comenzar.')
          }
        }

        const matchesRes = await window.electron.ipcRenderer.invoke('db:get-matches')
        if (matchesRes.success) {
          setMatches(matchesRes.data)
        } else {
          console.error(matchesRes.error)
        }

        const r2Res = await window.electron.ipcRenderer.invoke('r2:list-videos')
        if (r2Res.success) {
          // ensure lastModified is parsed as Date if it comes as string over IPC
          setR2Videos(r2Res.videos.map((v: any) => ({ ...v, lastModified: new Date(v.lastModified) })))
        } else {
          console.error(r2Res.error)
        }
      }
    } catch (err) {
      console.error('Error fetching dashboard data:', err)
    } finally {
      setLoadingDb(false)
    }
  }

  // Check persistent session on startup is now handled directly by Supabase in LoginScreen,
  // but we still want to setup listeners
  useEffect(() => {
    if (!window.electron) return
    
    // Listen to real-time events from scheduler/main process
    const handleRecProgress = (_event: any, data: ActiveRecording) => {
      setActiveRecordings((prev) => ({
        ...prev,
        [data.matchId]: data
      }))
    }

    const handleUploadProgress = (_event: any, data: ActiveUpload) => {
      setActiveUploads((prev) => ({
        ...prev,
        [data.matchId]: data
      }))
    }

    const handleMatchUpdated = (_event: any) => {
      fetchData()
    }

    const handleConfigError = (_event: any, msg: string) => {
      setConfigError(msg)
    }

    window.electron.ipcRenderer.on('recording-progress', handleRecProgress)
    window.electron.ipcRenderer.on('upload-progress', handleUploadProgress)
    window.electron.ipcRenderer.on('match-updated', handleMatchUpdated)
    window.electron.ipcRenderer.on('config-error', handleConfigError)

    return () => {
      // Clean listeners
      if (window.electron) {
        window.electron.ipcRenderer.removeAllListeners('recording-progress')
        window.electron.ipcRenderer.removeAllListeners('upload-progress')
        window.electron.ipcRenderer.removeAllListeners('match-updated')
        window.electron.ipcRenderer.removeAllListeners('config-error')
      }
    }
  }, [])

  // Save specific court RTSP url
  const handleSaveCourtRtsp = async (courtId: string, url: string) => {
    if (!window.electron) return
    const res = await window.electron.ipcRenderer.invoke('config:save-rtsp', courtId, url)
    if (res.success) {
      setCourtRtspUrls((prev) => ({ ...prev, [courtId]: url }))
      showToast('URL RTSP de la cancha guardada.', 'success')
    } else {
      showToast(`Error al guardar RTSP: ${res.error}`, 'error')
    }
  }

  // Create new court
  const handleCreateCourt = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newCourt.name || !window.electron) return

    const res = await window.electron.ipcRenderer.invoke(
      'db:create-court',
      newCourt.name,
      newCourt.rtsp_url,
      sessionUser?.id
    )
    if (res.success) {
      showToast('Cancha agregada exitosamente.', 'success')
      setNewCourt({ name: '', rtsp_url: '' })
      fetchData()
    } else {
      showToast(`Error: ${res.error}`, 'error')
    }
  }

  // Delete existing court
  const handleDeleteCourt = async (courtId: string) => {
    if (!window.electron) return
    const res = await window.electron.ipcRenderer.invoke('db:delete-court', courtId)
    if (res.success) {
      showToast('Cancha eliminada exitosamente.', 'success')
      setCourtToDelete(null)
      fetchData()
    } else {
      showToast(`Error al eliminar cancha: ${res.error}`, 'error')
    }
  }

  // Create new scheduled match
  const handleCreateMatch = async (e: React.FormEvent) => {
    e.preventDefault()
    const { court_id, date, time, duration, player_name, player_phone } = newMatch
    if (!court_id || !date || !time || !player_name || !player_phone || !window.electron) {
      showToast('Por favor completa todos los campos del partido.', 'error')
      return
    }

    // Phone Pre-fill validation (Argentina code +549 prefixing)
    let formattedPhone = player_phone.trim().replace(/\s+/g, '')
    if (!formattedPhone.startsWith('+')) {
      if (formattedPhone.startsWith('54')) {
        formattedPhone = '+' + formattedPhone
      } else {
        formattedPhone = '+549' + formattedPhone // default prefix for AR mobile
      }
    }

    const startTime = new Date(`${date}T${time}:00`)
    const endTime = new Date(startTime.getTime() + parseInt(duration) * 60000)

    const res = await window.electron.ipcRenderer.invoke('db:create-match', {
      court_id,
      start_time: startTime.toISOString(),
      end_time: endTime.toISOString(),
      player_name,
      player_phone: formattedPhone
    }, sessionUser?.id)

    if (res.success) {
      showToast('Partido agendado correctamente.', 'success')
      setNewMatch({
        court_id: courts[0]?.id || '',
        date: new Date().toISOString().split('T')[0],
        time: '18:00',
        duration: '90',
        player_name: '',
        player_phone: ''
      })
      fetchData()
    } else {
      showToast(`Error al agendar partido: ${res.error}`, 'error')
    }
  }

  // Manual start recording on-demand
  const handleStartRecordingOnDemand = async (courtId: string) => {
    if (!window.electron) return
    const startTime = new Date()
    const endTime = new Date(startTime.getTime() + 90 * 60000) // 90 min duration by default

    const res = await window.electron.ipcRenderer.invoke('db:create-match', {
      court_id: courtId,
      start_time: startTime.toISOString(),
      end_time: endTime.toISOString(),
      player_name: 'Grabación Manual',
      player_phone: '+5490000000000'
    }, sessionUser?.id)

    if (res.success) {
      showToast('Grabación manual iniciada. Conectando con la cámara...', 'success')
      fetchData()
    } else {
      showToast(`Error al iniciar grabación: ${res.error}`, 'error')
    }
  }

  // Delete match
  const handleDeleteMatch = async (matchId: string) => {
    if (!confirm('¿Estás seguro de que deseas eliminar este partido?') || !window.electron) return
    const res = await window.electron.ipcRenderer.invoke('db:delete-match', matchId)
    if (res.success) {
      showToast('Partido eliminado.', 'success')
      fetchData()
    } else {
      showToast(`Error: ${res.error}`, 'error')
    }
  }

  // Stop/Kill active recording manually
  const handleKillRecording = async (matchId: string) => {
    if (
      !confirm(
        '¿Detener esta grabación manualmente? Se subirá el video parcial obtenido hasta el momento.'
      ) || !window.electron
    )
      return
    const res = await window.electron.ipcRenderer.invoke('recordings:kill', matchId)
    if (res.success) {
      showToast('Grabación detenida. Iniciando procesamiento...', 'info')
      setActiveRecordings((prev) => {
        const copy = { ...prev }
        delete copy[matchId]
        return copy
      })
      fetchData()
    } else {
      showToast('No se pudo detener la grabación.', 'error')
    }
  }

  // Cancel active upload manually
  const handleCancelUpload = async (matchId: string) => {
    if (!confirm('¿Cancelar la subida de este video?') || !window.electron) return
    const res = await window.electron.ipcRenderer.invoke('uploads:cancel', matchId)
    if (res.success) {
      showToast('Subida cancelada.', 'warning')
      setActiveUploads((prev) => {
        const copy = { ...prev }
        delete copy[matchId]
        return copy
      })
      fetchData()
    }
  }

  // Auto start toggle
  const handleToggleStartup = async (enabled: boolean) => {
    setLaunchOnStartup(enabled)
    if (window.electron) {
      await window.electron.ipcRenderer.invoke('config:save-startup', enabled)
      showToast(
        enabled ? 'Arranque automático activado.' : 'Arranque automático desactivado.',
        'success'
      )
    }
  }

  const handleViewLogs = async (e: React.FormEvent) => {
    e.preventDefault()
    if (logsPassword === '1q2w3e4r!') {
      setShowLogsModal(false)
      setLogsPassword('')
      if (window.electron) {
        await window.electron.ipcRenderer.invoke('logs:view')
      }
    } else {
      showToast('Contraseña incorrecta', 'error')
    }
  }

  // Save profile settings
  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault()
    
    // Save to DB
    const { data: sessionData } = await supabase.auth.getSession()
    if (sessionData.session?.user) {
      const { error } = await supabase.from('profiles').update({
        full_name: profileName,
        avatar_url: profileAvatar
      }).eq('id', sessionData.session.user.id)
      
      if (error) {
        showToast('Error al guardar en la base de datos: ' + error.message, 'error')
        return
      }
    }

    showToast('Perfil actualizado correctamente.', 'success')
  }

  // File picker handler for profile avatar
  const handleAvatarChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) {
      const reader = new FileReader()
      reader.onloadend = () => {
        setProfileAvatar(reader.result as string)
      }
      reader.readAsDataURL(file)
    }
  }

  // Custom Color Customization Save
  const handleCustomColorChange = (idx: number, key: keyof CustomTheme, value: string) => {
    const copy = [...customThemes]
    copy[idx] = {
      ...copy[idx],
      [key]: value
    }
    setCustomThemes(copy)
    localStorage.setItem('customThemes', JSON.stringify(copy))
  }

  // Reset custom themes
  const handleResetCustomThemes = () => {
    setCustomThemes(DEFAULT_CUSTOM_THEMES)
    localStorage.setItem('customThemes', JSON.stringify(DEFAULT_CUSTOM_THEMES))
    showToast('Temas personalizados restablecidos.', 'info')
  }

  // Helper to format remaining time
  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60)
    const secs = seconds % 60
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
  }

  // Render Login overlay or Setup overlay if not authenticated/configured
  if (!isLoggedIn) {
    return <LoginScreen onLogin={handleLoginSuccess} />
  }

  if (isLoggedIn && isConfigured === false) {
    return (
      <div style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '100vh',
        backgroundColor: '#0B0F19', color: 'white', padding: '20px', position: 'relative'
      }}>
        {/* CSS inyectado localmente para el fondo y animaciones */}
        <style>{`
          @keyframes fade-in {
            from { opacity: 0; transform: translateY(20px); }
            to { opacity: 1; transform: translateY(0); }
          }
          .block-fade-in {
            animation: fade-in 0.8s ease-out forwards;
          }
          .page-bg {
            position: absolute; top: 0; left: 0; right: 0; bottom: 0;
            z-index: 0; overflow: hidden; pointer-events: none;
          }
          .bg-orb {
            position: absolute; border-radius: 50%; filter: blur(80px); opacity: 0.15;
          }
          .orb-1 { width: 600px; height: 600px; background: #10b981; top: -200px; left: -200px; }
          .orb-2 { width: 500px; height: 500px; background: #f59e0b; bottom: -100px; right: -100px; }
          .grid-lines {
            position: absolute; inset: 0;
            background-image: 
              linear-gradient(to right, rgba(255,255,255,0.03) 1px, transparent 1px),
              linear-gradient(to bottom, rgba(255,255,255,0.03) 1px, transparent 1px);
            background-size: 50px 50px;
            mask-image: radial-gradient(circle at center, black 30%, transparent 80%);
            -webkit-mask-image: radial-gradient(circle at center, black 30%, transparent 80%);
          }
          .pulse-warning {
            animation: pulse-warning 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;
          }
          @keyframes pulse-warning {
            0%, 100% { opacity: 1; }
            50% { opacity: .5; }
          }
        `}</style>
        
        <div className="page-bg">
          <div className="bg-orb orb-1"></div>
          <div className="bg-orb orb-2"></div>
          <div className="grid-lines"></div>
        </div>

        <div className="block-fade-in" style={{
          backgroundColor: 'rgba(15, 23, 42, 0.6)', padding: '50px 40px', borderRadius: '24px', width: '100%', maxWidth: '480px', textAlign: 'center',
          backdropFilter: 'blur(20px)', border: '1px solid rgba(245,158,11,0.2)', boxShadow: '0 25px 50px -12px rgba(0,0,0,0.5)', zIndex: 1
        }}>
          
          <div className="pulse-warning" style={{
            width: '80px', height: '80px', borderRadius: '50%', backgroundColor: 'rgba(245,158,11,0.1)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 24px auto',
            border: '1px solid rgba(245,158,11,0.2)'
          }}>
            <AlertTriangle size={40} color="#f59e0b" />
          </div>

          <h2 style={{ fontSize: '28px', fontWeight: 'bold', margin: '0 0 16px 0', color: '#f8fafc' }}>
            Cuenta en Proceso de Alta
          </h2>
          
          <p style={{ color: '#94a3b8', fontSize: '15px', marginBottom: '32px', lineHeight: '1.6' }}>
            Estamos configurando tu infraestructura de almacenamiento en la nube y asignando tus recursos de procesamiento. 
            Una vez que nuestro equipo asigne tu bucket, la aplicación se desbloqueará automáticamente.
          </p>
          
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <button 
              onClick={() => supabase.auth.getSession().then(({ data }) => data.session && handleLoginSuccess(data.session))} 
              style={{
                width: '100%', backgroundColor: '#3b82f6', color: 'white', padding: '14px', borderRadius: '12px',
                fontSize: '15px', fontWeight: '600', border: 'none', cursor: 'pointer', transition: 'background 0.2s'
              }}
              onMouseOver={(e) => (e.currentTarget.style.backgroundColor = '#2563eb')}
              onMouseOut={(e) => (e.currentTarget.style.backgroundColor = '#3b82f6')}
            >
              Verificar Estado Ahora
            </button>
            <button 
              onClick={handleLogout} 
              style={{
                width: '100%', backgroundColor: 'transparent', color: '#94a3b8', padding: '14px', borderRadius: '12px',
                fontSize: '15px', fontWeight: '600', border: '1px solid rgba(255,255,255,0.1)', cursor: 'pointer', transition: 'all 0.2s'
              }}
              onMouseOver={(e) => { e.currentTarget.style.color = 'white'; e.currentTarget.style.borderColor = 'rgba(255,255,255,0.3)' }}
              onMouseOut={(e) => { e.currentTarget.style.color = '#94a3b8'; e.currentTarget.style.borderColor = 'rgba(255,255,255,0.1)' }}
            >
              Cerrar Sesión
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className={`app-container ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
      {/* Sidebar Navigation */}
      <aside className="sidebar">
        <div
          className="brand"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            width: '100%',
            padding: '0 4px',
            marginBottom: '36px'
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center' }}>
            {sidebarCollapsed ? (
              <button
                className="brand-logo-btn"
                onClick={handleToggleSidebar}
                title="Desplegar menú"
                style={{ padding: '0', background: 'transparent', boxShadow: 'none' }}
              >
                <img src={logoPng} alt="ViewPadel Logo" style={{ width: '32px', height: '32px', objectFit: 'contain', marginLeft: '2px', filter: 'drop-shadow(0 0 10px rgba(16, 185, 129, 0.5))' }} />
                <span className="logo-chevron-icon">
                  <ChevronRight size={20} />
                </span>
              </button>
            ) : (
              <div className="brand-logo-static" style={{ background: 'transparent', boxShadow: 'none' }}>
                <img src={logoPng} alt="ViewPadel Logo" style={{ width: '36px', height: '36px', objectFit: 'contain', filter: 'drop-shadow(0 0 10px rgba(16, 185, 129, 0.5))' }} />
              </div>
            )}

            <div className="brand-text-container">
              <h2
                className="brand-title"
                style={{ margin: 0, fontSize: '16px', fontWeight: 'bold' }}
              >
                ViewPadel
              </h2>
              <span className="badge" style={{ fontSize: '10px', marginTop: '2px', marginLeft: 0 }}>
                MVP
              </span>
            </div>
          </div>

          {!sidebarCollapsed && (
            <button
              className="sidebar-collapse-btn-right"
              onClick={handleToggleSidebar}
              title="Colapsar menú"
            >
              <ChevronLeft size={16} />
            </button>
          )}
        </div>

        <nav className="nav-menu">
          <button
            className={`nav-item ${activeTab === 'dashboard' ? 'active' : ''}`}
            onClick={() => setActiveTab('dashboard')}
            title="Monitoreo"
          >
            <Activity size={18} />
            <span>Monitoreo</span>
          </button>
          <button
            className={`nav-item ${activeTab === 'scheduler' ? 'active' : ''}`}
            onClick={() => setActiveTab('scheduler')}
            title="Agenda"
          >
            <Calendar size={18} />
            <span>Agenda</span>
          </button>
          <button
            className={`nav-item ${activeTab === 'courts' ? 'active' : ''}`}
            onClick={() => setActiveTab('courts')}
            title="Canchas"
          >
            <Grid size={18} />
            <span>Canchas</span>
          </button>
          <button
            className={`nav-item ${activeTab === 'videos' ? 'active' : ''}`}
            onClick={() => setActiveTab('videos')}
            title="Videos"
          >
            <Film size={18} />
            <span>Videos</span>
          </button>
          <button
            className={`nav-item ${activeTab === 'config' ? 'active' : ''}`}
            onClick={() => setActiveTab('config')}
            title="Configuración"
          >
            <Settings size={18} />
            <span>Configuración</span>
          </button>
        </nav>

        <div className="sidebar-footer">
          <button
            className={`profile-nav-item ${activeTab === 'profile' ? 'active' : ''}`}
            onClick={() => setActiveTab('profile')}
            title="Perfil"
          >
            {profileAvatar ? (
              <img src={profileAvatar} className="sidebar-profile-avatar" alt="Avatar" />
            ) : (
              <div className="sidebar-profile-avatar-fallback">
                {profileName.substring(0, 2).toUpperCase()}
              </div>
            )}
            <span>Perfil</span>
          </button>
        </div>
      </aside>

      {/* Main Panel */}
      <main className="main-content">
        {/* Top Header */}
        <header className="top-header">
          <div className="header-title">
            <h1>
              {activeTab === 'dashboard' && 'Panel de Monitoreo'}
              {activeTab === 'scheduler' && 'Planificador de Canchas'}
              {activeTab === 'courts' && 'Canchas'}
              {activeTab === 'videos' && 'Biblioteca de Videos'}
              {activeTab === 'config' && 'Ajustes del Sistema'}
              {activeTab === 'profile' && 'Perfil de Usuario'}
            </h1>
            <div className="header-subtitle">
              {clubName} - {profileName}
            </div>
          </div>
          <button className="btn btn-secondary btn-icon" onClick={fetchData} disabled={loadingDb}>
            <RefreshCw size={16} className={loadingDb ? 'spin' : ''} />
            <span>Sincronizar</span>
          </button>
        </header>

        {/* Global Warnings */}
        {!ffmpegStatus.exists && (
          <div className="banner danger animate-pulse">
            <AlertTriangle size={20} />
            <div className="banner-text">
              <strong>Error de FFmpeg:</strong> No se detectó el binario de FFmpeg en el sistema
              (Ruta: {ffmpegStatus.path}). Las grabaciones de vídeo no funcionarán.
            </div>
          </div>
        )}

        {configError && (
          <div className="banner danger animate-pulse">
            <AlertTriangle size={20} />
            <div className="banner-text">
              <strong>Error de Configuración:</strong> {configError}
            </div>
            <button
              className="btn btn-sm btn-outline-danger"
              onClick={() => setActiveTab('config')}
            >
              Ir a Ajustes
            </button>
          </div>
        )}

        {/* TOAST SYSTEM */}
        {toast && (
          <div className={`toast ${toast.type}`}>
            {toast.type === 'success' && <CheckCircle2 size={16} />}
            {toast.type === 'error' && <XCircle size={16} />}
            <span>{toast.message}</span>
          </div>
        )}

        {/* TAB CONTENTS */}
        <div className="tab-content">
          {/* 1. DASHBOARD */}
          {activeTab === 'dashboard' && (
            <div className="dashboard-view">
              <div className="section-grid">
                {/* Court Cards Grid */}
                <div className="courts-status-section">
                  <h3 className="section-title">Estado de Canchas en Vivo</h3>
                  {courts.length === 0 ? (
                    <div className="empty-state">
                      <Video size={48} className="text-muted" />
                      <p>No hay canchas registradas en la base de datos.</p>
                      <button
                        className="btn btn-primary btn-sm"
                        onClick={() => setActiveTab('courts')}
                      >
                        Registrar una Cancha
                      </button>
                    </div>
                  ) : (
                    <div className="court-cards">
                      {courts.map((court) => {
                        const activeMatch = matches.find(
                          (m) => m.court_id === court.id && m.status === 'RECORDING'
                        )

                        const isRecording = activeMatch !== undefined
                        const progress = activeMatch ? activeRecordings[activeMatch.id] : null
                        const isPreviewActive =
                          courtPreviewEnabled[court.id] !== undefined
                            ? courtPreviewEnabled[court.id]
                            : defaultPreviewEnabled

                        return (
                          <div
                            key={court.id}
                            className={`court-card ${isRecording ? 'recording' : ''}`}
                          >
                            <div className="court-card-header">
                              <h3>{court.name}</h3>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                                {isRecording ? (
                                  <span className="badge-live animate-pulse-fast">GRABANDO</span>
                                ) : (
                                  <span className="badge-idle">DISPONIBLE</span>
                                )}

                                {/* Dropdown actions manual trigger */}
                                <div className="card-options-container">
                                  <button
                                    className="card-options-btn"
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      setOpenDropdownCourtId(
                                        openDropdownCourtId === court.id ? null : court.id
                                      )
                                    }}
                                  >
                                    <MoreVertical size={14} />
                                  </button>
                                  {openDropdownCourtId === court.id && (
                                    <div
                                      className="card-options-dropdown"
                                      onClick={(e) => e.stopPropagation()}
                                    >
                                      <button
                                        type="button"
                                        className="dropdown-item"
                                        disabled={isRecording}
                                        onClick={async () => {
                                          setOpenDropdownCourtId(null)
                                          await handleStartRecordingOnDemand(court.id)
                                        }}
                                      >
                                        <Play size={12} /> Iniciar grabación
                                      </button>
                                      <button
                                        type="button"
                                        className="dropdown-item"
                                        disabled={!isRecording}
                                        onClick={async () => {
                                          setOpenDropdownCourtId(null)
                                          if (activeMatch) {
                                            await handleKillRecording(activeMatch.id)
                                          }
                                        }}
                                      >
                                        <Square size={12} /> Detener grabación
                                      </button>
                                      <button
                                        type="button"
                                        className="dropdown-item"
                                        onClick={() => {
                                          setOpenDropdownCourtId(null)
                                          setCourtPreviewEnabled((prev) => ({
                                            ...prev,
                                            [court.id]: !isPreviewActive
                                          }))
                                        }}
                                      >
                                        {isPreviewActive ? (
                                          <>
                                            <VideoOff size={12} /> Desactivar Cámara
                                          </>
                                        ) : (
                                          <>
                                            <Video size={12} /> Activar Cámara
                                          </>
                                        )}
                                      </button>
                                    </div>
                                  )}
                                </div>
                              </div>
                            </div>
                            <div className="court-card-body">
                              {isPreviewActive && (
                                <div style={{ marginBottom: '12px' }}>
                                  <LiveCourtStream
                                    courtId={court.id}
                                    rtspUrl={courtRtspUrls[court.id] || court.rtsp_url_key}
                                  />
                                </div>
                              )}

                              {isRecording && activeMatch ? (
                                <>
                                  <div className="match-details">
                                    <p className="player-name">{activeMatch.player_name}</p>
                                    <p className="player-phone">{activeMatch.player_phone}</p>
                                  </div>
                                  <div className="progress-container">
                                    <div className="progress-labels">
                                      <span>Tiempo transcurrido</span>
                                      <span className="font-mono">
                                        {progress ? formatTime(progress.elapsedSeconds) : '00:00'} /{' '}
                                        {progress
                                          ? formatTime(progress.durationSeconds)
                                          : 'Calculando...'}
                                      </span>
                                    </div>
                                    <div className="progress-bar-bg">
                                      <div
                                        className="progress-bar-fill success"
                                        style={{
                                          width: progress
                                            ? `${(progress.elapsedSeconds / progress.durationSeconds) * 100}%`
                                            : '0%'
                                        }}
                                      ></div>
                                    </div>
                                  </div>
                                  <button
                                    className="btn btn-danger btn-sm btn-block"
                                    onClick={() => handleKillRecording(activeMatch.id)}
                                  >
                                    <Square size={14} /> Detener Grabación
                                  </button>
                                </>
                              ) : (
                                <div
                                  className={
                                    isPreviewActive ? 'idle-state-condensed' : 'idle-state'
                                  }
                                >
                                  <Play size={isPreviewActive ? 14 : 24} className="text-muted" />
                                  <p className="text-secondary text-sm">
                                    Esperando partido programado...
                                  </p>
                                </div>
                              )}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>

                {/* Subiendo / Subidas Recientes Panel */}
                <div className="uploads-panel">
                  <h3 className="section-title">Subidas a la Nube (R2)</h3>
                  <div className="upload-list card-pane">
                    {matches.filter((m) => m.status === 'UPLOADING').length === 0 ? (
                      <div className="empty-sub-state">
                        <CloudLightning size={24} className="text-muted" />
                        <p className="text-muted text-sm">
                          No hay subidas activas en este momento.
                        </p>
                      </div>
                    ) : (
                      matches
                        .filter((m) => m.status === 'UPLOADING')
                        .map((match) => {
                          const upload = activeUploads[match.id]
                          const percent = upload ? upload.percentage : 0
                          return (
                            <div key={match.id} className="upload-item">
                              <div className="upload-info">
                                <div>
                                  <h4>{match.player_name}</h4>
                                  <p className="text-muted text-xs">Cancha: {match.courts?.name}</p>
                                </div>
                                <span className="font-mono text-sm">{percent}%</span>
                              </div>
                              <div className="progress-bar-bg">
                                <div
                                  className="progress-bar-fill info"
                                  style={{ width: `${percent}%` }}
                                ></div>
                              </div>
                              <button
                                className="btn btn-xs btn-outline-danger"
                                style={{ marginTop: '6px' }}
                                onClick={() => handleCancelUpload(match.id)}
                              >
                                Cancelar Subida
                              </button>
                            </div>
                          )
                        })
                    )}
                  </div>
                </div>
              </div>

              {/* History list inside Dashboard */}
              <div className="dashboard-table-section">
                <h3 className="section-title">Grabaciones Recientes del Día</h3>
                <div className="table-responsive card-pane">
                  <table>
                    <thead>
                      <tr>
                        <th>Cancha</th>
                        <th>Cliente</th>
                        <th>Horario</th>
                        <th>Estado</th>
                        <th>Acción</th>
                      </tr>
                    </thead>
                    <tbody>
                      {matches.length === 0 ? (
                        <tr>
                          <td colSpan={5} className="text-center text-muted">
                            No hay grabaciones registradas para hoy.
                          </td>
                        </tr>
                      ) : (
                        matches.map((match) => (
                          <tr key={match.id}>
                            <td>
                              <strong>{match.courts?.name}</strong>
                            </td>
                            <td>
                              <div>{match.player_name}</div>
                              <div className="text-muted text-xs">{match.player_phone}</div>
                            </td>
                            <td>
                              {new Date(match.start_time).toLocaleTimeString([], {
                                hour: '2-digit',
                                minute: '2-digit'
                              })}{' '}
                              -{' '}
                              {new Date(match.end_time).toLocaleTimeString([], {
                                hour: '2-digit',
                                minute: '2-digit'
                              })}
                            </td>
                            <td>
                              <span className={`status-pill ${match.status.toLowerCase()}`}>
                                {match.status === 'DONE'
                                  ? 'LISTO'
                                  : match.status === 'RECORDING'
                                    ? 'GRABANDO'
                                    : match.status === 'UPLOADING'
                                      ? 'SUBIENDO'
                                      : match.status === 'FAILED'
                                        ? 'FALLIDO'
                                        : 'AGENDADO'}
                              </span>
                            </td>
                            <td>
                              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                                {match.status === 'DONE' && (
                                  <>
                                    <button
                                      className="btn-icon text-success"
                                      onClick={() => {
                                        const cleanPhone = match.player_phone.replace(/[^0-9]/g, '')
                                        const url = `https://padel-view-web-app.vercel.app/partido/${match.id}`
                                        const text = `¡Hola! Tu partido de pádel ya está listo para ver y descargar en: ${url}`
                                        window.open(
                                          `https://wa.me/${cleanPhone}?text=${encodeURIComponent(text)}`,
                                          '_blank'
                                        )
                                      }}
                                      title="Enviar por WhatsApp"
                                      style={{ color: '#25d366' }}
                                    >
                                      <Share2 size={16} />
                                    </button>
                                    <button
                                      className="btn-icon"
                                      onClick={() => {
                                        const url = `https://padel-view-web-app.vercel.app/partido/${match.id}`
                                        navigator.clipboard.writeText(url)
                                        showToast('Enlace copiado al portapapeles.', 'success')
                                      }}
                                      title="Copiar enlace"
                                      style={{ color: '#3b82f6' }}
                                    >
                                      <Copy size={16} />
                                    </button>
                                  </>
                                )}
                                <button
                                  className="btn-icon text-danger"
                                  onClick={() => handleDeleteMatch(match.id)}
                                  title="Eliminar partido"
                                >
                                  <Trash2 size={16} />
                                </button>
                              </div>
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {/* VIDEOS */}
          {activeTab === 'videos' && (
            <div className="videos-view">
              <div className="section-grid" style={{ gridTemplateColumns: '1fr' }}>
                <div className="card-pane">
                  <h3 className="section-title">Almacenamiento de Videos</h3>
                  <div className="storage-info">
                    <div className="storage-labels">
                      <span>Espacio Utilizado (Aprox)</span>
                      <span className="font-mono">
                        {(bucketUsageBytes / (1024 * 1024 * 1024)).toFixed(2)} GB / 10 GB
                      </span>
                    </div>
                    <div className="progress-bar-bg" style={{ height: '12px', marginTop: '8px' }}>
                      <div
                        className="progress-bar-fill"
                        style={{
                          width: `${Math.min((bucketUsageBytes / (10 * 1024 * 1024 * 1024)) * 100, 100)}%`,
                          backgroundColor: bucketUsageBytes > 8 * 1024 * 1024 * 1024 ? '#ef4444' : 'var(--color-primary)'
                        }}
                      ></div>
                    </div>
                  </div>
                </div>

                <div className="videos-grid" style={{ marginTop: '20px' }}>
                  {r2Videos.length === 0 ? (
                    <div className="empty-state" style={{ gridColumn: '1 / -1' }}>
                      <Film size={48} className="text-muted" />
                      <p>No hay videos disponibles en el almacenamiento.</p>
                    </div>
                  ) : (
                    r2Videos.map((video) => (
                      <div key={video.key} className="video-card card-pane" style={{ padding: '0', overflow: 'hidden' }}>
                        <div className="video-thumbnail" onClick={() => handlePlayR2Video(video.key)}>
                          <div className="video-thumbnail-overlay">
                            <Play size={40} className="play-icon" />
                          </div>
                          {/* Placeholder thumbnail */}
                          <div className="thumbnail-placeholder" style={{ aspectRatio: '16/9', background: 'var(--color-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                            <Film size={32} className="text-muted" />
                          </div>
                        </div>
                        <div className="video-info" style={{ padding: '12px' }}>
                          <h4 style={{ margin: '0 0 4px 0', fontSize: '14px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {video.key.split('/').pop()}
                          </h4>
                          <p className="text-muted text-xs" style={{ margin: '0 0 12px 0' }}>
                            {video.lastModified.toLocaleDateString()} - {video.lastModified.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} • {(video.size / (1024 * 1024)).toFixed(2)} MB
                          </p>
                          <div className="video-actions" style={{ display: 'flex', justifyContent: 'flex-end', borderTop: '1px solid var(--color-border)', paddingTop: '10px' }}>
                            <div style={{ display: 'flex', gap: '8px' }}>
                              <button className="btn-icon" style={{ color: '#3b82f6' }} onClick={() => handleDownloadR2Video(video.key)} title="Descargar Video">
                                <Download size={16} />
                              </button>
                              <button className="btn-icon text-danger" onClick={() => handleDeleteR2Video(video.key)} title="Eliminar Video">
                                <Trash2 size={16} />
                              </button>
                            </div>
                          </div>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>

              {/* Video Playback Modal */}
              {playingVideoId && (
                <div className="modal-overlay" onClick={() => { setPlayingVideoId(null); setPlayingVideoUrl(null); }}>
                  <div className="modal-content video-modal" onClick={e => e.stopPropagation()} style={{ maxWidth: '800px', width: '90%' }}>
                    <button className="modal-close-btn" onClick={() => { setPlayingVideoId(null); setPlayingVideoUrl(null); }}>
                      <XCircle size={20} />
                    </button>
                    <h3 className="card-title" style={{ marginBottom: '16px' }}>Reproductor de Video</h3>
                    <div className="video-player-container" style={{ background: '#000', borderRadius: '8px', overflow: 'hidden', aspectRatio: '16/9', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      {playingVideoUrl ? (
                        <video key={playingVideoUrl} controls autoPlay src={playingVideoUrl} style={{ width: '100%', height: '100%', display: 'block' }}>
                          Tu navegador no soporta reproducción de video.
                        </video>
                      ) : (
                        <div style={{ color: 'var(--color-text-secondary)' }}>Cargando reproductor...</div>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* Video Info Modal */}
              {infoVideoId && (() => {
                const infoMatch = matches.find(m => m.id === infoVideoId);
                return infoMatch && (
                  <div className="modal-overlay" onClick={() => setInfoVideoId(null)}>
                    <div className="modal-content" onClick={e => e.stopPropagation()}>
                      <button className="modal-close-btn" onClick={() => setInfoVideoId(null)}>
                        <XCircle size={20} />
                      </button>
                      <h3 className="card-title" style={{ marginBottom: '20px' }}>Información del Video</h3>
                      <div className="info-grid" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                        <div className="info-item" style={{ display: 'grid', gridTemplateColumns: '120px 1fr', alignItems: 'center' }}>
                          <span className="info-label text-secondary text-sm">Cliente:</span>
                          <span className="info-value font-medium">{infoMatch.player_name} ({infoMatch.player_phone})</span>
                        </div>
                        <div className="info-item" style={{ display: 'grid', gridTemplateColumns: '120px 1fr', alignItems: 'center' }}>
                          <span className="info-label text-secondary text-sm">Cancha:</span>
                          <span className="info-value font-medium">{infoMatch.courts?.name}</span>
                        </div>
                        <div className="info-item" style={{ display: 'grid', gridTemplateColumns: '120px 1fr', alignItems: 'center' }}>
                          <span className="info-label text-secondary text-sm">Fecha y Hora:</span>
                          <span className="info-value font-medium">{new Date(infoMatch.start_time).toLocaleString()}</span>
                        </div>
                        <div className="info-item" style={{ display: 'grid', gridTemplateColumns: '120px 1fr', alignItems: 'center' }}>
                          <span className="info-label text-secondary text-sm">UUID:</span>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <span className="info-value font-mono text-xs" style={{ background: 'var(--color-bg)', padding: '4px 8px', borderRadius: '4px' }}>{infoMatch.id}</span>
                            <button className="btn-icon" style={{ padding: '4px' }} onClick={() => { navigator.clipboard.writeText(infoMatch.id); showToast('UUID copiado', 'success'); }} title="Copiar UUID">
                              <Copy size={14} />
                            </button>
                          </div>
                        </div>
                        <div className="info-item" style={{ display: 'grid', gridTemplateColumns: '120px 1fr', alignItems: 'center' }}>
                          <span className="info-label text-secondary text-sm">Enlace:</span>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <span className="info-value" style={{ wordBreak: 'break-all', fontSize: '13px' }}>
                              <a href={`https://padel-view-web-app.vercel.app/partido/${infoMatch.id}`} target="_blank" rel="noreferrer" style={{ color: 'var(--color-primary)' }}>
                                https://padel-view-web-app.vercel.app/partido/{infoMatch.id}
                              </a>
                            </span>
                            <button className="btn-icon" style={{ padding: '4px' }} onClick={() => { navigator.clipboard.writeText(`https://padel-view-web-app.vercel.app/partido/${infoMatch.id}`); showToast('Enlace copiado', 'success'); }} title="Copiar Enlace">
                              <Copy size={14} />
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })()}
            </div>
          )}

          {/* 2. SCHEDULER */}
          {activeTab === 'scheduler' && (
            <div className="scheduler-view">
              <div className="scheduler-grid" style={{ gridTemplateColumns: '1fr' }}>
                {/* Form to Schedule a Recording */}
                <div className="card-pane">
                  <h3 className="card-title">Agendar Nueva Grabación</h3>
                  <form onSubmit={handleCreateMatch} className="form-grid">
                    <div className="form-group">
                      <label>Cancha</label>
                      <select
                        value={newMatch.court_id}
                        onChange={(e) => setNewMatch({ ...newMatch, court_id: e.target.value })}
                        required
                      >
                        <option value="">Selecciona Cancha...</option>
                        {courts.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="form-group-row">
                      <div className="form-group">
                        <label>Fecha</label>
                        <input
                          type="date"
                          value={newMatch.date}
                          onChange={(e) => setNewMatch({ ...newMatch, date: e.target.value })}
                          required
                        />
                      </div>
                      <div className="form-group">
                        <label>Hora Inicio</label>
                        <input
                          type="time"
                          value={newMatch.time}
                          onChange={(e) => setNewMatch({ ...newMatch, time: e.target.value })}
                          required
                        />
                      </div>
                    </div>

                    <div className="form-group">
                      <label>Duración del Partido</label>
                      <select
                        value={newMatch.duration}
                        onChange={(e) => setNewMatch({ ...newMatch, duration: e.target.value })}
                      >
                        <option value="60">1 Hora (60 min)</option>
                        <option value="90">1.5 Horas (90 min)</option>
                        <option value="120">2 Horas (120 min)</option>
                      </select>
                    </div>

                    <div className="form-group">
                      <label>Nombre del Jugador</label>
                      <input
                        type="text"
                        placeholder="Ej. Juan Pérez"
                        value={newMatch.player_name}
                        onChange={(e) => setNewMatch({ ...newMatch, player_name: e.target.value })}
                        required
                      />
                    </div>

                    <div className="form-group">
                      <label>Número de WhatsApp (con o sin +54)</label>
                      <input
                        type="text"
                        placeholder="Ej. 3564123456 o +5493564123456"
                        value={newMatch.player_phone}
                        onChange={(e) => setNewMatch({ ...newMatch, player_phone: e.target.value })}
                        required
                      />
                    </div>

                    <button type="submit" className="btn btn-primary btn-block">
                      <Plus size={16} /> Programar Grabación
                    </button>
                  </form>
                </div>
              </div>

              {/* Courts Configuration list */}
              <div className="dashboard-table-section" style={{ marginTop: '28px' }}>
                <h3 className="section-title">Partidos Programados</h3>
                <div className="table-responsive card-pane">
                  <table>
                    <thead>
                      <tr>
                        <th>Cancha</th>
                        <th>Cliente</th>
                        <th>Horario</th>
                        <th>Estado</th>
                        <th>Acción</th>
                      </tr>
                    </thead>
                    <tbody>
                      {matches.filter((m) => m.status === 'SCHEDULED').length === 0 ? (
                        <tr>
                          <td colSpan={5} className="text-center text-muted">
                            No hay partidos futuros agendados para hoy.
                          </td>
                        </tr>
                      ) : (
                        matches
                          .filter((m) => m.status === 'SCHEDULED')
                          .map((match) => (
                            <tr key={match.id}>
                              <td>
                                <strong>{match.courts?.name}</strong>
                              </td>
                              <td>{match.player_name}</td>
                              <td>
                                {new Date(match.start_time).toLocaleTimeString([], {
                                  hour: '2-digit',
                                  minute: '2-digit'
                                })}{' '}
                                -{' '}
                                {new Date(match.end_time).toLocaleTimeString([], {
                                  hour: '2-digit',
                                  minute: '2-digit'
                                })}
                              </td>
                              <td>
                                <span className="status-pill scheduled">AGENDADO</span>
                              </td>
                              <td>
                                <button
                                  className="btn-icon text-danger"
                                  onClick={() => handleDeleteMatch(match.id)}
                                  title="Eliminar partido"
                                >
                                  <Trash2 size={16} />
                                </button>
                              </td>
                            </tr>
                          ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {/* 3. COURTS BENTO GRID */}
          {activeTab === 'courts' && (
            <div className="courts-view">
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  marginBottom: '20px'
                }}
              >
                <h3 className="section-title" style={{ margin: 0 }}>
                  Canchas
                </h3>
                <button
                  className="btn btn-primary btn-sm"
                  onClick={() => setIsCreateCourtModalOpen(true)}
                >
                  <Plus size={16} style={{ marginRight: '6px' }} />
                  Registrar Cancha
                </button>
              </div>

              {courts.length === 0 ? (
                <div className="empty-state">
                  <Video size={48} className="text-muted" />
                  <p>No hay canchas configuradas en este club.</p>
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={() => setIsCreateCourtModalOpen(true)}
                  >
                    Registrar Primera Cancha
                  </button>
                </div>
              ) : (
                <div className="courts-grid">
                  {courts.map((court) => {
                    const activeMatch = matches.find(
                      (m) => m.court_id === court.id && m.status === 'RECORDING'
                    )
                    const isRecording = activeMatch !== undefined

                    // Check if it is reserved today (has a future match today)
                    const isReserved = matches.some(
                      (m) =>
                        m.court_id === court.id &&
                        m.status === 'SCHEDULED' &&
                        new Date(m.start_time).toDateString() === new Date().toDateString()
                    )

                    let status: 'libre' | 'reservada' | 'grabando' = 'libre'
                    if (isRecording) status = 'grabando'
                    else if (isReserved) status = 'reservada'

                    return (
                      <div
                        key={court.id}
                        className={`court-bento-card ${isRecording ? 'recording' : ''}`}
                      >
                        <div className="bento-card-header">
                          <h3>{court.name}</h3>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                            <span className={`bento-status-badge ${status}`}>
                              {status === 'grabando'
                                ? 'Grabando'
                                : status === 'reservada'
                                  ? 'Reservada'
                                  : 'Libre'}
                            </span>

                            {/* Dropdown actions trigger */}
                            <div className="card-options-container">
                              <button
                                className="card-options-btn"
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  setOpenDropdownCourtId(
                                    openDropdownCourtId === court.id ? null : court.id
                                  )
                                }}
                              >
                                <MoreVertical size={14} />
                              </button>
                              {openDropdownCourtId === court.id && (
                                <div
                                  className="card-options-dropdown"
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  <button
                                    type="button"
                                    className="dropdown-item"
                                    disabled={isRecording}
                                    onClick={async () => {
                                      setOpenDropdownCourtId(null)
                                      await handleStartRecordingOnDemand(court.id)
                                    }}
                                  >
                                    <Play size={12} /> Iniciar grabación
                                  </button>
                                  <button
                                    type="button"
                                    className="dropdown-item"
                                    disabled={!isRecording}
                                    onClick={async () => {
                                      setOpenDropdownCourtId(null)
                                      if (activeMatch) {
                                        await handleKillRecording(activeMatch.id)
                                      }
                                    }}
                                  >
                                    <Square size={12} /> Detener grabación
                                  </button>
                                  <button
                                    type="button"
                                    className="dropdown-item text-danger"
                                    disabled={isRecording}
                                    onClick={() => {
                                      setOpenDropdownCourtId(null)
                                      setCourtToDelete(court)
                                    }}
                                  >
                                    <Trash2 size={12} /> Eliminar cancha
                                  </button>
                                </div>
                              )}
                            </div>
                          </div>
                        </div>

                        <div className="bento-svg-container">
                          <img
                            src={padelCourtSvg}
                            alt="Plano de Cancha"
                            style={{
                              maxWidth: '100%',
                              maxHeight: '100%',
                              filter: status === 'grabando' ? 'hue-rotate(280deg)' : 'none'
                            }}
                          />
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}

              {/* POPUP MODAL FOR COURT REGISTRATION */}
              {isCreateCourtModalOpen && (
                <div className="modal-overlay" onClick={() => setIsCreateCourtModalOpen(false)}>
                  <div className="modal-content" onClick={(e) => e.stopPropagation()}>
                    <button
                      className="modal-close-btn"
                      onClick={() => setIsCreateCourtModalOpen(false)}
                      type="button"
                    >
                      <XCircle size={20} />
                    </button>

                    <h3 className="card-title" style={{ marginBottom: '20px' }}>
                      Registrar Nueva Cancha
                    </h3>
                    <form
                      onSubmit={async (e) => {
                        await handleCreateCourt(e)
                        setIsCreateCourtModalOpen(false)
                      }}
                      className="form-grid"
                    >
                      <div className="form-group">
                        <label>Nombre de la Cancha</label>
                        <input
                          type="text"
                          placeholder="Ej. Cancha Central (Vidrio)"
                          value={newCourt.name}
                          onChange={(e) => setNewCourt({ ...newCourt, name: e.target.value })}
                          required
                        />
                      </div>

                      <div className="form-group">
                        <label>Stream RTSP por Defecto</label>
                        <div className="rtsp-input-wrapper">
                          <input
                            type="text"
                            placeholder="rtsp://usuario:contraseña@ip:puerto/h264"
                            value={newCourt.rtsp_url}
                            onChange={(e) => setNewCourt({ ...newCourt, rtsp_url: e.target.value })}
                          />
                          <button
                            type="button"
                            className="scanner-scan-btn"
                            onClick={() => setIsScanModalOpen(true)}
                            title="Buscar cámaras en la red local"
                          >
                            <Video size={16} /> Buscar en Red
                          </button>
                        </div>
                      </div>

                      <div className="form-group" style={{ marginTop: '16px' }}>
                        <label>Previsualización de Cámara</label>
                        <div style={{ marginTop: '8px' }}>
                          {newCourt.rtsp_url ? (
                            <LiveCourtStream courtId="preview-camera" rtspUrl={newCourt.rtsp_url} />
                          ) : (
                            <div
                              style={{
                                width: '100%',
                                aspectRatio: '16/9',
                                backgroundColor: 'rgba(0,0,0,0.2)',
                                borderRadius: '12px',
                                border: '1px dashed var(--color-border)',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center'
                              }}
                            >
                              <span className="text-muted text-sm">Ingresa una URL RTSP para previsualizar</span>
                            </div>
                          )}
                        </div>
                      </div>

                      <button
                        type="submit"
                        className="btn btn-primary btn-block"
                        style={{ marginTop: '16px' }}
                      >
                        Registrar Cancha
                      </button>
                    </form>
                  </div>
                </div>
              )}

              {isScanModalOpen && (
                <CameraScannerModal
                  isOpen={isScanModalOpen}
                  onClose={() => setIsScanModalOpen(false)}
                  onSelectUrl={(url) => setNewCourt({ ...newCourt, rtsp_url: url })}
                />
              )}

              {/* POPUP MODAL FOR COURT DELETION */}
              {courtToDelete && (
                <div className="modal-overlay" onClick={() => setCourtToDelete(null)}>
                  <div className="modal-content" onClick={(e) => e.stopPropagation()}>
                    <button
                      className="modal-close-btn"
                      onClick={() => setCourtToDelete(null)}
                      type="button"
                    >
                      <XCircle size={20} />
                    </button>

                    <h3 className="card-title" style={{ marginBottom: '20px' }}>
                      Eliminar Cancha
                    </h3>
                    <p style={{ marginBottom: '15px' }}>
                      ¿Estás seguro de que deseas eliminar la cancha{' '}
                      <strong>{courtToDelete.name}</strong>?
                    </p>

                    <div
                      style={{
                        backgroundColor: 'rgba(239, 68, 68, 0.1)',
                        borderLeft: '4px solid var(--color-danger)',
                        padding: '12px',
                        borderRadius: '4px',
                        marginBottom: '20px'
                      }}
                    >
                      <p
                        style={{ margin: 0, fontSize: '0.85rem', lineHeight: '1.4' }}
                        className="text-danger"
                      >
                        <strong>Atención:</strong> Esta acción es irreversible. Se eliminarán
                        permanentemente todos los partidos, grabaciones y programaciones asociadas a
                        esta cancha.
                      </p>
                    </div>

                    <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
                      <button
                        className="btn btn-secondary"
                        onClick={() => setCourtToDelete(null)}
                        type="button"
                      >
                        Cancelar
                      </button>
                      <button
                        className="btn btn-danger"
                        onClick={() => handleDeleteCourt(courtToDelete.id)}
                        type="button"
                      >
                        Eliminar
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* 4. CONFIGURATION */}
          {activeTab === 'config' && (
            <div className="config-view">
              <div className="config-form form-grid">
                {/* System Logs Card */}
                <div className="card-pane">
                  <h3 className="card-title">Registros del Sistema</h3>
                  <p className="text-muted text-sm" style={{ marginBottom: '16px' }}>
                    Visualiza los registros internos de la aplicación para diagnóstico y solución de problemas.
                  </p>
                  <button
                    className="btn btn-secondary"
                    onClick={() => setShowLogsModal(true)}
                  >
                    Ver Logs
                  </button>
                </div>

                {/* Visual Settings & Themes Card */}
                <div className="card-pane">
                  <h3 className="card-title">Ajustes Visuales</h3>

                  <div className="form-group" style={{ marginBottom: '16px' }}>
                    <label>Modo de Pantalla</label>
                    <div style={{ display: 'flex', gap: '10px', marginTop: '6px' }}>
                      <button
                        className={`theme-btn ${themeMode === 'dark' ? 'active' : ''}`}
                        onClick={() => {
                          setThemeMode('dark')
                          localStorage.setItem('themeMode', 'dark')
                        }}
                      >
                        Tema Oscuro
                      </button>
                      <button
                        className={`theme-btn ${themeMode === 'light' ? 'active' : ''}`}
                        onClick={() => {
                          setThemeMode('light')
                          localStorage.setItem('themeMode', 'light')
                        }}
                      >
                        Tema Claro
                      </button>
                    </div>
                  </div>

                  <div className="form-group">
                    <label>Paleta de Colores Predefinidos</label>
                    <div className="theme-options-grid" style={{ marginTop: '6px' }}>
                      <button
                        className={`theme-btn ${themePreset === 'emerald' ? 'active' : ''}`}
                        onClick={() => {
                          setThemePreset('emerald')
                          localStorage.setItem('themePreset', 'emerald')
                        }}
                      >
                        Esmeralda
                      </button>
                      <button
                        className={`theme-btn ${themePreset === 'blue' ? 'active' : ''}`}
                        onClick={() => {
                          setThemePreset('blue')
                          localStorage.setItem('themePreset', 'blue')
                        }}
                      >
                        Azul Classic
                      </button>
                      <button
                        className={`theme-btn ${themePreset === 'slate' ? 'active' : ''}`}
                        onClick={() => {
                          setThemePreset('slate')
                          localStorage.setItem('themePreset', 'slate')
                        }}
                      >
                        Gris Pizarra
                      </button>
                    </div>
                  </div>

                  {/* App overall scaling selection */}
                  <div className="form-group" style={{ marginTop: '16px' }}>
                    <label>Escala de Pantalla (Zoom)</label>
                    <select
                      value={appScale}
                      onChange={(e) => {
                        const scale = e.target.value
                        setAppScale(scale)
                        localStorage.setItem('appScale', scale)
                      }}
                      className="table-input"
                      style={{ marginTop: '6px', width: '100%' }}
                    >
                      <option value="40%">40%</option>
                      <option value="60%">60%</option>
                      <option value="90%">90%</option>
                      <option value="100%">100% (Por defecto)</option>
                      <option value="120%">120%</option>
                      <option value="150%">150%</option>
                    </select>
                  </div>

                  {/* Custom Theme Slots */}
                  <div className="theme-customizer">
                    <label>Temas Personalizados (Color Picker)</label>
                    <div className="theme-options-grid">
                      <button
                        className={`theme-btn ${themePreset === 'custom1' ? 'active' : ''}`}
                        onClick={() => {
                          setThemePreset('custom1')
                          localStorage.setItem('themePreset', 'custom1')
                        }}
                      >
                        Tema Propio 1
                      </button>
                      <button
                        className={`theme-btn ${themePreset === 'custom2' ? 'active' : ''}`}
                        onClick={() => {
                          setThemePreset('custom2')
                          localStorage.setItem('themePreset', 'custom2')
                        }}
                      >
                        Tema Propio 2
                      </button>
                      <button
                        className={`theme-btn ${themePreset === 'custom3' ? 'active' : ''}`}
                        onClick={() => {
                          setThemePreset('custom3')
                          localStorage.setItem('themePreset', 'custom3')
                        }}
                      >
                        Tema Propio 3
                      </button>
                    </div>

                    {themePreset.startsWith('custom') && (
                      <div className="custom-theme-editor animate-pulse-fast">
                        <h4>
                          Diseñando{' '}
                          {themePreset === 'custom1'
                            ? 'Tema 1'
                            : themePreset === 'custom2'
                              ? 'Tema 2'
                              : 'Tema 3'}
                        </h4>

                        <div className="color-pickers-grid">
                          {(() => {
                            const idx =
                              themePreset === 'custom1' ? 0 : themePreset === 'custom2' ? 1 : 2
                            const t = customThemes[idx]
                            if (!t) return null
                            return (
                              <>
                                <div className="color-picker-item">
                                  <span>Color Fondo:</span>
                                  <input
                                    type="color"
                                    value={t.bg}
                                    onChange={(e) =>
                                      handleCustomColorChange(idx, 'bg', e.target.value)
                                    }
                                  />
                                </div>
                                <div className="color-picker-item">
                                  <span>Color Card:</span>
                                  <input
                                    type="color"
                                    value={t.card}
                                    onChange={(e) =>
                                      handleCustomColorChange(idx, 'card', e.target.value)
                                    }
                                  />
                                </div>
                                <div className="color-picker-item">
                                  <span>Color Texto:</span>
                                  <input
                                    type="color"
                                    value={t.text}
                                    onChange={(e) =>
                                      handleCustomColorChange(idx, 'text', e.target.value)
                                    }
                                  />
                                </div>
                                <div className="color-picker-item">
                                  <span>Acento / Botón:</span>
                                  <input
                                    type="color"
                                    value={t.primary}
                                    onChange={(e) =>
                                      handleCustomColorChange(idx, 'primary', e.target.value)
                                    }
                                  />
                                </div>
                                <div className="color-picker-item" style={{ gridColumn: '1 / -1' }}>
                                  <span>Fondo del Menú Lateral:</span>
                                  <input
                                    type="color"
                                    value={t.sidebar}
                                    onChange={(e) =>
                                      handleCustomColorChange(idx, 'sidebar', e.target.value)
                                    }
                                  />
                                </div>
                              </>
                            )
                          })()}
                        </div>
                        <button
                          className="btn btn-xs btn-outline-danger"
                          style={{ marginTop: '14px', width: '100%' }}
                          onClick={handleResetCustomThemes}
                        >
                          Restablecer Colores
                        </button>
                      </div>
                    )}
                  </div>
                </div>

                {/* System Settings Options */}
                <div className="card-pane">
                  <h3 className="card-title">Preferencias del Sistema</h3>

                  <div className="form-group" style={{ marginBottom: '16px' }}>
                    <label
                      className="login-checkbox-group"
                      style={{ color: 'var(--color-text-primary)' }}
                    >
                      <input
                        type="checkbox"
                        checked={notificationsEnabled}
                        onChange={async (e) => {
                          const val = e.target.checked
                          setNotificationsEnabled(val)
                          localStorage.setItem('notificationsEnabled', String(val))
                          await window.electron.ipcRenderer.invoke('config:save-notifications', val)
                          showToast(
                            val ? 'Notificaciones activadas.' : 'Notificaciones desactivadas.',
                            'info'
                          )
                        }}
                      />
                      <span>Mostrar notificaciones nativas</span>
                    </label>
                    <span className="input-hint" style={{ marginTop: '4px', display: 'block' }}>
                      Muestra una notificación en Windows cuando FFmpeg termine de grabar.
                    </span>
                  </div>

                  <div className="form-group">
                    <label
                      className="login-checkbox-group"
                      style={{ color: 'var(--color-text-primary)' }}
                    >
                      <input
                        type="checkbox"
                        checked={launchOnStartup}
                        onChange={(e) => handleToggleStartup(e.target.checked)}
                      />
                      <span>Lanzar aplicación al encender el equipo</span>
                    </label>
                    <span className="input-hint" style={{ marginTop: '4px', display: 'block' }}>
                      ViewPadel se abrirá automáticamente en segundo plano cuando inicie Windows.
                    </span>
                  </div>

                  <div className="form-group" style={{ marginTop: '16px' }}>
                    <label
                      className="login-checkbox-group"
                      style={{ color: 'var(--color-text-primary)' }}
                    >
                      <input
                        type="checkbox"
                        checked={defaultPreviewEnabled}
                        onChange={(e) => {
                          const val = e.target.checked
                          setDefaultPreviewEnabled(val)
                          localStorage.setItem('defaultPreviewEnabled', String(val))
                          showToast(
                            val
                              ? 'Previsualización por defecto activada.'
                              : 'Previsualización por defecto desactivada.',
                            'info'
                          )
                        }}
                      />
                      <span>Habilitar previsualización de cámaras por defecto</span>
                    </label>
                    <span className="input-hint" style={{ marginTop: '4px', display: 'block' }}>
                      Las cámaras se reproducirán en vivo automáticamente en el panel de monitoreo.
                    </span>
                  </div>

                  {/* RTSP configuration input fields for registered courts */}
                  {courts.length > 0 && (
                    <div
                      style={{
                        marginTop: '24px',
                        borderTop: '1px solid var(--color-border)',
                        paddingTop: '16px'
                      }}
                    >
                      <h4 style={{ fontSize: '14px', marginBottom: '10px' }}>
                        Enlaces de Transmisión RTSP (Cámaras)
                      </h4>
                      {courts.map((c) => (
                        <div key={c.id} className="form-group" style={{ marginBottom: '12px' }}>
                          <label>{c.name}</label>
                          <input
                            type="text"
                            className="table-input"
                            value={courtRtspUrls[c.id] || ''}
                            placeholder="rtsp://usuario:contraseña@ip:puerto/canal"
                            onChange={(e) =>
                              setCourtRtspUrls({ ...courtRtspUrls, [c.id]: e.target.value })
                            }
                            onBlur={(e) => handleSaveCourtRtsp(c.id, e.target.value)}
                          />
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* 5. USER PROFILE & SUBSCRIPTIONS */}
          {activeTab === 'profile' && (
            <div className="profile-view-wrapper">
              <form onSubmit={handleSaveProfile} className="profile-view">
                <div className="profile-avatar-card">
                  <div className="avatar-wrapper">
                    {profileAvatar ? (
                      <img src={profileAvatar} className="avatar-image" alt="Avatar" />
                    ) : (
                      <div className="avatar-fallback">
                        {profileName.substring(0, 2).toUpperCase()}
                      </div>
                    )}
                  </div>

                  <label className="avatar-upload-btn">
                    Cambiar Imagen
                    <input
                      type="file"
                      accept="image/*"
                      className="avatar-input"
                      onChange={handleAvatarChange}
                    />
                  </label>

                  <h3 style={{ fontSize: '18px', fontWeight: '700', marginTop: '10px' }}>
                    {profileName}
                  </h3>
                  <p className="text-secondary text-sm">{clubRole}</p>
                </div>

                <div className="card-pane">
                  <h3 className="card-title">Datos Personales</h3>
                  <div className="form-grid" style={{ marginBottom: '24px' }}>
                    <div className="form-group">
                      <label>Nombre del Operador</label>
                      <input
                        type="text"
                        value={profileName}
                        onChange={(e) => setProfileName(e.target.value)}
                        required
                      />
                    </div>

                    <div className="form-group">
                      <label>Club Asignado</label>
                      <input
                        type="text"
                        value={clubName}
                        onChange={(e) => setClubName(e.target.value)}
                        required
                      />
                    </div>

                    <div className="form-group">
                      <label>Rol de Acceso</label>
                      <input
                        type="text"
                        value={clubRole}
                        onChange={(e) => setClubRole(e.target.value)}
                        required
                      />
                    </div>
                  </div>

                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px' }}>
                    <button type="button" className="btn btn-outline-danger" onClick={handleLogout}>
                      Cerrar Sesión de Recepción
                    </button>
                    <button type="submit" className="btn btn-primary">
                      Guardar Datos de Perfil
                    </button>
                  </div>
                </div>

                {/* Subscription Status Section (Premium visual cards) */}
                <div className="subscription-section">
                  <h3 className="section-title">Estado de Suscripción</h3>

                  {subType === 'vitalicia' && (
                    <div className="sub-card sub-vitalicia">
                      <h4>Suscripción Premium</h4>
                      <h3>Licencia Vitalicia</h3>
                      <p>
                        ¡Muchas gracias por apoyar el proyecto ViewPadel! Tu club tiene todos los
                        privilegios desbloqueados de forma indefinida.
                      </p>
                      <span className="sub-badge-gold">VITALICIA</span>
                    </div>
                  )}

                  {(subType === 'pro' || subType === 'elite') && (
                    <div className="sub-card sub-activa">
                      <h4>Suscripción Premium</h4>
                      <h3>Plan {subType.toUpperCase()}</h3>
                      <p>
                        Suscripción registrada correctamente. Tu licencia expira el:{' '}
                        <strong>{subExpiry}</strong>.
                      </p>
                      <span className="sub-badge-gold">ACTIVA</span>
                    </div>
                  )}

                  {subType === 'free' && (
                    <div className="sub-card sub-inactiva">
                      <h4>Suscripción Gratuita</h4>
                      <h3>Plan FREE</h3>
                      <p>
                        Estás en el plan gratuito. Las funciones de grabación en la nube y monetización
                        pueden estar limitadas.
                      </p>
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        onClick={() => window.open('https://padelview.app/subscribe', '_blank')}
                      >
                        Mejorar Plan
                      </button>
                    </div>
                  )}
                </div>
              </form>
            </div>
          )}
        </div>

        {/* Logs Password Modal */}
        {showLogsModal && (
          <div className="modal-overlay" onClick={() => setShowLogsModal(false)}>
            <div className="modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '400px' }}>
              <h3 className="card-title">Acceso a Registros</h3>
              <p className="text-muted text-sm" style={{ marginBottom: '16px' }}>
                Introduce la contraseña de administrador para ver los logs del sistema.
              </p>
              <form onSubmit={handleViewLogs}>
                <div className="form-group">
                  <input
                    type="password"
                    value={logsPassword}
                    onChange={(e) => setLogsPassword(e.target.value)}
                    placeholder="Contraseña"
                    className="form-control"
                    autoFocus
                  />
                </div>
                <div className="modal-actions" style={{ marginTop: '20px', display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
                  <button type="button" className="btn btn-secondary" onClick={() => setShowLogsModal(false)}>
                    Cancelar
                  </button>
                  <button type="submit" className="btn btn-primary">
                    Acceder
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}
      </main>
    </div>
  )
}

export default App
