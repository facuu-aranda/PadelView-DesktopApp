import { app } from 'electron'
import { spawn, type ChildProcess } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { RecorderSource } from '../../shared/video-source'
import { recorderService } from './recorder/recorder.service'

export type MediaMtxPreviewProfile = 'main' | 'sub'

export interface MediaMtxPreviewHandle {
  key: string
  pathName: string
  whepUrl: string
  localRtspUrl: string
  profile: MediaMtxPreviewProfile
}

interface ActivePath {
  handle: MediaMtxPreviewHandle
  references: number
  releaseTimer?: NodeJS.Timeout
}

const API_PORT = 9997
const RTSP_PORT = 8554
const WEBRTC_PORT = 8889

export class MediaMtxService {
  private process: ChildProcess | null = null
  private configPath: string | null = null
  private readonly activePaths = new Map<string, ActivePath>()
  private startupPromise: Promise<void> | null = null

  public async startPreview(
    source: RecorderSource,
    profileId: string,
    profile: MediaMtxPreviewProfile = 'sub'
  ): Promise<MediaMtxPreviewHandle> {
    const key = this.getStreamKey(source, profile)
    const current = this.activePaths.get(key)
    if (current) {
      if (current.releaseTimer) clearTimeout(current.releaseTimer)
      current.releaseTimer = undefined
      current.references += 1
      return current.handle
    }

    await this.ensureStarted()
    console.log(`[MediaMTX] resolving DVR ${source.recorderId} channel ${source.channelNumber || source.channelId} profile ${profile}`)
    const resolvedSource = await recorderService.resolveVideoSource(
      { ...source, stream: profile },
      profileId,
      'preview'
    )
    const inputUrl = profile === 'main' ? resolvedSource.recordingUrl : resolvedSource.previewUrl || resolvedSource.recordingUrl
    const pathName = this.pathNameFor(source, profile)

    await this.ensurePath(pathName, inputUrl)
    console.log(`[MediaMTX] path ready: ${pathName}`)
    const handle: MediaMtxPreviewHandle = {
      key,
      pathName,
      profile,
      localRtspUrl: `rtsp://127.0.0.1:${RTSP_PORT}/${pathName}`,
      whepUrl: `http://127.0.0.1:${WEBRTC_PORT}/${pathName}/whep`
    }
    this.activePaths.set(key, { handle, references: 1 })
    return handle
  }

  public async stopPreview(handle: Pick<MediaMtxPreviewHandle, 'key' | 'pathName'>): Promise<void> {
    const active = this.activePaths.get(handle.key)
    if (!active) return
    active.references -= 1
    if (active.references > 0) return

    active.releaseTimer = setTimeout(() => {
      void this.removePath(active.handle.pathName)
      this.activePaths.delete(handle.key)
    }, 10000)
  }

  public async stop(): Promise<void> {
    for (const active of this.activePaths.values()) {
      if (active.releaseTimer) clearTimeout(active.releaseTimer)
    }
    this.activePaths.clear()
    if (this.process) {
      this.process.kill()
      this.process = null
    }
    if (this.configPath) {
      try {
        fs.unlinkSync(this.configPath)
      } catch {
        // The temporary configuration may already have been removed.
      }
      this.configPath = null
    }
  }

  private async ensureStarted(): Promise<void> {
    if (this.process && !this.process.killed) return
    if (this.startupPromise) return this.startupPromise

    this.startupPromise = this.startProcess()
    try {
      await this.startupPromise
    } finally {
      this.startupPromise = null
    }
  }

  private async startProcess(): Promise<void> {
    const binaryPath = this.findBinary()
    console.log('[MediaMTX] starting embedded/local relay')
    const configPath = path.join(app.getPath('userData'), 'mediamtx-viewpadel.yml')
    fs.writeFileSync(configPath, this.buildConfig(), 'utf8')
    this.configPath = configPath

    this.process = spawn(binaryPath, [configPath], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    this.process.stdout?.on('data', (data: Buffer) => {
      const message = sanitizeMediaMtxLog(data.toString())
      if (message) console.log(`[MediaMTX] ${message}`)
    })
    this.process.stderr?.on('data', (data: Buffer) => {
      const message = sanitizeMediaMtxLog(data.toString())
      if (message) console.error(`[MediaMTX] ${message}`)
    })
    this.process.once('error', (error) => {
      console.error('[MediaMTX] process error:', error.message)
      this.process = null
    })
    this.process.once('close', (code) => {
      console.log(`[MediaMTX] process closed with exit code ${code}`)
      this.process = null
    })

    const deadline = Date.now() + 10000
    while (Date.now() < deadline) {
      if (await this.isApiReady()) {
        console.log('[MediaMTX] local API ready')
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    throw new Error('MediaMTX no respondió en el puerto API local.')
  }

  private async ensurePath(pathName: string, source: string): Promise<void> {
    const response = await fetch(`http://127.0.0.1:${API_PORT}/v3/config/paths/add/${encodeURIComponent(pathName)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source, sourceOnDemand: true, rtspTransport: 'tcp' })
    })
    if (!response.ok && response.status !== 400) {
      throw new Error(`MediaMTX no pudo crear el path local (${response.status}).`)
    }
  }

  private async removePath(pathName: string): Promise<void> {
    await fetch(`http://127.0.0.1:${API_PORT}/v3/config/paths/delete/${encodeURIComponent(pathName)}`, {
      method: 'DELETE'
    }).catch(() => undefined)
  }

  private async isApiReady(): Promise<boolean> {
    try {
      const response = await fetch(`http://127.0.0.1:${API_PORT}/v3/config/paths/list`)
      return response.ok
    } catch {
      return false
    }
  }

  private findBinary(): string {
    const binaryName = process.platform === 'win32' ? 'mediamtx.exe' : 'mediamtx'
    const candidates = [
      process.env.MEDIAMTX_PATH,
      path.join(process.resourcesPath, 'bin', binaryName),
      path.join(app.getAppPath(), 'resources', 'bin', binaryName),
      path.join(app.getAppPath(), 'bin', binaryName),
      path.resolve(app.getAppPath(), '..', 'mediamtx_v1.19.2_windows_amd64', 'mediamtx_v1.19.2_windows_amd64', binaryName)
    ].filter((candidate): candidate is string => Boolean(candidate))

    const found = candidates.find((candidate) => fs.existsSync(candidate))
    if (!found) {
      throw new Error('No se encontró MediaMTX. La instalación productiva debe incluir resources/bin/mediamtx.')
    }
    return found
  }

  private buildConfig(): string {
    return [
      'logLevel: warn',
      'rtsp: true',
      'rtspTransports: [tcp]',
      `rtspAddress: 127.0.0.1:${RTSP_PORT}`,
      'rtpAddress: 127.0.0.1:18000',
      'rtcpAddress: 127.0.0.1:18001',
      'api: true',
      `apiAddress: 127.0.0.1:${API_PORT}`,
      'rtmp: false',
      'srt: false',
      'moq: false',
      'playback: false',
      'metrics: false',
      'pprof: false',
      'authMethod: internal',
      'authInternalUsers:',
      '  - user: any',
      '    pass:',
      '    ips: []',
      '    permissions:',
      '      - action: read',
      '        path:',
      '      - action: api',
      'hls: false',
      'webrtc: true',
      `webrtcAddress: 127.0.0.1:${WEBRTC_PORT}`,
      'webrtcLocalUDPAddress: 127.0.0.1:18189',
      'webrtcLocalTCPAddress: 127.0.0.1:18190',
      'webrtcAllowOrigins: ["*"]',
      'paths: {}',
      ''
    ].join(os.EOL)
  }

  private getStreamKey(source: RecorderSource, profile: MediaMtxPreviewProfile): string {
    return `${source.recorderId}:${source.channelId}:${source.channelNumber || 0}:${profile}`
  }

  private pathNameFor(source: RecorderSource, profile: MediaMtxPreviewProfile): string {
    const safe = `${source.recorderId}_${source.channelNumber || source.channelId}_${profile}`.replace(/[^a-zA-Z0-9_-]/g, '_')
    return `viewpadel_dvr_${safe}`
  }
}

export const mediaMtxService = new MediaMtxService()

function sanitizeMediaMtxLog(value: string): string {
  return value
    .replace(/rtsp:\/\/[^\s@]+@/gi, 'rtsp://[redacted]@')
    .replace(/\r?\n/g, ' ')
    .trim()
}
