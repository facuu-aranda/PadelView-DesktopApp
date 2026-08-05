import { useState, useEffect, useMemo } from 'react'
import { XCircle, RefreshCw, CheckCircle2, HelpCircle, Video, Plus } from 'lucide-react'

interface CameraScannerModalProps {
  isOpen: boolean
  onClose: () => void
  onSelectUrl: (url: string) => void
}

interface Template {
  key: string
  name: string
  generate: (ip: string) => string
}

const TEMPLATES: Template[] = [
  {
    key: 'mediamtx',
    name: 'MediaMTX / Simulador (Larix / OBS)',
    generate: (ip) => `rtsp://${ip}:8554/live/cancha1`
  },
  {
    key: 'hikvision',
    name: 'Hikvision',
    generate: (ip) => `rtsp://admin:admin@${ip}:554/Streaming/Channels/101`
  },
  {
    key: 'dahua',
    name: 'Dahua / Lorex / Amcrest',
    generate: (ip) => `rtsp://admin:admin@${ip}:554/cam/realmonitor?channel=1&subtype=0`
  },
  {
    key: 'reolink',
    name: 'Reolink',
    generate: (ip) => `rtsp://admin:admin@${ip}:554/h264Preview_01_main`
  },
  {
    key: 'onvif',
    name: 'ONVIF Estándar',
    generate: (ip) => `rtsp://admin:admin@${ip}:554/onvif1`
  },
  {
    key: 'generic',
    name: 'Canal Genérico H.264',
    generate: (ip) => `rtsp://admin:admin@${ip}:554/h264`
  }
]

export default function CameraScannerModal({
  isOpen,
  onClose,
  onSelectUrl
}: CameraScannerModalProps) {
  if (!isOpen) return null

  const [scanning, setScanning] = useState<boolean>(false)
  const [progress, setProgress] = useState<number>(0)
  const [foundIPs, setFoundIPs] = useState<string[]>([])
  const [selectedIP, setSelectedIP] = useState<string>('')

  // Custom manual IP entry
  const [manualIP, setManualIP] = useState<string>('')

  // Selected Suggestion Template key
  const [activeTemplateKey, setActiveTemplateKey] = useState<string>('mediamtx')

  // Trigger scan on mount
  useEffect(() => {
    handleStartScan()

    const handleProgress = (_event: any, data: { percent: number; foundIPs: string[] }) => {
      setProgress(data.percent)
      setFoundIPs(data.foundIPs)
    }

    window.electron.ipcRenderer.on('network:scan-progress', handleProgress)

    return () => {
      window.electron.ipcRenderer.removeAllListeners('network:scan-progress')
    }
  }, [])

  const handleStartScan = async () => {
    setScanning(true)
    setProgress(0)
    setFoundIPs([])
    setSelectedIP('')

    try {
      const res = await window.electron.ipcRenderer.invoke('network:scan-cameras')
      if (res.success && res.foundIPs && res.foundIPs.length > 0) {
        setFoundIPs(res.foundIPs)
        setSelectedIP(res.foundIPs[0])
      }
    } catch (err) {
      console.error('Error scanning network:', err)
    } finally {
      setScanning(false)
      setProgress(100)
    }
  }

  const handleAddManualIP = (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = manualIP.trim()
    const ipRegex = /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/
    if (trimmed && ipRegex.test(trimmed)) {
      if (!foundIPs.includes(trimmed)) {
        setFoundIPs((prev) => [...prev, trimmed])
      }
      setSelectedIP(trimmed)
      setManualIP('')
    }
  }

  // Generate URL for a specific template
  const getGeneratedUrl = (templateKey: string) => {
    if (!selectedIP) return ''
    const template = TEMPLATES.find((t) => t.key === templateKey)
    if (!template) return ''
    return template.generate(selectedIP.trim())
  }

  const activeGeneratedUrl = useMemo(() => {
    return getGeneratedUrl(activeTemplateKey)
  }, [selectedIP, activeTemplateKey])

  const handleUseUrl = () => {
    if (activeGeneratedUrl) {
      onSelectUrl(activeGeneratedUrl)
      onClose()
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-content"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '800px',
          maxWidth: '90vw',
          maxHeight: '85vh',
          display: 'flex',
          flexDirection: 'column'
        }}
      >
        <button className="modal-close-btn" onClick={onClose} type="button">
          <XCircle size={20} />
        </button>

        <div style={{ flexShrink: 0 }}>
          <h3 className="card-title" style={{ marginBottom: '5px' }}>
            Seleccionar Dirección de Cámara
          </h3>
          <p className="text-muted text-sm" style={{ marginBottom: '15px' }}>
            Selecciona la IP de la cámara detectada en la red local y elige la plantilla
            correspondiente a su marca.
          </p>
        </div>

        <div className="scanner-container">
          {/* LEFT PANEL: SCAN STATUS & IP LIST */}
          <div className="scanner-left-panel">
            <div className="scanner-title-row">
              <span className="scanner-ip-list-title">Dispositivos en Red</span>
              <button
                type="button"
                onClick={handleStartScan}
                disabled={scanning}
                className="btn btn-secondary btn-sm"
                style={{
                  padding: '4px 10px',
                  fontSize: '12px',
                  display: 'flex',
                  gap: '4px',
                  alignItems: 'center'
                }}
              >
                <RefreshCw size={12} className={scanning ? 'anim-spin' : ''} />
                {scanning ? 'Buscando...' : 'Re-escanear'}
              </button>
            </div>

            {/* PROGRESS BAR */}
            <div className="scanner-progress-container">
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  marginBottom: '4px',
                  fontSize: '11px'
                }}
              >
                <span className="scanner-status-text">
                  {scanning ? 'Escaneando subred local...' : 'Escaneo completo'}
                </span>
                <span style={{ fontWeight: 600 }}>{progress}%</span>
              </div>
              <div className="scanner-progress-bar-bg">
                <div className="scanner-progress-bar-fill" style={{ width: `${progress}%` }} />
              </div>
            </div>

            {/* SCAN RESULTS LIST */}
            <div className={`scanner-ip-list ${scanning ? 'scanner-scan-line-active' : ''}`}>
              {foundIPs.length === 0 ? (
                <div className="scanner-empty-list" style={{ padding: '20px 10px' }}>
                  {scanning ? (
                    <>
                      <RefreshCw size={20} className="anim-spin text-muted" />
                      <p style={{ margin: 0 }}>Escaneando red local...</p>
                    </>
                  ) : (
                    <>
                      <HelpCircle size={20} className="text-muted" />
                      <p style={{ fontSize: '12px', margin: 0 }}>
                        No se encontraron cámaras de red.
                      </p>
                    </>
                  )}
                </div>
              ) : (
                foundIPs.map((ip) => (
                  <div
                    key={ip}
                    onClick={() => setSelectedIP(ip)}
                    className={`scanner-ip-item ${selectedIP === ip ? 'active' : ''}`}
                  >
                    <div className="scanner-ip-item-icon">
                      <Video size={14} />
                    </div>
                    <span style={{ fontFamily: 'monospace' }}>{ip}</span>
                  </div>
                ))
              )}
            </div>

            {/* MANUAL IP ROW */}
            <form
              onSubmit={handleAddManualIP}
              className="scanner-manual-ip-row"
              style={{ flexShrink: 0 }}
            >
              <input
                type="text"
                placeholder="IP manual: Ej. 192.168.0.50"
                value={manualIP}
                onChange={(e) => setManualIP(e.target.value)}
                style={{ height: '36px', fontSize: '13px' }}
              />
              <button
                type="submit"
                className="btn btn-secondary btn-sm"
                style={{
                  height: '36px',
                  padding: '0 12px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '4px'
                }}
                title="Agregar dirección IP manual a la lista"
              >
                <Plus size={14} /> Agregar
              </button>
            </form>
          </div>

          {/* RIGHT PANEL: SIMPLIFIED SUGGESTIONS LIST */}
          <div className="scanner-right-panel">
            {!selectedIP ? (
              <div
                className="scanner-empty-list"
                style={{
                  background: 'rgba(0, 0, 0, 0.05)',
                  border: '1px dashed var(--color-border)',
                  borderRadius: '16px',
                  height: '100%'
                }}
              >
                <HelpCircle size={32} className="text-muted" />
                <h4 style={{ margin: '8px 0 4px 0', color: 'var(--color-text-primary)' }}>
                  Sin Selección
                </h4>
                <p style={{ maxWidth: '280px', fontSize: '13px' }}>
                  Selecciona una IP detectada en la lista o agrega una manualmente para ver las
                  sugerencias de conexión.
                </p>
              </div>
            ) : (
              <>
                <h4
                  className="scanner-section-title"
                  style={{ margin: 0, fontSize: '14px', flexShrink: 0 }}
                >
                  Direcciones sugeridas para la IP:{' '}
                  <span style={{ fontFamily: 'monospace', color: 'var(--color-secondary)' }}>
                    {selectedIP}
                  </span>
                </h4>

                {/* SUGGESTED BRAND CARDS */}
                <div className="scanner-brand-cards">
                  {TEMPLATES.map((t) => {
                    const generated = getGeneratedUrl(t.key)
                    const isActive = activeTemplateKey === t.key
                    return (
                      <div
                        key={t.key}
                        onClick={() => setActiveTemplateKey(t.key)}
                        className={`scanner-brand-card ${isActive ? 'active' : ''}`}
                      >
                        <div className="scanner-brand-card-header">
                          <span className="scanner-brand-title">{t.name}</span>
                          {isActive && (
                            <span
                              style={{
                                color: 'var(--color-primary)',
                                display: 'flex',
                                alignItems: 'center'
                              }}
                            >
                              <CheckCircle2 size={14} />
                            </span>
                          )}
                        </div>
                        <div className="scanner-brand-url">{generated}</div>
                      </div>
                    )
                  })}
                </div>

                {/* FOOTER ACTIONS */}
                <div
                  className="scanner-actions"
                  style={{
                    marginTop: 'auto',
                    paddingTop: '12px',
                    borderTop: '1px solid var(--color-border)',
                    flexShrink: 0
                  }}
                >
                  <button type="button" onClick={onClose} className="btn btn-secondary">
                    Cancelar
                  </button>
                  <button
                    type="button"
                    onClick={handleUseUrl}
                    disabled={!selectedIP}
                    className="btn btn-primary"
                  >
                    Usar Dirección Seleccionada
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
