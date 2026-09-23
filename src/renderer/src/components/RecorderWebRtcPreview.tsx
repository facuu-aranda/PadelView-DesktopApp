import { useEffect, useRef, useState } from 'react'
import type { RecorderSource } from '../../../shared/video-source'

interface RecorderWebRtcPreviewProps {
  courtId: string
  profileId: string
  source: RecorderSource
  compact?: boolean
}

type PreviewStatus = 'connecting' | 'playing' | 'error'

export default function RecorderWebRtcPreview({
  courtId,
  profileId,
  source,
  compact = false
}: RecorderWebRtcPreviewProps): React.JSX.Element {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const peerRef = useRef<RTCPeerConnection | null>(null)
  const handleRef = useRef<{ key: string; pathName: string } | null>(null)
  const [status, setStatus] = useState<PreviewStatus>('connecting')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let mounted = true
    const start = async (): Promise<void> => {
      try {
        const result = await window.electron.ipcRenderer.invoke('video-source:preview-start', {
          courtId,
          profileId,
          source,
          profile: 'sub'
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
          setStatus('playing')
        }
        peer.onconnectionstatechange = () => {
          if (!mounted) return
          if (peer.connectionState === 'failed' || peer.connectionState === 'disconnected') {
            setStatus('error')
            setError('La conexión WebRTC con el DVR se interrumpió.')
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
      } catch (startError) {
        if (mounted) {
          setStatus('error')
          setError((startError as Error).message || 'No se pudo iniciar el preview DVR.')
        }
      }
    }

    void start()
    return () => {
      mounted = false
      peerRef.current?.close()
      peerRef.current = null
      if (videoRef.current) videoRef.current.srcObject = null
      if (handleRef.current) {
        void window.electron.ipcRenderer.invoke('video-source:preview-stop', handleRef.current)
        handleRef.current = null
      }
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
      {status === 'connecting' && (
        <span className="text-secondary text-xs" style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center' }}>
          Conectando preview DVR…
        </span>
      )}
      {status === 'error' && (
        <span className="text-secondary text-xs" style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', padding: '12px', textAlign: 'center' }}>
          {error || 'No se pudo visualizar el canal DVR.'}
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
