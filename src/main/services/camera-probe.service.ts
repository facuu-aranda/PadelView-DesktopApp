import { spawn } from 'child_process'
import net from 'net'
import { ffmpegService } from './ffmpeg.service'

export type DvrTemplateKey = 'mediamtx' | 'hikvision' | 'dahua' | 'reolink' | 'onvif' | 'generic'

export interface DvrProbeOptions {
  ip: string
  port?: number
  username?: string
  password?: string
  template: DvrTemplateKey
  maxChannels?: number
  timeoutMs?: number
}

export interface DiscoveredCamera {
  channel: number
  url: string
  path: string
  label: string
}

type ChannelPathBuilder = (channel: number) => string

const CHANNEL_PATHS: Record<DvrTemplateKey, ChannelPathBuilder[]> = {
  mediamtx: [(channel) => `/live/cancha${channel}`],
  hikvision: [(channel) => `/Streaming/Channels/${channel}01`],
  dahua: [
    (channel) => `/cam/realmonitor?channel=${channel}&subtype=0`,
    (channel) => `/Streaming/Channels/${channel}01`
  ],
  reolink: [(channel) => `/h264Preview_${channel.toString().padStart(2, '0')}_main`],
  onvif: [(channel) => `/onvif${channel}`],
  generic: [(channel) => `/h264/ch${channel}/main/av_stream`]
}

const IPV4_PATTERN = /^(?:\d{1,3}\.){3}\d{1,3}$/

class CameraProbeService {
  public async probeDvr(
    options: DvrProbeOptions,
    onProgress?: (percent: number, found: DiscoveredCamera[]) => void
  ): Promise<DiscoveredCamera[]> {
    const ip = options.ip?.trim()
    const port = options.port ?? 554
    const username = options.username ?? ''
    const password = options.password ?? ''
    const template = options.template
    const maxChannels = Math.min(Math.max(Math.floor(options.maxChannels ?? 32), 1), 64)
    const timeoutMs = Math.min(Math.max(Math.floor(options.timeoutMs ?? 5000), 2000), 15000)

    this.validateInput(ip, port, template)

    const portOpen = await this.isPortOpen(ip, port, Math.min(timeoutMs, 1500))
    if (!portOpen) {
      throw new Error(`No se puede conectar al puerto RTSP ${port} del DVR.`)
    }

    const pathBuilders = CHANNEL_PATHS[template]
    const found: DiscoveredCamera[] = []
    const batchSize = 4
    let completed = 0

    for (let channel = 1; channel <= maxChannels; channel += batchSize) {
      const batch = Array.from(
        { length: Math.min(batchSize, maxChannels - channel + 1) },
        (_, index) => channel + index
      )

      const results = await Promise.all(
        batch.map(async (candidateChannel) => {
          const paths = pathBuilders.map((pathBuilder) => pathBuilder(candidateChannel))
          const path = await this.findAvailablePath(paths, ip, port, username, password, timeoutMs)

          if (!path) return null

          return {
            channel: candidateChannel,
            url: this.buildRtspUrl(ip, port, username, password, path),
            path,
            label: `Cámara ${candidateChannel}`
          }
        })
      )

      for (const result of results) {
        if (result) found.push(result)
      }

      completed += batch.length
      onProgress?.(Math.round((completed / maxChannels) * 100), [...found])
    }

    return found
  }

  private validateInput(ip: string, port: number, template: DvrTemplateKey): void {
    if (!ip || !IPV4_PATTERN.test(ip) || ip.split('.').some((part) => Number(part) > 255)) {
      throw new Error('La dirección IP del DVR no es válida.')
    }

    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('El puerto RTSP no es válido.')
    }

    if (!CHANNEL_PATHS[template]) {
      throw new Error('La plantilla de canales seleccionada no es válida.')
    }
  }

  private buildRtspUrl(
    ip: string,
    port: number,
    username: string,
    password: string,
    path: string
  ): string {
    const credentials = username
      ? `${encodeURIComponent(username)}:${encodeURIComponent(password)}@`
      : ''
    return `rtsp://${credentials}${ip}:${port}${path}`
  }

  private isPortOpen(ip: string, port: number, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = new net.Socket()
      let settled = false

      const finish = (open: boolean): void => {
        if (settled) return
        settled = true
        socket.destroy()
        resolve(open)
      }

      socket.setTimeout(timeoutMs)
      socket.once('connect', () => finish(true))
      socket.once('error', () => finish(false))
      socket.once('timeout', () => finish(false))
      socket.connect(port, ip)
    })
  }

  private async findAvailablePath(
    paths: string[],
    ip: string,
    port: number,
    username: string,
    password: string,
    timeoutMs: number
  ): Promise<string | null> {
    for (const path of paths) {
      const url = this.buildRtspUrl(ip, port, username, password, path)
      if (await this.probeRtspUrl(url, timeoutMs)) return path
    }

    return null
  }

  private probeRtspUrl(url: string, timeoutMs: number): Promise<boolean> {
    const ffmpegPath = ffmpegService.getFFmpegPath()
    const output = process.platform === 'win32' ? 'NUL' : '/dev/null'
    const args = [
      '-hide_banner',
      '-nostdin',
      '-loglevel',
      'error',
      '-rtsp_transport',
      'tcp',
      '-analyzeduration',
      '1000000',
      '-probesize',
      '1000000',
      '-i',
      url,
      '-map',
      '0:v:0',
      '-c:v',
      'copy',
      '-t',
      '2',
      '-f',
      'mpegts',
      output
    ]

    return new Promise((resolve) => {
      let settled = false
      let timeout: NodeJS.Timeout | null = null
      const child = spawn(ffmpegPath, args, {
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe']
      })

      const finish = (available: boolean): void => {
        if (settled) return
        settled = true
        if (timeout) clearTimeout(timeout)
        resolve(available)
      }

      child.stderr?.on('data', () => {})
      child.once('error', () => finish(false))
      child.once('close', (code) => finish(code === 0))

      timeout = setTimeout(() => {
        if (!settled) child.kill()
        finish(false)
      }, timeoutMs)
    })
  }
}

export const cameraProbeService = new CameraProbeService()
