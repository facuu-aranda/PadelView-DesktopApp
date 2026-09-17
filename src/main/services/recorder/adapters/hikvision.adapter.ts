import type { RecorderChannel, RecorderDeviceInfo } from '../../../../shared/video-source'
import {
  buildHttpUrl,
  buildRtspUrl,
  requestBytes,
  requestText,
  type HttpRequestOptions
} from '../http-client'
import type { RecorderAdapter, RecorderAdapterContext, RecorderSnapshot } from '../recorder-adapter'

export class HikvisionAdapter implements RecorderAdapter {
  public readonly vendor = 'hikvision' as const
  private readonly context: RecorderAdapterContext

  constructor(context: RecorderAdapterContext) {
    this.context = context
  }

  public async detectDevice(): Promise<RecorderDeviceInfo> {
    const xml = await this.request('/ISAPI/System/deviceInfo')
    return {
      vendor: 'hikvision',
      model: tagValue(xml, 'model') || tagValue(xml, 'Model') || undefined,
      serialNumber: tagValue(xml, 'serialNumber') || tagValue(xml, 'SerialNumber') || undefined,
      firmware: tagValue(xml, 'firmwareVersion') || tagValue(xml, 'FirmwareVersion') || undefined,
      onvifSupported: false
    }
  }

  public async authenticate(): Promise<boolean> {
    await this.detectDevice()
    return true
  }

  public async getChannels(): Promise<RecorderChannel[]> {
    const xml = await this.request('/ISAPI/Streaming/channels')
    const blocks = xml.match(/<(?:[\w.-]+:)?StreamingChannel\b[^>]*>[\s\S]*?<\/(?:[\w.-]+:)?StreamingChannel>/gi) || []
    const channels = new Map<number, RecorderChannel>()

    for (const block of blocks) {
      const id = Number(tagValue(block, 'id'))
      if (!Number.isInteger(id) || id <= 0) continue
      const number = id >= 100 ? Math.floor(id / 100) : id
      const isSub = id % 100 === 2 || /sub|secondary/i.test(tagValue(block, 'name'))
      const current = channels.get(number) || {
        id: `hikvision:${number}`,
        number,
        name: tagValue(block, 'name') || `Canal ${number}`,
        enabled: true,
        mainStreamAvailable: false,
        subStreamAvailable: false,
        snapshotAvailable: true,
        streamIds: {}
      }
      current.streamIds = {
        ...current.streamIds,
        ...(isSub ? { sub: String(id) } : { main: String(id) })
      }
      current.subStreamAvailable = Boolean(current.streamIds.sub)
      current.mainStreamAvailable = Boolean(current.streamIds.main)
      channels.set(number, current)
    }

    return [...channels.values()].filter((channel) => channel.enabled)
  }

  public async getStreamUri(channel: RecorderChannel, stream: 'main' | 'sub'): Promise<string> {
    const number = channel.number || parseChannelNumber(channel.id)
    if (!number) throw new Error('El canal Hikvision no tiene un número válido.')
    const streamPath = channel.streamIds?.[stream]
    if (streamPath?.startsWith('/')) {
      return buildRtspUrl(
        this.context.recorder.host,
        this.context.recorder.rtspPort || 554,
        this.context.credentials,
        streamPath
      )
    }
    const streamId = streamPath || `${number}${stream === 'main' ? '01' : '02'}`
    return buildRtspUrl(
      this.context.recorder.host,
      this.context.recorder.rtspPort || 554,
      this.context.credentials,
      `/Streaming/Channels/${streamId}`
    )
  }

  public async getSnapshot(channel: RecorderChannel): Promise<RecorderSnapshot | null> {
    const number = channel.number || parseChannelNumber(channel.id)
    if (!number) return null
    const streamId = channel.streamIds?.main || `${number}01`
    return requestBytes(
      buildHttpUrl(
        this.context.recorder.host,
        this.context.recorder.httpPort || 80,
        `/ISAPI/Streaming/channels/${streamId}/picture`
      ),
      {},
      this.requestOptions()
    )
  }

  private async request(path: string): Promise<string> {
    return requestText(
      buildHttpUrl(this.context.recorder.host, this.context.recorder.httpPort || 80, path),
      {},
      this.requestOptions()
    )
  }

  private requestOptions(): HttpRequestOptions {
    return {
      credentials: this.context.credentials,
      timeoutMs: this.context.timeoutMs,
      signal: this.context.signal
    }
  }
}

function tagValue(xml: string, tag: string): string {
  const expression = new RegExp(
    `<(?:[\\w.-]+:)?${tag}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${tag}>`,
    'i'
  )
  return expression.exec(xml)?.[1]?.replace(/<[^>]+>/g, '').trim() || ''
}

function parseChannelNumber(id: string): number | null {
  const match = id.match(/(\d+)/)
  if (!match) return null
  const numericId = Number(match[1])
  return numericId >= 100 ? Math.floor(numericId / 100) : numericId
}
