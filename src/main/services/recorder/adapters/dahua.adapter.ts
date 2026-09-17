import type { RecorderChannel, RecorderDeviceInfo } from '../../../../shared/video-source'
import {
  buildHttpUrl,
  buildRtspUrl,
  requestBytes,
  requestText,
  type HttpRequestOptions
} from '../http-client'
import type { RecorderAdapter, RecorderAdapterContext, RecorderSnapshot } from '../recorder-adapter'

export class DahuaAdapter implements RecorderAdapter {
  public readonly vendor = 'dahua' as const
  private readonly context: RecorderAdapterContext

  constructor(context: RecorderAdapterContext) {
    this.context = context
  }

  public async detectDevice(): Promise<RecorderDeviceInfo> {
    const body = await this.request('/cgi-bin/magicBox.cgi?action=getSystemInfo')
    return {
      vendor: 'dahua',
      model: valueFromResponse(body, ['deviceType', 'deviceModel']) || undefined,
      serialNumber: valueFromResponse(body, ['serialNumber']) || undefined,
      firmware: valueFromResponse(body, ['version', 'softwareVersion']) || undefined,
      onvifSupported: false
    }
  }

  public async authenticate(): Promise<boolean> {
    await this.detectDevice()
    return true
  }

  public async getChannels(): Promise<RecorderChannel[]> {
    const states = await this.request('/cgi-bin/devVideoInput.cgi?action=getCameraState')
    const channels = new Map<number, RecorderChannel>()
    const stateExpression = /(?:CameraState|State)\[(\d+)\](?:\.State)?=([^\r\n]+)/gi
    let match: RegExpExecArray | null

    while ((match = stateExpression.exec(states))) {
      const number = Number(match[1]) + (match[1] === '0' ? 1 : 0)
      if (!Number.isInteger(number) || number <= 0) continue
      const state = match[2].trim().toLowerCase()
      channels.set(number, {
        id: `dahua:${number}`,
        number,
        name: `Canal ${number}`,
        enabled: !/disable|no signal|offline/.test(state),
        mainStreamAvailable: true,
        subStreamAvailable: true,
        snapshotAvailable: true
      })
    }

    if (channels.size === 0) {
      const titles = await this.request('/cgi-bin/configManager.cgi?action=getConfig&name=ChannelTitle')
      const titleExpression = /(?:ChannelName|table\.ChannelName)\[(\d+)\]=([^\r\n]+)/gi
      while ((match = titleExpression.exec(titles))) {
        const number = Number(match[1]) + 1
        channels.set(number, {
          id: `dahua:${number}`,
          number,
          name: match[2].trim() || `Canal ${number}`,
          enabled: true,
          mainStreamAvailable: true,
          subStreamAvailable: true,
          snapshotAvailable: true
        })
      }
    }

    return [...channels.values()].filter((channel) => channel.enabled)
  }

  public async getStreamUri(channel: RecorderChannel, stream: 'main' | 'sub'): Promise<string> {
    const number = channel.number || parseChannelNumber(channel.id)
    if (!number) throw new Error('El canal Dahua no tiene un número válido.')
    return buildRtspUrl(
      this.context.recorder.host,
      this.context.recorder.rtspPort || 554,
      this.context.credentials,
      channel.streamIds?.[stream] ||
        `/cam/realmonitor?channel=${number}&subtype=${stream === 'main' ? 0 : 1}`
    )
  }

  public async getSnapshot(channel: RecorderChannel): Promise<RecorderSnapshot | null> {
    const number = channel.number || parseChannelNumber(channel.id)
    if (!number) return null
    return requestBytes(
      buildHttpUrl(
        this.context.recorder.host,
        this.context.recorder.httpPort || 80,
        `/cgi-bin/snapshot.cgi?channel=${number}`
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

function valueFromResponse(response: string, keys: string[]): string {
  for (const key of keys) {
    const match = new RegExp(`(?:^|\\n)${key}=([^\\r\\n]+)`, 'i').exec(response)
    if (match?.[1]) return match[1].trim()
  }
  return ''
}

function parseChannelNumber(id: string): number | null {
  const match = id.match(/(\d+)/)
  return match?.[1] ? Number(match[1]) : null
}
