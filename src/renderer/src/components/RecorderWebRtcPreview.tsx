import { useEffect, useRef, useState } from 'react'
import type { RecorderSource } from '../../../shared/video-source'

interface RecorderWebRtcPreviewProps {
  courtId: string
  profileId: string
  source: RecorderSource
  compact?: boolean
}

type PreviewStatus = 'connecting' | 'playing' | 'fallback' | 'error'

type PreviewHandle = {
  key: string
  pathName: string
  whepUrl: string
}

export default function RecorderWebRtcPreview({
  courtId,
  profileId,
  source,
  compact = false
}: RecorderWebRtcPreviewProps): React.JSX.Element {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const peerRef = useRef<RTCPeerConnection | null>(null)
  const handleRef = useRef<PreviewHandle | null>(null)
  const [status, setStatus] = useState<PreviewStatus>('connecting')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let mounted = true
    let compatibilityStarted = false
    let firstFrameTimer: number | null = null

    const closePeer = (): void => {
      if (firstFrameTimer !== null) window.clearTimeout(firstFrameTimer)
      firstFrameTimer = null
      peerRef.current?.close()
      peerRef.current = null
      if (videoRef.current) videoRef.current.srcObject = null
    }

    const releaseHandle = async (): Promise<void> => {
      if (!handleRef.current) return
      const handle = handleRef.current
      handleRef.current = null
      await window.electron.ipcRenderer.invoke('video-source:preview-stop', handle)
    }

    const start = async (compatibility: boolean): Promise<void> => {
      try {
        if (compatibility) {
          setStatus('fallback')
          setError('Preparando transcodificación de compatibilidad…')
        } else {
          setStatus('connecting')
          setError(null)
        }

        const result = await window.electron.ipcRenderer.invoke('video-source:preview-start', {
          courtId,
          profileId,
          source,
          profile: compatibility ? 'main' : source.stream || 'sub',
          compatibility
        })
        if (!result.success || !result.data) throw new Error(result.error || 'No se pudo preparar MediaMTX.')
        handleRef.current = result.data

        const peer = new RTCPeerConnection({ iceServers: [] })
        peerRef.current = peer
        peer.addTransceiver('video', { direction: 'recvonly' })
        peer.ontrack = (event) => {
          if (!mounted || !videoRef.current) return
          videoRef.current.srcObject = event.streams[0]
          void videoRef.current.play().catch(() => undefined)
        }
        peer.onconnectionstatechange = () => {
          if (!mounted) return
          if (peer.connectionState === 'failed' || peer.connectionState === 'disconnected') {
            if (!compatibility && !compatibilityStarted) {
              compatibilityStarted = true
              closePeer()
              void releaseHandle().then(() => start(true))
            } else {
              setStatus('error')
              setError('La conexión WebRTC con el DVR se interrumpió.')
            }
          }
        }
        if (videoRef.current) {
          videoRef.current.onloadeddata = () => {
            if (mounted) setStatus('playing')
          }
        }

        const offer = await peer.createOffer()
        await peer.setLocalDescription(offer)
        await waitForIceGathering(peer)
        const response = await fetch(result.data.whepUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/sdp', Accept: 'application/sdp' },
          body: peer.localDescription?.sdp || offer.sdp || ''
        })
        if (!response.ok) throw new Error(`MediaMTX WHEP respondió ${response.status}.`)
        await peer.setRemoteDescription({ type: 'answer', sdp: await response.text() })

        firstFrameTimer = window.setTimeout(() => {
          if (!mounted || videoRef.current?.readyState === 4) return
          if (!compatibility && !compatibilityStarted) {
            compatibilityStarted = true
            closePeer()
            void releaseHandle().then(() => start(true))
          }
        }, 8000)
      } catch (startError) {
        if (!mounted) return
        if (!compatibility && !compatibilityStarted) {
          compatibilityStarted = true
          closePeer()
          await releaseHandle()
          await start(true)
          return
        }
        setStatus('error')
        setError((startError as Error).message || 'No se pudo iniciar el preview DVR.')
      }
    }

    void start(false)
    return () => {
      mounted = false
      closePeer()
      void releaseHandle()
    }
  }, [courtId, profileId, source])

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
        border: '1px solid var(--color-border)'
      }}
    >
      <video
        ref={videoRef}
        autoPlay
        muted
        playsInline
        style={{ width: '100%', height: '100%', display: 'block', objectFit: 'cover' }}
      />
      {status !== 'playing' && (
        <span className="text-secondary text-xs" style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', padding: '12px', textAlign: 'center' }}>
          {status === 'fallback' ? 'Preparando compatibilidad de video…' : error || 'Conectando preview DVR…'}
        </span>
      )}
    </div>
  )
}

async function waitForIceGathering(peer: RTCPeerConnection): Promise<void> {
  if (peer.iceGatheringState === 'complete') return
  await new Promise<void>((resolve) => {
    const timeout = window.setTimeout(resolve, 1500)
    peer.addEventListener('icegatheringstatechange', () => {
      if (peer.iceGatheringState === 'complete') {
        window.clearTimeout(timeout)
        resolve()
      }
    })
  })
}
