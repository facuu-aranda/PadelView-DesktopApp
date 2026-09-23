import type {
  LocalRecorder,
  RecorderChannel,
  RecorderDeviceInfo,
  RecorderDiscoveryMethod,
  RecorderSource,
  RecorderVendor,
  VideoSource
} from '../../../shared/video-source'
import { vaultService } from '../vault.service'
import { recorderStoreService } from './recorder-store.service'
import {
  RecorderAuthError,
  type HttpCredentials
} from './http-client'
import type { RecorderAdapter, RecorderAdapterContext, RecorderSnapshot } from './recorder-adapter'
import { OnvifAdapter } from './adapters/onvif.adapter'
import { HikvisionAdapter } from './adapters/hikvision.adapter'
import { DahuaAdapter } from './adapters/dahua.adapter'
import { GenericRtspAdapter } from './adapters/generic-rtsp.adapter'
import { recorderProbeService, type RecorderProbeProgress } from './recorder-probe.service'
import { recorderSnapshotService } from './recorder-snapshot.service'

export interface RecorderDiscoveryResult {
  recorder: LocalRecorder
  device: RecorderDeviceInfo
  channels: RecorderChannel[]
  method: RecorderDiscoveryMethod
}

export interface RecorderDiscoveryOptions {
  maxChannels?: number
  timeoutMs?: number
  signal?: AbortSignal
  onProgress?: (progress: RecorderServiceProgress) => void
}

export interface RecorderServiceProgress {
  phase: 'connecting' | 'detecting' | 'loading-channels' | 'probing' | 'loading-previews'
  percent: number
  found?: RecorderChannel[]
}

export class RecorderService {
  public list(profileId: string): LocalRecorder[] {
    return recorderStoreService.list(profileId)
  }

  public get(recorderId: string, profileId: string): LocalRecorder {
    const recorder = recorderStoreService.getById(recorderId, profileId)
    if (!recorder) throw new Error('El grabador no existe o no pertenece al usuario actual.')
    return recorder
  }

  public create(input: Parameters<typeof recorderStoreService.create>[0]): LocalRecorder {
    return recorderStoreService.create(input)
  }

  public update(
    recorderId: string,
    profileId: string,
    updates: Parameters<typeof recorderStoreService.update>[2]
  ): LocalRecorder {
    return recorderStoreService.update(recorderId, profileId, updates)
  }

  public delete(recorderId: string, profileId: string): boolean {
    return recorderStoreService.delete(recorderId, profileId)
  }

  public async discover(
    recorderId: string,
    profileId: string,
    options: RecorderDiscoveryOptions = {}
  ): Promise<RecorderDiscoveryResult> {
    const recorder = this.get(recorderId, profileId)
    const credentials = recorderStoreService.getCredentials(recorderId, profileId)
    if (!credentials.username || !credentials.password) {
      throw new RecorderAuthError(recorder.host)
    }

    options.onProgress?.({ phase: 'connecting', percent: 5 })
    const baseContext = this.createContext(recorder, credentials, options)
    let authError: unknown = null
    let detectedDevice: RecorderDeviceInfo = {
      vendor: recorder.vendor || 'unknown',
      onvifSupported: false
    }

    options.onProgress?.({ phase: 'detecting', percent: 15 })
    try {
      const onvif = new OnvifAdapter(baseContext)
      await onvif.authenticate()
      detectedDevice = await onvif.detectDevice()
      options.onProgress?.({ phase: 'loading-channels', percent: 30 })
      const channels = await onvif.getChannels()
      if (channels.length > 0) {
        recorderStoreService.markDiscovery(recorderId, profileId, detectedDevice)
        return {
          recorder: this.get(recorderId, profileId),
          device: detectedDevice,
          channels,
          method: 'onvif'
        }
      }
    } catch (error) {
      authError = error instanceof RecorderAuthError ? error : authError
    }

    const vendor = this.resolveVendor(recorder, detectedDevice)
    if (vendor === 'hikvision' || vendor === 'dahua') {
      try {
        const adapter = this.createAdapter({ ...baseContext, recorder: this.get(recorderId, profileId) }, vendor)
        await adapter.authenticate()
        detectedDevice = await adapter.detectDevice()
        options.onProgress?.({ phase: 'loading-channels', percent: 45 })
        const channels = await adapter.getChannels()
        if (channels.length > 0) {
          recorderStoreService.markDiscovery(recorderId, profileId, detectedDevice)
          return {
            recorder: this.get(recorderId, profileId),
            device: detectedDevice,
            channels,
            method: 'vendor'
          }
        }
      } catch (error) {
        authError = error instanceof RecorderAuthError ? error : authError
      }
    }

    options.onProgress?.({ phase: 'probing', percent: 55 })
    const probeRecorder = this.get(recorderId, profileId)
    const probeResult = await recorderProbeService.probe({
      recorder: probeRecorder,
      credentials,
      vendor,
      maxChannels: options.maxChannels,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      onProgress: (progress) => options.onProgress?.(this.toProbeProgress(progress))
    })

    if (probeResult.length === 0) {
      if (authError) throw authError
      throw new Error('No se encontraron canales válidos en el grabador.')
    }

    const fallbackDevice: RecorderDeviceInfo = {
      ...detectedDevice,
      vendor: vendor === 'unknown' ? 'unknown' : vendor,
      onvifSupported: detectedDevice.onvifSupported || false
    }
    recorderStoreService.markDiscovery(recorderId, profileId, fallbackDevice)
    return {
      recorder: this.get(recorderId, profileId),
      device: fallbackDevice,
      channels: probeResult,
      method: 'rtsp-probe'
    }
  }

  public async listChannels(
    recorderId: string,
    profileId: string,
    options: RecorderDiscoveryOptions = {}
  ): Promise<RecorderDiscoveryResult> {
    return this.discover(recorderId, profileId, options)
  }

  public async getStreamUri(
    recorderId: string,
    profileId: string,
    channel: RecorderChannel,
    stream: 'main' | 'sub'
  ): Promise<string> {
    const recorder = this.get(recorderId, profileId)
    const credentials = recorderStoreService.getCredentials(recorderId, profileId)
    const adapter = this.createAdapter(
      this.createContext(recorder, credentials, {}),
      this.adapterVendor(recorder, channel)
    )
    return adapter.getStreamUri(channel, stream)
  }

  public async getSnapshot(
    recorderId: string,
    profileId: string,
    channel: RecorderChannel
  ): Promise<RecorderSnapshot | null> {
    const recorder = this.get(recorderId, profileId)
    const credentials = recorderStoreService.getCredentials(recorderId, profileId)
    const adapter = this.createAdapter(
      this.createContext(recorder, credentials, {}),
      this.adapterVendor(recorder, channel)
    )
    const mainUri = await adapter.getStreamUri(channel, 'sub').catch(() => adapter.getStreamUri(channel, 'main'))
    const snapshot = adapter.getSnapshot ? await adapter.getSnapshot(channel).catch(() => null) : null
    return snapshot || recorderSnapshotService.captureFromRtsp({ rtspUrl: mainUri })
  }

  public async testChannel(
    recorderId: string,
    profileId: string,
    channel: RecorderChannel,
    stream: 'main' | 'sub' = 'main',
    signal?: AbortSignal
  ): Promise<boolean> {
    const recorder = this.get(recorderId, profileId)
    const credentials = recorderStoreService.getCredentials(recorderId, profileId)
    const adapter = this.createAdapter(
      this.createContext(recorder, credentials, { signal }),
      this.adapterVendor(recorder, channel)
    )
    const uri = await adapter.getStreamUri(channel, stream)
    const parsedUri = new URL(uri)
    const streamPath = `${parsedUri.pathname}${parsedUri.search}`
    const result = await recorderProbeService.probe({
      recorder,
      credentials,
      vendor: this.adapterVendor(recorder, channel),
      possibleChannels: [{ ...channel, streamIds: { [stream]: streamPath } }],
      maxChannels: 1,
      timeoutMs: 5000,
      signal
    })
    return result.some((candidate) => candidate.number === channel.number)
  }

  public async resolveVideoSource(
    source: VideoSource,
    profileId: string,
    purpose: 'recording' | 'preview' = 'recording'
  ): Promise<{ recordingUrl: string; previewUrl?: string }> {
    if (source.type === 'direct-camera') {
      const url = vaultService.getSecret(source.rtspKey)
      if (!url) throw new Error('La fuente RTSP de la cámara no está configurada localmente.')
      return { recordingUrl: url, previewUrl: url }
    }

    if (source.manualRtspKey) {
      const manualUrl = vaultService.getSecret(source.manualRtspKey)
      if (manualUrl) return { recordingUrl: manualUrl, previewUrl: manualUrl }
    }

    const channel: RecorderChannel = {
      id: source.channelId,
      number: source.channelNumber,
      enabled: true,
      mainStreamAvailable: true,
      subStreamAvailable: true,
      streamIds: source.streamPaths
    }
    const recordingStream = source.stream || 'main'
    const recordingUrl = await this.getStreamUri(
      source.recorderId,
      profileId,
      channel,
      recordingStream
    )
    const previewStream = source.stream === 'sub' ? 'sub' : 'main'
    const previewUrl = await this.getStreamUri(
      source.recorderId,
      profileId,
      channel,
      previewStream
    ).catch(() => recordingUrl)
    return {
      recordingUrl: purpose === 'preview' ? previewUrl : recordingUrl,
      previewUrl
    }
  }

  private createContext(
    recorder: LocalRecorder,
    credentials: HttpCredentials,
    options: RecorderDiscoveryOptions
  ): RecorderAdapterContext {
    return {
      recorder,
      credentials,
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? 6000,
      maxChannels: options.maxChannels
    }
  }

  private createAdapter(
    context: RecorderAdapterContext,
    vendor: RecorderVendor
  ): RecorderAdapter {
    if (vendor === 'hikvision') return new HikvisionAdapter(context)
    if (vendor === 'dahua') return new DahuaAdapter(context)
    if (vendor === 'unknown') return new OnvifAdapter(context)
    return new GenericRtspAdapter(context)
  }

  private resolveVendor(recorder: LocalRecorder, device: RecorderDeviceInfo): RecorderVendor {
    if (device.vendor === 'hikvision' || device.vendor === 'dahua') return device.vendor
    if (recorder.vendor === 'hikvision' || recorder.vendor === 'dahua') return recorder.vendor
    if (recorder.lastDetectedVendor === 'hikvision' || recorder.lastDetectedVendor === 'dahua') {
      return recorder.lastDetectedVendor
    }
    return 'unknown'
  }

  private adapterVendor(recorder: LocalRecorder, channel: RecorderChannel): RecorderVendor {
    if (channel.id.startsWith('onvif:')) return 'unknown'
    if (channel.id.startsWith('hikvision:')) return 'hikvision'
    if (channel.id.startsWith('dahua:')) return 'dahua'
    if (recorder.lastDetectedVendor === 'hikvision' || recorder.lastDetectedVendor === 'dahua') {
      return recorder.lastDetectedVendor
    }
    if (recorder.vendor === 'hikvision' || recorder.vendor === 'dahua') return recorder.vendor
    return 'generic'
  }

  private toProbeProgress(progress: RecorderProbeProgress): RecorderServiceProgress {
    return {
      phase: 'probing',
      percent: 55 + Math.round(progress.percent * 0.45),
      found: progress.found
    }
  }
}

export const recorderService = new RecorderService()
export type { RecorderSource }
