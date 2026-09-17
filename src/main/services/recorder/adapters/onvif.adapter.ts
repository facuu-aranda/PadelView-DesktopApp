import { createHash, randomBytes } from 'crypto'
import type {
  LocalRecorder,
  RecorderChannel,
  RecorderDeviceInfo,
  RecorderVendor
} from '../../../../shared/video-source'
import {
  buildRtspUrl,
  requestBytes,
  requestText,
  type HttpCredentials
} from '../http-client'
import type { RecorderAdapter, RecorderAdapterContext, RecorderSnapshot } from '../recorder-adapter'

const SOAP_ENV = 'http://www.w3.org/2003/05/soap-envelope'
const WSSE =
  'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd'
const WSU = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd'
const PASSWORD_DIGEST = `${WSSE}#PasswordDigest`

export class OnvifAdapter implements RecorderAdapter {
  public readonly vendor = 'unknown' as const
  private readonly context: RecorderAdapterContext
  private mediaServiceUrl: string | null = null
  private profiles: OnvifProfile[] = []

  constructor(context: RecorderAdapterContext) {
    this.context = context
  }

  public async detectDevice(): Promise<RecorderDeviceInfo> {
    const xml = await this.callDevice('GetDeviceInformation')
    const manufacturer = tagValue(xml, 'Manufacturer')
    const model = tagValue(xml, 'Model')
    const serialNumber = tagValue(xml, 'SerialNumber')
    const firmware = tagValue(xml, 'FirmwareVersion')

    return {
      vendor: inferVendor(manufacturer, model),
      model: model || undefined,
      serialNumber: serialNumber || undefined,
      firmware: firmware || undefined,
      onvifSupported: true
    }
  }

  public async authenticate(): Promise<boolean> {
    await this.detectDevice()
    return true
  }

  public async getChannels(): Promise<RecorderChannel[]> {
    const capabilities = await this.callDevice('GetCapabilities', '<tds:Category>All</tds:Category>')
    const mediaUrl = tagValue(capabilities, 'XAddr', 'Media') || tagValue(capabilities, 'XAddr')
    this.mediaServiceUrl = mediaUrl || this.defaultMediaServiceUrl()

    const profilesXml = await this.callMedia('GetProfiles')
    this.profiles = parseProfiles(profilesXml)
    return this.profiles.map((profile, index) => ({
      id: `onvif:${profile.token}`,
      number: profile.number || index + 1,
      name: profile.name || `Canal ${profile.number || index + 1}`,
      enabled: true,
      mainStreamAvailable: true,
      subStreamAvailable: true,
      snapshotAvailable: true,
      profileToken: profile.token
    }))
  }

  public async getStreamUri(channel: RecorderChannel): Promise<string> {
    const profileToken = channel.profileToken || channel.id.replace(/^onvif:/, '')
    if (!profileToken) throw new Error('El perfil ONVIF del canal no es válido.')

    const xml = await this.callMedia(
      'GetStreamUri',
      `<trt:StreamSetup><tt:Stream>RTP-Unicast</tt:Stream><tt:Transport><tt:Protocol>RTSP</tt:Protocol></tt:Transport></trt:StreamSetup><trt:ProfileToken>${escapeXml(profileToken)}</trt:ProfileToken>`
    )
    const uri = tagValue(xml, 'Uri')
    if (!uri) throw new Error('ONVIF no devolvió una URL RTSP para el canal.')
    return withCredentials(uri, this.context.credentials, this.context.recorder)
  }

  public async getSnapshot(channel: RecorderChannel): Promise<RecorderSnapshot | null> {
    const profileToken = channel.profileToken || channel.id.replace(/^onvif:/, '')
    if (!profileToken) return null

    const xml = await this.callMedia(
      'GetSnapshotUri',
      `<trt:ProfileToken>${escapeXml(profileToken)}</trt:ProfileToken>`
    )
    const uri = tagValue(xml, 'Uri')
    if (!uri) return null

    const result = await requestBytes(
      withCredentials(uri, this.context.credentials, this.context.recorder),
      {},
      this.requestOptions()
    )
    return result
  }

  private async callDevice(action: string, body = ''): Promise<string> {
    return this.call(this.deviceServiceUrl(), action, 'tds', body)
  }

  private async callMedia(action: string, body = ''): Promise<string> {
    if (!this.mediaServiceUrl) {
      const capabilities = await this.callDevice('GetCapabilities', '<tds:Category>Media</tds:Category>')
      this.mediaServiceUrl = tagValue(capabilities, 'XAddr', 'Media') || this.defaultMediaServiceUrl()
    }
    return this.call(this.mediaServiceUrl, action, 'trt', body)
  }

  private async call(url: string, action: string, prefix: 'tds' | 'trt', body: string): Promise<string> {
    const created = new Date().toISOString()
    const nonce = randomBytes(16)
    const digest = createHash('sha1')
      .update(Buffer.concat([nonce, Buffer.from(created), Buffer.from(this.context.credentials.password)]))
      .digest('base64')
    const nonceBase64 = nonce.toString('base64')
    const envelope = `<?xml version="1.0" encoding="UTF-8"?><s:Envelope xmlns:s="${SOAP_ENV}" xmlns:tds="http://www.onvif.org/ver10/device/wsdl" xmlns:trt="http://www.onvif.org/ver10/media/wsdl" xmlns:tt="http://www.onvif.org/ver10/schema"><s:Header><wsse:Security s:mustUnderstand="1" xmlns:wsse="${WSSE}" xmlns:wsu="${WSU}"><wsse:UsernameToken><wsse:Username>${escapeXml(this.context.credentials.username)}</wsse:Username><wsse:Password Type="${PASSWORD_DIGEST}">${digest}</wsse:Password><wsse:Nonce EncodingType="${WSSE}#Base64Binary">${nonceBase64}</wsse:Nonce><wsu:Created>${created}</wsu:Created></wsse:UsernameToken></wsse:Security></s:Header><s:Body><${prefix}:${action}>${body}</${prefix}:${action}></s:Body></s:Envelope>`

    return requestText(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/soap+xml; charset=utf-8',
          SOAPAction: action
        },
        body: envelope
      },
      this.requestOptions()
    )
  }

  private deviceServiceUrl(): string {
    return `http://${this.context.recorder.host}:${this.context.recorder.httpPort || 80}/onvif/device_service`
  }

  private defaultMediaServiceUrl(): string {
    return `http://${this.context.recorder.host}:${this.context.recorder.httpPort || 80}/onvif/Media`
  }

  private requestOptions(): { credentials: HttpCredentials; timeoutMs?: number; signal?: AbortSignal } {
    return {
      credentials: this.context.credentials,
      timeoutMs: this.context.timeoutMs,
      signal: this.context.signal
    }
  }
}

interface OnvifProfile {
  token: string
  name?: string
  number?: number
}

function parseProfiles(xml: string): OnvifProfile[] {
  const profiles: OnvifProfile[] = []
  const expression = /<(?:[\w.-]+:)?Profile\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?Profile>/gi
  let match: RegExpExecArray | null

  while ((match = expression.exec(xml))) {
    const block = match[0]
    const token = attribute(block, 'token')
    if (!token) continue
    const name = tagValue(block, 'Name') || undefined
    const numberMatch = `${name || ''} ${token}`.match(/(?:channel|canal)[^\d]*(\d+)/i) || `${name || ''} ${token}`.match(/(?:^|[^\d])(\d+)(?:[^\d]|$)/)
    profiles.push({
      token,
      name,
      number: numberMatch?.[1] ? Number(numberMatch[1]) : undefined
    })
  }

  return profiles
}

function tagValue(xml: string, tag: string, parentTag?: string): string {
  const source = parentTag ? findTagBlock(xml, parentTag) || xml : xml
  const expression = new RegExp(
    `<(?:[\\w.-]+:)?${tag}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${tag}>`,
    'i'
  )
  return expression.exec(source)?.[1]?.replace(/<[^>]+>/g, '').trim() || ''
}

function findTagBlock(xml: string, tag: string): string | null {
  const expression = new RegExp(
    `<(?:[\\w.-]+:)?${tag}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${tag}>`,
    'i'
  )
  return expression.exec(xml)?.[0] || null
}

function attribute(xml: string, name: string): string | undefined {
  return new RegExp(`${name}=["']([^"']+)["']`, 'i').exec(xml)?.[1]
}

function inferVendor(manufacturer: string, model: string): RecorderVendor {
  const value = `${manufacturer} ${model}`.toLowerCase()
  if (value.includes('hikvision')) return 'hikvision'
  if (value.includes('dahua') || value.includes('imou')) return 'dahua'
  return 'unknown'
}

function withCredentials(uri: string, credentials: HttpCredentials, recorder: LocalRecorder): string {
  try {
    const parsed = new URL(uri)
    parsed.hostname = recorder.host
    parsed.port = String(recorder.rtspPort || parsed.port || 554)
    parsed.username = credentials.username
    parsed.password = credentials.password
    return parsed.toString()
  } catch {
    return buildRtspUrl(recorder.host, recorder.rtspPort || 554, credentials, uri)
  }
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}
