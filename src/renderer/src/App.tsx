import { useState, useEffect } from 'react';
import {
  Activity,
  Calendar,
  Settings,
  Database,
  CloudLightning,
  Video,
  Trash2,
  Plus,
  RefreshCw,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Play,
  Square
} from 'lucide-react';

interface Court {
  id: string;
  name: string;
  rtsp_url_key: string;
  created_at: string;
}

interface Match {
  id: string;
  court_id: string;
  start_time: string;
  end_time: string;
  status: 'SCHEDULED' | 'RECORDING' | 'UPLOADING' | 'DONE' | 'FAILED';
  video_key: string | null;
  player_phone: string;
  player_name: string;
  error_log: string | null;
  courts?: {
    name: string;
  };
}

interface ActiveRecording {
  matchId: string;
  elapsedSeconds: number;
  durationSeconds: number;
}

interface ActiveUpload {
  matchId: string;
  percentage: number;
}

function App(): React.JSX.Element {
  const [activeTab, setActiveTab] = useState<'dashboard' | 'scheduler' | 'config'>('dashboard');
  const [ffmpegStatus, setFfmpegStatus] = useState<{ path: string; exists: boolean }>({ path: '', exists: false });
  const [configError, setConfigError] = useState<string | null>(null);
  
  // Database States
  const [courts, setCourts] = useState<Court[]>([]);
  const [matches, setMatches] = useState<Match[]>([]);
  const [loadingDb, setLoadingDb] = useState(false);

  // Active Process States (updated via IPC)
  const [activeRecordings, setActiveRecordings] = useState<Record<string, ActiveRecording>>({});
  const [activeUploads, setActiveUploads] = useState<Record<string, ActiveUpload>>({});

  // Form States
  const [newMatch, setNewMatch] = useState({
    court_id: '',
    date: new Date().toISOString().split('T')[0],
    time: '18:00',
    duration: '90', // minutes
    player_name: '',
    player_phone: ''
  });

  const [newCourt, setNewCourt] = useState({
    name: '',
    rtsp_url: ''
  });

  // Config States
  const [config, setConfig] = useState({
    SUPABASE_URL: '',
    SUPABASE_SERVICE_ROLE_KEY: '',
    SUPABASE_KEY: '',
    R2_ACCESS_KEY_ID: '',
    R2_SECRET_ACCESS_KEY: '',
    R2_ENDPOINT: '',
    R2_BUCKET_NAME: 'padelview-matches'
  });

  // RTSP URLs per court (saved in vault)
  const [courtRtspUrls, setCourtRtspUrls] = useState<Record<string, string>>({});

  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' | 'info' | 'warning' } | null>(null);

  // Show temporary toast
  const showToast = (message: string, type: 'success' | 'error' | 'info' | 'warning' = 'info') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 4000);
  };

  // Fetch all initial data
  const fetchData = async () => {
    setLoadingDb(true);
    try {
      // Check FFmpeg
      const ffmpeg = await window.electron.ipcRenderer.invoke('ffmpeg:check');
      setFfmpegStatus(ffmpeg);

      // Load Config
      const savedConfig = await window.electron.ipcRenderer.invoke('config:get');
      setConfig(savedConfig);

      // Load database records
      const courtsRes = await window.electron.ipcRenderer.invoke('db:get-courts');
      if (courtsRes.success) {
        setCourts(courtsRes.data);
        
        // Fetch RTSP urls for courts
        const rtspDict: Record<string, string> = {};
        for (const c of courtsRes.data) {
          const url = await window.electron.ipcRenderer.invoke('config:get-rtsp', c.id);
          rtspDict[c.id] = url || c.rtsp_url_key;
        }
        setCourtRtspUrls(rtspDict);
      } else {
        if (courtsRes.error.includes('configuration missing')) {
          setConfigError('Por favor configura Supabase y Cloudflare R2 para comenzar.');
        }
      }

      const matchesRes = await window.electron.ipcRenderer.invoke('db:get-matches');
      if (matchesRes.success) {
        setMatches(matchesRes.data);
        setConfigError(null);
      }
    } catch (err) {
      console.error('Error fetching dashboard data:', err);
    } finally {
      setLoadingDb(false);
    }
  };

  useEffect(() => {
    fetchData();

    // Listen to real-time events from scheduler/main process
    const handleRecProgress = (_event: any, data: ActiveRecording) => {
      setActiveRecordings(prev => ({
        ...prev,
        [data.matchId]: data
      }));
    };

    const handleUploadProgress = (_event: any, data: ActiveUpload) => {
      setActiveUploads(prev => ({
        ...prev,
        [data.matchId]: data
      }));
    };

    const handleMatchUpdated = (_event: any) => {
      fetchData();
    };

    const handleConfigError = (_event: any, msg: string) => {
      setConfigError(msg);
    };

    window.electron.ipcRenderer.on('recording-progress', handleRecProgress);
    window.electron.ipcRenderer.on('upload-progress', handleUploadProgress);
    window.electron.ipcRenderer.on('match-updated', handleMatchUpdated);
    window.electron.ipcRenderer.on('config-error', handleConfigError);

    return () => {
      // Clean listeners
      window.electron.ipcRenderer.removeAllListeners('recording-progress');
      window.electron.ipcRenderer.removeAllListeners('upload-progress');
      window.electron.ipcRenderer.removeAllListeners('match-updated');
      window.electron.ipcRenderer.removeAllListeners('config-error');
    };
  }, []);

  // Save general configuration
  const handleSaveConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    const res = await window.electron.ipcRenderer.invoke('config:save', config);
    if (res.success) {
      showToast('Configuración guardada exitosamente.', 'success');
      fetchData();
    } else {
      showToast(`Error al guardar: ${res.error}`, 'error');
    }
  };

  // Save specific court RTSP url
  const handleSaveCourtRtsp = async (courtId: string, url: string) => {
    const res = await window.electron.ipcRenderer.invoke('config:save-rtsp', courtId, url);
    if (res.success) {
      setCourtRtspUrls(prev => ({ ...prev, [courtId]: url }));
      showToast('URL RTSP de la cancha guardada.', 'success');
    } else {
      showToast(`Error al guardar RTSP: ${res.error}`, 'error');
    }
  };

  // Create new court
  const handleCreateCourt = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newCourt.name) return;

    const res = await window.electron.ipcRenderer.invoke('db:create-court', newCourt.name, newCourt.rtsp_url);
    if (res.success) {
      showToast('Cancha agregada exitosamente.', 'success');
      setNewCourt({ name: '', rtsp_url: '' });
      fetchData();
    } else {
      showToast(`Error: ${res.error}`, 'error');
    }
  };

  // Create new scheduled match
  const handleCreateMatch = async (e: React.FormEvent) => {
    e.preventDefault();
    const { court_id, date, time, duration, player_name, player_phone } = newMatch;
    if (!court_id || !date || !time || !player_name || !player_phone) {
      showToast('Por favor completa todos los campos del partido.', 'error');
      return;
    }

    const startTime = new Date(`${date}T${time}:00`);
    const endTime = new Date(startTime.getTime() + parseInt(duration) * 60000);

    const res = await window.electron.ipcRenderer.invoke('db:create-match', {
      court_id,
      start_time: startTime.toISOString(),
      end_time: endTime.toISOString(),
      player_name,
      player_phone
    });

    if (res.success) {
      showToast('Partido agendado correctamente.', 'success');
      setNewMatch({
        court_id: courts[0]?.id || '',
        date: new Date().toISOString().split('T')[0],
        time: '18:00',
        duration: '90',
        player_name: '',
        player_phone: ''
      });
      fetchData();
    } else {
      showToast(`Error al agendar partido: ${res.error}`, 'error');
    }
  };

  // Delete match
  const handleDeleteMatch = async (matchId: string) => {
    if (!confirm('¿Estás seguro de que deseas eliminar este partido?')) return;
    const res = await window.electron.ipcRenderer.invoke('db:delete-match', matchId);
    if (res.success) {
      showToast('Partido eliminado.', 'success');
      fetchData();
    } else {
      showToast(`Error: ${res.error}`, 'error');
    }
  };

  // Stop/Kill active recording manually
  const handleKillRecording = async (matchId: string) => {
    if (!confirm('¿Detener esta grabación manualmente? Se subirá el video parcial obtenido hasta el momento.')) return;
    const res = await window.electron.ipcRenderer.invoke('recordings:kill', matchId);
    if (res.success) {
      showToast('Grabación detenida. Iniciando procesamiento...', 'info');
      setActiveRecordings(prev => {
        const copy = { ...prev };
        delete copy[matchId];
        return copy;
      });
      fetchData();
    } else {
      showToast('No se pudo detener la grabación.', 'error');
    }
  };

  // Cancel active upload manually
  const handleCancelUpload = async (matchId: string) => {
    if (!confirm('¿Cancelar la subida de este video?')) return;
    const res = await window.electron.ipcRenderer.invoke('uploads:cancel', matchId);
    if (res.success) {
      showToast('Subida cancelada.', 'warning');
      setActiveUploads(prev => {
        const copy = { ...prev };
        delete copy[matchId];
        return copy;
      });
      fetchData();
    }
  };

  // Helper to format remaining time
  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  return (
    <div className="app-container">
      {/* Sidebar Navigation */}
      <aside className="sidebar">
        <div className="brand">
          <div className="logo-icon">PV</div>
          <h2>PadelView</h2>
          <span className="badge">MVP</span>
        </div>

        <nav className="nav-menu">
          <button
            className={`nav-item ${activeTab === 'dashboard' ? 'active' : ''}`}
            onClick={() => setActiveTab('dashboard')}
          >
            <Activity size={18} />
            <span>Monitoreo</span>
          </button>
          <button
            className={`nav-item ${activeTab === 'scheduler' ? 'active' : ''}`}
            onClick={() => setActiveTab('scheduler')}
          >
            <Calendar size={18} />
            <span>Agenda</span>
          </button>
          <button
            className={`nav-item ${activeTab === 'config' ? 'active' : ''}`}
            onClick={() => setActiveTab('config')}
          >
            <Settings size={18} />
            <span>Configuración</span>
          </button>
        </nav>

        <div className="ffmpeg-status-card">
          <div className="card-header">
            <Video size={16} className={ffmpegStatus.exists ? 'text-primary' : 'text-danger'} />
            <h4>Estado FFmpeg</h4>
          </div>
          <div className="card-body">
            {ffmpegStatus.exists ? (
              <span className="status-indicator success">
                <CheckCircle2 size={12} /> Instalado
              </span>
            ) : (
              <span className="status-indicator error">
                <XCircle size={12} /> Faltante
              </span>
            )}
            <p className="binary-path" title={ffmpegStatus.path}>
              {ffmpegStatus.path || 'No resuelto'}
            </p>
          </div>
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
              {activeTab === 'config' && 'Ajustes del Sistema'}
            </h1>
            <p className="text-secondary">Club Sportivo Belgrano - Operación Local</p>
          </div>
          <button className="btn btn-secondary btn-icon" onClick={fetchData} disabled={loadingDb}>
            <RefreshCw size={16} className={loadingDb ? 'spin' : ''} />
            <span>Sincronizar</span>
          </button>
        </header>

        {/* Global Warnings */}
        {configError && (
          <div className="banner danger animate-pulse">
            <AlertTriangle size={20} />
            <div className="banner-text">
              <strong>Error de Configuración:</strong> {configError}
            </div>
            <button className="btn btn-sm btn-outline-danger" onClick={() => setActiveTab('config')}>
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
                      <button className="btn btn-primary btn-sm" onClick={() => setActiveTab('scheduler')}>
                        Registrar una Cancha
                      </button>
                    </div>
                  ) : (
                    <div className="court-cards">
                      {courts.map(court => {
                        // Find if court is currently recording
                        const activeMatch = matches.find(
                          m => m.court_id === court.id && m.status === 'RECORDING'
                        );
                        
                        const isRecording = activeMatch !== undefined;
                        const progress = activeMatch ? activeRecordings[activeMatch.id] : null;

                        return (
                          <div key={court.id} className={`court-card ${isRecording ? 'recording' : ''}`}>
                            <div className="court-card-header">
                              <h3>{court.name}</h3>
                              {isRecording ? (
                                <span className="badge-live animate-pulse-fast">
                                  ● GRABANDO
                                </span>
                              ) : (
                                <span className="badge-idle">DISPONIBLE</span>
                              )}
                            </div>
                            <div className="court-card-body">
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
                                        {progress ? formatTime(progress.durationSeconds) : 'Calculando...'}
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
                                <div className="idle-state">
                                  <Play size={24} className="text-muted" />
                                  <p className="text-secondary text-sm">Esperando partido programado...</p>
                                  <span className="rtsp-endpoint" title={courtRtspUrls[court.id]}>
                                    RTSP: {courtRtspUrls[court.id] ? courtRtspUrls[court.id].substring(0, 30) + '...' : 'No configurado'}
                                  </span>
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* Subiendo / Subidas Recientes Panel */}
                <div className="uploads-panel">
                  <h3 className="section-title">Subidas a la Nube (R2)</h3>
                  <div className="upload-list card-pane">
                    {matches.filter(m => m.status === 'UPLOADING').length === 0 ? (
                      <div className="empty-sub-state">
                        <CloudLightning size={24} className="text-muted" />
                        <p className="text-muted text-sm">No hay subidas activas en este momento.</p>
                      </div>
                    ) : (
                      matches
                        .filter(m => m.status === 'UPLOADING')
                        .map(match => {
                          const upload = activeUploads[match.id];
                          const percent = upload ? upload.percentage : 0;
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
                          );
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
                        <th>Archivo Cloud</th>
                        <th>Acción</th>
                      </tr>
                    </thead>
                    <tbody>
                      {matches.length === 0 ? (
                        <tr>
                          <td colSpan={6} className="text-center text-muted">
                            No hay grabaciones registradas para hoy.
                          </td>
                        </tr>
                      ) : (
                        matches.map(match => (
                          <tr key={match.id}>
                            <td><strong>{match.courts?.name}</strong></td>
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
                                {match.status}
                              </span>
                            </td>
                            <td className="font-mono text-xs">
                              {match.video_key ? (
                                <span className="text-success" title={match.video_key}>
                                  {match.video_key.substring(0, 40)}...
                                </span>
                              ) : (
                                <span className="text-muted">-</span>
                              )}
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

          {/* 2. SCHEDULER */}
          {activeTab === 'scheduler' && (
            <div className="scheduler-view">
              <div className="scheduler-grid">
                {/* Form to Schedule a Recording */}
                <div className="card-pane">
                  <h3 className="card-title">Agendar Nueva Grabación</h3>
                  <form onSubmit={handleCreateMatch} className="form-grid">
                    <div className="form-group">
                      <label>Cancha</label>
                      <select
                        value={newMatch.court_id}
                        onChange={e => setNewMatch({ ...newMatch, court_id: e.target.value })}
                        required
                      >
                        <option value="">Selecciona Cancha...</option>
                        {courts.map(c => (
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
                          onChange={e => setNewMatch({ ...newMatch, date: e.target.value })}
                          required
                        />
                      </div>
                      <div className="form-group">
                        <label>Hora Inicio</label>
                        <input
                          type="time"
                          value={newMatch.time}
                          onChange={e => setNewMatch({ ...newMatch, time: e.target.value })}
                          required
                        />
                      </div>
                    </div>

                    <div className="form-group">
                      <label>Duración del Partido</label>
                      <select
                        value={newMatch.duration}
                        onChange={e => setNewMatch({ ...newMatch, duration: e.target.value })}
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
                        onChange={e => setNewMatch({ ...newMatch, player_name: e.target.value })}
                        required
                      />
                    </div>

                    <div className="form-group">
                      <label>Número de WhatsApp (con código de país)</label>
                      <input
                        type="text"
                        placeholder="Ej. +5493564123456"
                        value={newMatch.player_phone}
                        onChange={e => setNewMatch({ ...newMatch, player_phone: e.target.value })}
                        required
                      />
                    </div>

                    <button type="submit" className="btn btn-primary btn-block">
                      <Plus size={16} /> Programar Grabación
                    </button>
                  </form>
                </div>

                {/* Form to Create/Add Court */}
                <div className="card-pane">
                  <h3 className="card-title">Registrar Nueva Cancha</h3>
                  <form onSubmit={handleCreateCourt} className="form-grid">
                    <div className="form-group">
                      <label>Nombre de la Cancha</label>
                      <input
                        type="text"
                        placeholder="Ej. Cancha Central (Vidrio)"
                        value={newCourt.name}
                        onChange={e => setNewCourt({ ...newCourt, name: e.target.value })}
                        required
                      />
                    </div>

                    <div className="form-group">
                      <label>Stream RTSP por Defecto</label>
                      <input
                        type="text"
                        placeholder="rtsp://usuario:contraseña@ip:puerto/h264"
                        value={newCourt.rtsp_url}
                        onChange={e => setNewCourt({ ...newCourt, rtsp_url: e.target.value })}
                      />
                      <span className="input-hint">
                        Puedes configurarla o encriptarla de forma segura en la sección de configuración.
                      </span>
                    </div>

                    <button type="submit" className="btn btn-secondary btn-block">
                      <Plus size={16} /> Registrar Cancha
                    </button>
                  </form>
                </div>
              </div>

              {/* Courts Configuration list */}
              <div className="dashboard-table-section">
                <h3 className="section-title">Canchas Registradas en el Club</h3>
                <div className="table-responsive card-pane">
                  <table>
                    <thead>
                      <tr>
                        <th>Nombre</th>
                        <th>RTSP Key</th>
                        <th>RTSP URL Configurada (Vault)</th>
                        <th>Fecha Registro</th>
                      </tr>
                    </thead>
                    <tbody>
                      {courts.length === 0 ? (
                        <tr>
                          <td colSpan={4} className="text-center text-muted">
                            No hay canchas registradas.
                          </td>
                        </tr>
                      ) : (
                        courts.map(c => (
                          <tr key={c.id}>
                            <td><strong>{c.name}</strong></td>
                            <td className="font-mono text-xs">{c.rtsp_url_key || '-'}</td>
                            <td>
                              <input
                                type="text"
                                className="table-input"
                                value={courtRtspUrls[c.id] || ''}
                                placeholder="Cargar RTSP segura..."
                                onChange={e =>
                                  setCourtRtspUrls({ ...courtRtspUrls, [c.id]: e.target.value })
                                }
                                onBlur={e => handleSaveCourtRtsp(c.id, e.target.value)}
                              />
                            </td>
                            <td className="text-secondary text-sm">
                              {new Date(c.created_at).toLocaleDateString()}
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

          {/* 3. CONFIGURATION */}
          {activeTab === 'config' && (
            <div className="config-view">
              <form onSubmit={handleSaveConfig} className="config-form form-grid">
                {/* Supabase Card */}
                <div className="card-pane">
                  <h3 className="card-title">
                    <Database size={16} className="text-primary" /> Credenciales Supabase
                  </h3>
                  <div className="form-group">
                    <label>Supabase URL</label>
                    <input
                      type="text"
                      placeholder="https://xxxx.supabase.co"
                      value={config.SUPABASE_URL}
                      onChange={e => setConfig({ ...config, SUPABASE_URL: e.target.value })}
                      required
                    />
                  </div>
                  <div className="form-group">
                    <label>Supabase Service Role Key (Para Escritura Local)</label>
                    <input
                      type="password"
                      placeholder="Service role key (encriptado localmente)"
                      value={config.SUPABASE_SERVICE_ROLE_KEY}
                      onChange={e =>
                        setConfig({ ...config, SUPABASE_SERVICE_ROLE_KEY: e.target.value })
                      }
                    />
                    <span className="input-hint">
                      Se almacena de forma encriptada en la PC mediante safeStorage de Electron.
                    </span>
                  </div>
                  <div className="form-group">
                    <label>Supabase Public Anon Key</label>
                    <input
                      type="password"
                      placeholder="Anon key"
                      value={config.SUPABASE_KEY}
                      onChange={e => setConfig({ ...config, SUPABASE_KEY: e.target.value })}
                    />
                  </div>
                </div>

                {/* Cloudflare R2 Card */}
                <div className="card-pane">
                  <h3 className="card-title">
                    <CloudLightning size={16} className="text-primary" /> Almacenamiento Cloudflare R2
                  </h3>
                  <div className="form-group">
                    <label>R2 Endpoint URL</label>
                    <input
                      type="text"
                      placeholder="https://<account-id>.r2.cloudflarestorage.com"
                      value={config.R2_ENDPOINT}
                      onChange={e => setConfig({ ...config, R2_ENDPOINT: e.target.value })}
                      required
                    />
                  </div>
                  <div className="form-group">
                    <label>R2 Access Key ID</label>
                    <input
                      type="text"
                      placeholder="Access Key ID"
                      value={config.R2_ACCESS_KEY_ID}
                      onChange={e => setConfig({ ...config, R2_ACCESS_KEY_ID: e.target.value })}
                      required
                    />
                  </div>
                  <div className="form-group">
                    <label>R2 Secret Access Key</label>
                    <input
                      type="password"
                      placeholder="Secret Access Key"
                      value={config.R2_SECRET_ACCESS_KEY}
                      onChange={e => setConfig({ ...config, R2_SECRET_ACCESS_KEY: e.target.value })}
                      required
                    />
                  </div>
                  <div className="form-group">
                    <label>R2 Bucket Name</label>
                    <input
                      type="text"
                      value={config.R2_BUCKET_NAME}
                      onChange={e => setConfig({ ...config, R2_BUCKET_NAME: e.target.value })}
                      required
                    />
                  </div>
                </div>

                <div className="form-actions">
                  <button type="submit" className="btn btn-primary">
                    Guardar Todas las Credenciales
                  </button>
                </div>
              </form>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

export default App;
