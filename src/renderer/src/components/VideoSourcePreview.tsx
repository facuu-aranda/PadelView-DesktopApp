import { useEffect, useRef, useState } from 'react'
import type { VideoSource } from '../../../shared/video-source'
import RecorderWebRtcPreview from './RecorderWebRtcPreview'

interface VideoSourcePreviewProps {
  courtId: string
  profileId?: string
  source?: VideoSource
  rtspUrl?: string
  compact?: boolean
}

interface JsmpegDestination {
  write(data: ArrayBuffer): void
}

interface JsmpegPlayer {
  stop(): void
  destroy(): void
}

interface JsmpegApi {
  Player: new (url: string, options: Record<string, unknown>) => JsmpegPlayer
}

interface PreviewWindow extends Window {
  JSMpeg?: JsmpegApi
}

interface PreviewSource {
  destination: JsmpegDestination | null
  streaming: boolean
  established: boolean
  progress: number
  connect(destination: JsmpegDestination): void
  start(): void
  resume(): void
  destroy(): void
}

function DirectVideoSourcePreview({
  courtId,
  profileId,
  source,
  rtspUrl,
  compact = false
}: VideoSourcePreviewProps): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const playerRef = useRef<JsmpegPlayer | null>(null)
  const sourceRef = useRef<PreviewSource | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!rtspUrl && !profileId) return

    const JSMpeg = (window as PreviewWindow).JSMpeg
    if (!JSMpeg || !canvasRef.current) {
      setError('El reproductor de preview no está disponible.')
      return
    }

    let sourceInstance: PreviewSource | null = null
    let mounted = true
    const captureSource = (instance: PreviewSource): void => {
      sourceInstance = instance
    }

    class CustomSource implements PreviewSource {
      destination: JsmpegDestination | null = null
      streaming = true
      established = false
      progress = 0

      constructor() {
        captureSource(this)
      }

      connect(destination: JsmpegDestination): void {
        this.destination = destination
      }

      start(): void {
        this.streaming = true
      }

      resume(): void {
        this.streaming = true
      }

      destroy(): void {
        this.destination = null
      }
    }

    const player = new JSMpeg.Player('', {
      source: CustomSource,
      canvas: canvasRef.current,
      autoplay: true,
      audio: false,
      disableGl: true,
      videoBufferSize: 512 * 1024
    })
    playerRef.current = player
    sourceRef.current = sourceInstance

    const channel = `stream:data:${courtId}`
    const handleData = (_event: unknown, chunk: Uint8Array): void => {
      if (!mounted || !sourceInstance?.destination) return
      sourceInstance.established = true
      sourceInstance.progress = 1
      const arrayBuffer = new Uint8Array(chunk).buffer
      sourceInstance.destination.write(arrayBuffer)
    }

    window.electron.ipcRenderer.on(channel, handleData)
    window.electron.ipcRenderer
      .invoke('stream:start', { courtId, profileId, source, rtspUrl })
      .then((result: { success?: boolean; error?: string }) => {
        if (mounted && result && !result.success) setError(result.error || 'No se pudo iniciar el preview.')
      })
      .catch(() => {
        if (mounted) setError('No se pudo iniciar el preview.')
      })

    return () => {
      mounted = false
      window.electron.ipcRenderer.removeAllListeners(channel)
      void window.electron.ipcRenderer.invoke('stream:stop', courtId)
      if (playerRef.current) {
        playerRef.current.stop()
        playerRef.current.destroy()
      }
      playerRef.current = null
      sourceRef.current = null
    }
  }, [courtId, profileId, source, rtspUrl])

  if (!rtspUrl && !profileId) {
    return <PreviewPlaceholder compact={compact}>Cámara no configurada</PreviewPlaceholder>
  }

  return (
    <div
      style={{
        position: 'relative',
        width: '100%',
        aspectRatio: '16/9',
        minHeight: compact ? '120px' : undefined,
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
      {error ? (
        <span
          className="text-secondary text-xs"
          style={{ position: 'absolute', padding: '12px', textAlign: 'center' }}
        >
          {error}
        </span>
      ) : (
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
      )}
    </div>
  )
}

export default function VideoSourcePreview(props: VideoSourcePreviewProps): React.JSX.Element {
  if (props.source?.type === 'recorder' && props.profileId) {
    return (
      <RecorderWebRtcPreview
        courtId={props.courtId}
        profileId={props.profileId}
        source={props.source}
        compact={props.compact}
      />
    )
  }
  return <DirectVideoSourcePreview {...props} />
}

function PreviewPlaceholder({
  children,
  compact
}: {
  children: string
  compact: boolean
}): React.JSX.Element {
  return (
    <div
      style={{
        width: '100%',
        aspectRatio: '16/9',
        minHeight: compact ? '120px' : undefined,
        backgroundColor: 'rgba(0,0,0,0.2)',
        borderRadius: '12px',
        border: '1px dashed var(--color-border)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center'
      }}
    >
      <span className="text-muted text-sm">{children}</span>
    </div>
  )
}
