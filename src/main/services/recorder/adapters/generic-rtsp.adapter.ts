import type { RecorderChannel, RecorderDeviceInfo } from '../../../../shared/video-source'
import { buildRtspUrl } from '../http-client'
import type { RecorderAdapter, RecorderAdapterContext } from '../recorder-adapter'

export class GenericRtspAdapter implements RecorderAdapter {
  public readonly vendor = 'generic' as const
  private readonly context: RecorderAdapterContext

  constructor(context: RecorderAdapterContext) {
    this.context = context
  }

  public async detectDevice(): Promise<RecorderDeviceInfo> {
    return { vendor: 'unknown', onvifSupported: false }
  }

  public async authenticate(): Promise<boolean> {
    return true
  }

  public async getChannels(): Promise<RecorderChannel[]> {
    return []
  }

  public async getStreamUri(channel: RecorderChannel, stream: 'main' | 'sub'): Promise<string> {
    const number = channel.number || parseChannelNumber(channel.id)
    if (!number) throw new Error('El canal RTSP genérico no tiene un número válido.')
    const path =
      channel.streamIds?.[stream] ||
      `/h264/ch${number}/${stream === 'main' ? 'main' : 'sub'}/av_stream`
    return buildRtspUrl(
      this.context.recorder.host,
      this.context.recorder.rtspPort || 554,
      this.context.credentials,
      path
    )
  }
}

function parseChannelNumber(id: string): number | null {
  const match = id.match(/(\d+)/)
  return match?.[1] ? Number(match[1]) : null
}
