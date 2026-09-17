import { useEffect, useMemo, useState } from 'react'
import { CheckCircle2, HelpCircle, Plus, RefreshCw, Video, XCircle } from 'lucide-react'

interface CameraScannerModalProps {
  isOpen: boolean
  onClose: () => void
  onSelectUrl: (url: string) => void
}

interface DirectTemplate {
  key: string
  name: string
  path: string
}

const TEMPLATES: DirectTemplate[] = [
  { key: 'mediamtx', name: 'MediaMTX', path: '/cancha-iphone' },
  { key: 'hikvision', name: 'Hikvision IP', path: '/Streaming/Channels/101' },
  { key: 'dahua', name: 'Dahua IP', path: '/cam/realmonitor?channel=1&subtype=0' },
  { key: 'reolink', name: 'Reolink IP', path: '/h264Preview_01_main' },
  { key: 'generic', name: 'RTSP genérico', path: '/h264/ch1/main/av_stream' }
]

export default function CameraScannerModal({
  isOpen,
  onClose,
  onSelectUrl
}: CameraScannerModalProps): React.JSX.Element | null {
  const [scanning, setScanning] = useState(false)
  const [progress, setProgress] = useState(0)
  const [foundIPs, setFoundIPs] = useState<string[]>([])
  const [selectedIP, setSelectedIP] = useState('')
  const [manualIP, setManualIP] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [rtspPort, setRtspPort] = useState('554')
  const [activeTemplateKey, setActiveTemplateKey] = useState('mediamtx')
  const [customPath, setCustomPath] = useState('/cancha-iphone')

  useEffect(() => {
    if (!isOpen) return
    void handleStartScan()

    const handleProgress = (
      _event: unknown,
      data: { percent: number; foundIPs: string[] }
    ) => {
      setProgress(data.percent)
      setFoundIPs(data.foundIPs)
    }
    window.electron.ipcRenderer.on('network:scan-progress', handleProgress)
    return () => window.electron.ipcRenderer.removeAllListeners('network:scan-progress')
  }, [isOpen])

  const activeTemplate = TEMPLATES.find((template) => template.key === activeTemplateKey)
  const activePath = activeTemplateKey === 'custom' ? customPath : activeTemplate?.path || customPath
  const previewUrl = useMemo(() => {
    if (!selectedIP || !activePath) return ''
    const credentials = username.trim()
      ? `${encodeURIComponent(username.trim())}:${encodeURIComponent(password)}@`
      : ''
    return `rtsp://${credentials}${selectedIP}:${Number(rtspPort) || 554}${activePath.startsWith('/') ? activePath : `/${activePath}`}`
  }, [selectedIP, username, password, rtspPort, activePath])

  if (!isOpen) return null

  const handleStartScan = async () => {
    setScanning(true)
    setProgress(0)
    setFoundIPs([])
    setSelectedIP('')
    try {
      const result = await window.electron.ipcRenderer.invoke('network:scan-cameras')
      if (result.success && result.foundIPs?.length) {
        setFoundIPs(result.foundIPs)
        setSelectedIP(result.foundIPs[0])
      }
    } catch (error) {
      console.error('Error scanning direct camera network:', (error as Error).message)
    } finally {
      setScanning(false)
      setProgress(100)
    }
  }

  const handleAddManualIP = (event: React.FormEvent) => {
    event.preventDefault()
    const trimmed = manualIP.trim()
    const ipRegex = /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/
    if (!trimmed || !ipRegex.test(trimmed)) return
    if (!foundIPs.includes(trimmed)) setFoundIPs((current) => [...current, trimmed])
    setSelectedIP(trimmed)
    setManualIP('')
  }

  const handleUseUrl = () => {
    if (!previewUrl) return
    onSelectUrl(previewUrl)
    onClose()
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-content"
        onClick={(event) => event.stopPropagation()}
        style={{ width: '820px', maxWidth: '94vw', maxHeight: '88vh', overflowY: 'auto' }}
      >
        <button className="modal-close-btn" onClick={onClose} type="button">
          <XCircle size={20} />
        </button>
        <h3 className="card-title" style={{ marginBottom: '5px' }}>
          Buscar cámara IP directa
        </h3>
        <p className="text-muted text-sm" style={{ marginBottom: '16px' }}>
          Este buscador sólo localiza cámaras que exponen RTSP directamente en la LAN. Para una
          cámara conectada a un DVR/NVR usá el flujo de grabador.
        </p>

        <div className="scanner-container">
          <div className="scanner-left-panel">
            <div className="scanner-title-row">
              <span className="scanner-ip-list-title">Dispositivos RTSP en la red</span>
              <button type="button" onClick={() => void handleStartScan()} disabled={scanning} className="btn btn-secondary btn-sm">
                <RefreshCw size={12} className={scanning ? 'anim-spin' : ''} />
                {scanning ? 'Buscando...' : 'Re-escanear'}
              </button>
            </div>
            <div className="scanner-progress-container">
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px', fontSize: '11px' }}>
                <span className="scanner-status-text">{scanning ? 'Escaneando subred local...' : 'Escaneo completo'}</span>
                <span style={{ fontWeight: 600 }}>{progress}%</span>
              </div>
              <div className="scanner-progress-bar-bg">
                <div className="scanner-progress-bar-fill" style={{ width: `${progress}%` }} />
              </div>
            </div>
            <div className="scanner-ip-list">
              {foundIPs.length === 0 ? (
                <div className="scanner-empty-list" style={{ padding: '20px 10px' }}>
                  {scanning ? <><RefreshCw size={20} className="anim-spin text-muted" /><p>Escaneando red local...</p></> : <><HelpCircle size={20} className="text-muted" /><p>No se encontraron cámaras IP directas.</p></>}
                </div>
              ) : (
                foundIPs.map((ip) => (
                  <button key={ip} type="button" onClick={() => setSelectedIP(ip)} className={`scanner-ip-item ${selectedIP === ip ? 'active' : ''}`}>
                    <span className="scanner-ip-item-icon"><Video size={14} /></span>
                    <span style={{ fontFamily: 'monospace' }}>{ip}</span>
                  </button>
                ))
              )}
            </div>
            <form onSubmit={handleAddManualIP} className="scanner-manual-ip-row">
              <input type="text" placeholder="IP manual: 192.168.0.50" value={manualIP} onChange={(event) => setManualIP(event.target.value)} />
              <button type="submit" className="btn btn-secondary btn-sm"><Plus size={14} /> Agregar</button>
            </form>
          </div>

          <div className="scanner-right-panel">
            {!selectedIP ? (
              <div className="scanner-empty-list" style={{ background: 'rgba(0, 0, 0, 0.05)', border: '1px dashed var(--color-border)', borderRadius: '16px', height: '100%' }}>
                <HelpCircle size={32} className="text-muted" />
                <h4 style={{ margin: '8px 0 4px', color: 'var(--color-text-primary)' }}>Sin selección</h4>
                <p style={{ maxWidth: '280px', fontSize: '13px' }}>Seleccioná una cámara IP detectada o agregá una dirección manual.</p>
              </div>
            ) : (
              <>
                <h4 className="scanner-section-title" style={{ margin: 0, fontSize: '14px' }}>
                  Configurar cámara IP: <span style={{ fontFamily: 'monospace', color: 'var(--color-secondary)' }}>{selectedIP}</span>
                </h4>
                <div className="scanner-field-grid">
                  <div className="form-group"><label>Usuario (opcional)</label><input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="off" /></div>
                  <div className="form-group"><label>Contraseña (opcional)</label><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="off" /></div>
                  <div className="form-group"><label>Puerto RTSP</label><input type="number" min="1" max="65535" value={rtspPort} onChange={(event) => setRtspPort(event.target.value)} /></div>
                </div>
                <div className="scanner-brand-cards">
                  {TEMPLATES.map((template) => (
                    <button key={template.key} type="button" onClick={() => setActiveTemplateKey(template.key)} className={`scanner-brand-card ${activeTemplateKey === template.key ? 'active' : ''}`}>
                      <span className="scanner-brand-card-header"><span className="scanner-brand-title">{template.name}</span>{activeTemplateKey === template.key && <CheckCircle2 size={14} />}</span>
                      <span className="scanner-brand-url">{template.path}</span>
                    </button>
                  ))}
                  <label className={`scanner-brand-card ${activeTemplateKey === 'custom' ? 'active' : ''}`}>
                    <span className="scanner-brand-card-header"><span className="scanner-brand-title">Ruta manual</span>{activeTemplateKey === 'custom' && <CheckCircle2 size={14} />}</span>
                    <input value={customPath} onFocus={() => setActiveTemplateKey('custom')} onChange={(event) => { setCustomPath(event.target.value); setActiveTemplateKey('custom') }} placeholder="/ruta/rtsp" />
                  </label>
                </div>
                <div className="scanner-url-preview-box">
                  <span className="scanner-url-preview-label">URL generada (la contraseña se guarda en el vault local)</span>
                  <span className="scanner-url-preview-text">{redactPreviewUrl(previewUrl)}</span>
                </div>
                <div className="scanner-actions" style={{ marginTop: 'auto', paddingTop: '12px', borderTop: '1px solid var(--color-border)' }}>
                  <button type="button" onClick={onClose} className="btn btn-secondary">Cancelar</button>
                  <button type="button" onClick={handleUseUrl} disabled={!previewUrl} className="btn btn-primary">Usar cámara IP</button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function redactPreviewUrl(url: string): string {
  return url.replace(/(rtsp:\/\/)[^@]+@/i, '$1***:***@')
}
