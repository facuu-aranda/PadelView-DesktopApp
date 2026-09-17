import { useEffect, useMemo, useRef, useState } from 'react'
import { CheckCircle2, Eye, Loader2, RefreshCw, Video, XCircle } from 'lucide-react'
import type {
  LocalRecorder,
  RecorderChannel,
  RecorderSource,
  RecorderVendor
} from '../../../shared/video-source'
import VideoSourcePreview from './VideoSourcePreview'

interface RecorderSetupModalProps {
  isOpen: boolean
  profileId: string
  onClose: () => void
  onSelectSource: (source: RecorderSource) => void
}

type WizardStep = 'connect' | 'discovering' | 'channels' | 'error'

interface RecorderForm {
  name: string
  host: string
  username: string
  password: string
  vendor: RecorderVendor
  httpPort: string
  httpsPort: string
  rtspPort: string
  maxChannels: string
}

const INITIAL_FORM: RecorderForm = {
  name: 'DVR / NVR',
  host: '',
  username: 'admin',
  password: '',
  vendor: 'unknown',
  httpPort: '80',
  httpsPort: '443',
  rtspPort: '554',
  maxChannels: '16'
}

export default function RecorderSetupModal({
  isOpen,
  profileId,
  onClose,
  onSelectSource
}: RecorderSetupModalProps): React.JSX.Element | null {
  const [step, setStep] = useState<WizardStep>('connect')
  const [form, setForm] = useState<RecorderForm>(INITIAL_FORM)
  const [recorders, setRecorders] = useState<LocalRecorder[]>([])
  const [recorderId, setRecorderId] = useState<string | null>(null)
  const [channels, setChannels] = useState<RecorderChannel[]>([])
  const [snapshots, setSnapshots] = useState<Record<string, string>>({})
  const [selectedChannel, setSelectedChannel] = useState<RecorderChannel | null>(null)
  const [manualRtsp, setManualRtsp] = useState('')
  const [advanced, setAdvanced] = useState(false)
  const [progress, setProgress] = useState(0)
  const [progressLabel, setProgressLabel] = useState('Conectando al grabador...')
  const [error, setError] = useState<string | null>(null)
  const [testingChannelId, setTestingChannelId] = useState<string | null>(null)
  const [testedChannelId, setTestedChannelId] = useState<string | null>(null)
  const requestIdRef = useRef<string | null>(null)

  useEffect(() => {
    if (!isOpen || !window.electron) return
    setStep('connect')
    setError(null)
    setChannels([])
    setSnapshots({})
    setSelectedChannel(null)
    setManualRtsp('')
    setRecorderId(null)
    setProgress(0)
    setForm(INITIAL_FORM)

    const loadRecorders = async (): Promise<void> => {
      const result = await window.electron.ipcRenderer.invoke('recorders:list', profileId)
      if (result.success) setRecorders(result.data || [])
    }
    void loadRecorders()

    const handleProgress = (
      _event: unknown,
      data: { requestId: string; phase: string; percent: number; found?: RecorderChannel[] }
    ) => {
      if (data.requestId !== requestIdRef.current) return
      setProgress(data.percent)
      setProgressLabel(progressLabelFor(data.phase))
      if (data.found?.length) setChannels(data.found)
    }
    window.electron.ipcRenderer.on('recorders:progress', handleProgress)
    return () => {
      window.electron.ipcRenderer.removeAllListeners('recorders:progress')
    }
  }, [isOpen, profileId])

  const previewSource = useMemo<RecorderSource | undefined>(() => {
    if (!recorderId || !selectedChannel) return undefined
    return {
      type: 'recorder',
      recorderId,
      channelId: selectedChannel.id,
      channelNumber: selectedChannel.number,
      stream: 'main',
      streamPaths: selectedChannel.streamIds
    }
  }, [recorderId, selectedChannel])

  if (!isOpen) return null

  const updateForm = <Key extends keyof RecorderForm>(key: Key, value: RecorderForm[Key]) => {
    setForm((current) => ({ ...current, [key]: value }))
  }

  const loadSnapshots = async (
    activeRecorderId: string,
    discoveredChannels: RecorderChannel[]
  ): Promise<void> => {
    if (!window.electron) return
    setProgressLabel('Generando vistas previas...')
    const entries = await Promise.all(
      discoveredChannels.map(async (channel) => {
        const result = await window.electron.ipcRenderer.invoke('recorders:get-snapshot', {
          recorderId: activeRecorderId,
          profileId,
          channel
        })
        if (!result.success || !result.data) return null
        return [
          channel.id,
          `data:${String(result.contentType || 'image/jpeg')};base64,${String(result.data)}`
        ] as [string, string]
      })
    )
    const validEntries = entries.filter((entry): entry is [string, string] => entry !== null)
    setSnapshots(Object.fromEntries(validEntries))
  }

  const discover = async (activeRecorderId: string): Promise<void> => {
    if (!window.electron) return
    const requestId = `recorder-discovery-${Date.now()}`
    requestIdRef.current = requestId
    setRecorderId(activeRecorderId)
    setStep('discovering')
    setError(null)
    setProgress(5)
    setProgressLabel('Conectando al grabador...')

    const result = await window.electron.ipcRenderer.invoke('recorders:discover', {
      recorderId: activeRecorderId,
      profileId,
      requestId,
      maxChannels: advanced ? Number(form.maxChannels) || 16 : 16,
      timeoutMs: 5000
    })

    if (!result.success) {
      setStep('error')
      setError(toFriendlyError(result.error))
      return
    }

    const discoveredChannels = (result.data.channels || []) as RecorderChannel[]
    setChannels(discoveredChannels)
    setStep('channels')
    setProgress(100)
    setProgressLabel(
      `${discoveredChannels.length} canal${discoveredChannels.length === 1 ? '' : 'es'} detectado${discoveredChannels.length === 1 ? '' : 's'}`
    )
    await loadSnapshots(activeRecorderId, discoveredChannels)
  }

  const handleConnect = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!window.electron) return
    setError(null)

    try {
      const result = await window.electron.ipcRenderer.invoke('recorders:create', {
        profileId,
        name: form.name,
        host: form.host,
        username: form.username,
        password: form.password,
        vendor: form.vendor,
        httpPort: Number(form.httpPort) || 80,
        httpsPort: Number(form.httpsPort) || 443,
        rtspPort: Number(form.rtspPort) || 554
      })
      if (!result.success) {
        setError(toFriendlyError(result.error))
        return
      }
      await discover(result.data.id)
    } catch (connectionError) {
      setError(toFriendlyError((connectionError as Error).message))
    }
  }

  const handleUseExisting = async (recorder: LocalRecorder) => {
    setForm((current) => ({
      ...current,
      name: recorder.name,
      host: recorder.host,
      vendor: recorder.vendor,
      httpPort: String(recorder.httpPort || 80),
      httpsPort: String(recorder.httpsPort || 443),
      rtspPort: String(recorder.rtspPort || 554)
    }))
    await discover(recorder.id)
  }

  const handleCancelDiscovery = async () => {
    if (requestIdRef.current && window.electron) {
      await window.electron.ipcRenderer.invoke('recorders:cancel', requestIdRef.current)
    }
    requestIdRef.current = null
    setStep('connect')
    setProgress(0)
  }

  const handleTestChannel = async (channel: RecorderChannel) => {
    if (!recorderId || !window.electron) return
    setTestingChannelId(channel.id)
    setTestedChannelId(null)
    const result = await window.electron.ipcRenderer.invoke('recorders:test-channel', {
      recorderId,
      profileId,
      channel,
      stream: 'main'
    })
    setTestingChannelId(null)
    if (result.success) {
      setTestedChannelId(channel.id)
      setSelectedChannel(channel)
    } else {
      setError(toFriendlyError(result.error))
    }
  }

  const handleUseManualRtsp = async () => {
    if (!recorderId || !manualRtsp.trim() || !window.electron) return
    const result = await window.electron.ipcRenderer.invoke('recorders:save-manual-source', {
      recorderId,
      profileId,
      url: manualRtsp.trim()
    })
    if (!result.success) {
      setError(toFriendlyError(result.error))
      return
    }
    onSelectSource(result.source)
    onClose()
  }

  const handleUseChannel = () => {
    if (!recorderId || !selectedChannel || selectedChannel.mainStreamAvailable === false) return
    onSelectSource({
      type: 'recorder',
      recorderId,
      channelId: selectedChannel.id,
      channelNumber: selectedChannel.number,
      stream: 'main',
      streamPaths: selectedChannel.streamIds
    })
    onClose()
  }

  const handleClose = () => {
    if (step === 'discovering') void handleCancelDiscovery()
    onClose()
  }

  return (
    <div className="modal-overlay" onClick={handleClose}>
      <div
        className="modal-content"
        onClick={(event) => event.stopPropagation()}
        style={{ width: '900px', maxWidth: '94vw', maxHeight: '90vh', overflowY: 'auto' }}
      >
        <button className="modal-close-btn" onClick={handleClose} type="button">
          <XCircle size={20} />
        </button>

        <h3 className="card-title" style={{ marginBottom: '6px' }}>
          Conectar DVR / NVR
        </h3>
        <p className="text-muted text-sm" style={{ marginBottom: '20px' }}>
          ViewPadel se conecta al grabador y enumera sus canales. Las cámaras detrás de una red PoE
          interna no necesitan una IP propia.
        </p>

        {step === 'connect' || step === 'error' ? (
          <>
            {recorders.length > 0 && (
              <div className="card-pane" style={{ marginBottom: '18px', padding: '14px' }}>
                <strong style={{ display: 'block', marginBottom: '10px' }}>
                  Grabadores configurados
                </strong>
                <div style={{ display: 'grid', gap: '8px' }}>
                  {recorders.map((recorder) => (
                    <div
                      key={recorder.id}
                      style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px' }}
                    >
                      <div>
                        <strong>{recorder.name}</strong>
                        <div className="text-muted text-xs">
                          {recorder.host} · {recorder.vendor === 'unknown' ? 'Fabricante no detectado' : recorder.vendor}
                        </div>
                      </div>
                      <button className="btn btn-secondary btn-sm" type="button" onClick={() => handleUseExisting(recorder)}>
                        Usar este grabador
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <form className="form-grid" onSubmit={handleConnect}>
              <div className="scanner-field-grid">
                <div className="form-group">
                  <label>Nombre</label>
                  <input value={form.name} onChange={(event) => updateForm('name', event.target.value)} required />
                </div>
                <div className="form-group">
                  <label>Dirección / IP</label>
                  <input
                    value={form.host}
                    onChange={(event) => updateForm('host', event.target.value)}
                    placeholder="192.168.1.100"
                    required
                  />
                </div>
              </div>

              <div className="scanner-field-grid">
                <div className="form-group">
                  <label>Usuario</label>
                  <input value={form.username} onChange={(event) => updateForm('username', event.target.value)} required />
                </div>
                <div className="form-group">
                  <label>Contraseña</label>
                  <input
                    type="password"
                    value={form.password}
                    onChange={(event) => updateForm('password', event.target.value)}
                    placeholder="Contraseña del grabador"
                    required
                  />
                </div>
              </div>

              <div className="form-group">
                <button className="btn btn-secondary btn-sm" type="button" onClick={() => setAdvanced((value) => !value)}>
                  {advanced ? 'Ocultar opciones avanzadas' : 'Mostrar opciones avanzadas'}
                </button>
              </div>

              {advanced && (
                <div className="scanner-field-grid">
                  <div className="form-group">
                    <label>Fabricante</label>
                    <select value={form.vendor} onChange={(event) => updateForm('vendor', event.target.value as RecorderVendor)}>
                      <option value="unknown">Detectar automáticamente</option>
                      <option value="hikvision">Hikvision</option>
                      <option value="dahua">Dahua</option>
                      <option value="generic">Genérico</option>
                    </select>
                  </div>
                  <div className="form-group">
                    <label>Máximo de canales</label>
                    <select value={form.maxChannels} onChange={(event) => updateForm('maxChannels', event.target.value)}>
                      {[4, 8, 16, 32, 64].map((value) => <option key={value} value={value}>{value}</option>)}
                    </select>
                  </div>
                  <div className="form-group">
                    <label>Puerto HTTP</label>
                    <input type="number" min="1" max="65535" value={form.httpPort} onChange={(event) => updateForm('httpPort', event.target.value)} />
                  </div>
                  <div className="form-group">
                    <label>Puerto RTSP</label>
                    <input type="number" min="1" max="65535" value={form.rtspPort} onChange={(event) => updateForm('rtspPort', event.target.value)} />
                  </div>
                </div>
              )}

              {error && <div className="banner danger"><span>{error}</span></div>}

              <button className="btn btn-primary btn-block" type="submit">
                <Video size={16} /> Conectar y detectar canales
              </button>
            </form>
          </>
        ) : step === 'discovering' ? (
          <div style={{ padding: '40px 16px', textAlign: 'center' }}>
            <Loader2 size={36} className="anim-spin" style={{ color: 'var(--color-primary)' }} />
            <h4 style={{ margin: '16px 0 8px' }}>{progressLabel}</h4>
            <p className="text-muted text-sm">No cierres esta ventana mientras validamos los streams.</p>
            <div className="scanner-progress-bar-bg" style={{ margin: '20px auto', maxWidth: '560px' }}>
              <div className="scanner-progress-bar-fill" style={{ width: `${progress}%` }} />
            </div>
            <span className="text-muted text-xs">{progress}%</span>
            <div style={{ marginTop: '24px' }}>
              <button className="btn btn-secondary" type="button" onClick={handleCancelDiscovery}>
                Cancelar búsqueda
              </button>
            </div>
          </div>
        ) : (
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', marginBottom: '16px' }}>
              <div>
                <strong>{progressLabel}</strong>
                <div className="text-muted text-xs">Elegí el canal que corresponde a esta cancha.</div>
              </div>
              <button className="btn btn-secondary btn-sm" type="button" onClick={() => recorderId && discover(recorderId)}>
                <RefreshCw size={14} /> Volver a buscar
              </button>
            </div>

            {channels.length === 0 ? (
              <div className="card-pane" style={{ padding: '18px', marginBottom: '16px' }}>
                <strong>No se detectaron canales automáticamente.</strong>
                <p className="text-muted text-sm">Podés configurar una URL RTSP manual como último recurso.</p>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <input
                    style={{ flex: 1 }}
                    value={manualRtsp}
                    onChange={(event) => setManualRtsp(event.target.value)}
                    placeholder="rtsp://usuario:contraseña@grabador/canal"
                  />
                  <button className="btn btn-secondary" type="button" disabled={!manualRtsp.trim()} onClick={handleUseManualRtsp}>
                    Usar URL
                  </button>
                </div>
              </div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))', gap: '12px' }}>
                {channels.map((channel) => {
                  const isSelected = selectedChannel?.id === channel.id
                  const isTesting = testingChannelId === channel.id
                  return (
                    <div
                      key={channel.id}
                      className="card-pane"
                      style={{ padding: '10px', borderColor: isSelected ? 'var(--color-primary)' : undefined }}
                    >
                      <div style={{ aspectRatio: '16/9', background: '#111827', borderRadius: '8px', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
                        {snapshots[channel.id] ? (
                          <img src={snapshots[channel.id]} alt={`Snapshot ${channel.name || channel.id}`} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                        ) : (
                          <span className="text-muted text-xs">Vista previa no disponible</span>
                        )}
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', marginTop: '10px' }}>
                        <div>
                          <strong>{channel.name || `Canal ${channel.number || ''}`}</strong>
                          <div className="text-muted text-xs">{channel.mainStreamAvailable === false ? 'Principal no disponible' : 'Principal disponible'}</div>
                        </div>
                        {isSelected && <CheckCircle2 size={18} style={{ color: 'var(--color-primary)' }} />}
                      </div>
                      <div style={{ display: 'flex', gap: '6px', marginTop: '10px' }}>
                        <button className="btn btn-secondary btn-sm" type="button" disabled={isTesting || channel.mainStreamAvailable === false} onClick={() => handleTestChannel(channel)}>
                          {isTesting ? <Loader2 size={13} className="anim-spin" /> : <Eye size={13} />} Probar
                        </button>
                        <button className="btn btn-primary btn-sm" type="button" disabled={channel.mainStreamAvailable === false} onClick={() => setSelectedChannel(channel)}>
                          Seleccionar
                        </button>
                      </div>
                      {testedChannelId === channel.id && <div className="text-success text-xs" style={{ marginTop: '6px' }}>Stream validado.</div>}
                    </div>
                  )
                })}
              </div>
            )}

            {selectedChannel && recorderId && (
              <div style={{ marginTop: '18px' }}>
                <strong style={{ display: 'block', marginBottom: '8px' }}>Preview del canal seleccionado</strong>
                {previewSource && <VideoSourcePreview courtId={`recorder-preview-${recorderId}`} profileId={profileId} source={previewSource} compact />}
              </div>
            )}

            {error && <div className="banner danger" style={{ marginTop: '14px' }}><span>{error}</span></div>}

            <div className="scanner-actions" style={{ marginTop: '20px', paddingTop: '14px', borderTop: '1px solid var(--color-border)' }}>
              <button className="btn btn-secondary" type="button" onClick={handleClose}>Cancelar</button>
              <button className="btn btn-primary" type="button" disabled={!selectedChannel} onClick={handleUseChannel}>Usar canal seleccionado</button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function progressLabelFor(phase: string): string {
  if (phase === 'detecting') return 'Identificando fabricante...'
  if (phase === 'loading-channels') return 'Consultando canales...'
  if (phase === 'probing') return 'Validando streams RTSP...'
  if (phase === 'loading-previews') return 'Generando vistas previas...'
  return 'Conectando al grabador...'
}

function toFriendlyError(message: string | undefined): string {
  const normalized = (message || '').toLowerCase()
  if (normalized.includes('credencial') || normalized.includes('autenticar') || normalized.includes('401')) {
    return 'No pudimos autenticar en el DVR/NVR. Verificá el usuario y la contraseña.'
  }
  if (normalized.includes('timeout') || normalized.includes('tiempo')) {
    return 'El grabador no respondió a tiempo.'
  }
  if (normalized.includes('conectar') || normalized.includes('econnrefused')) {
    return 'No pudimos conectarnos con el grabador.'
  }
  return message || 'No pudimos detectar los canales del grabador.'
}
