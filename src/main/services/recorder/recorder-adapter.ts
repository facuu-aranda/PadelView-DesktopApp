import type {
  LocalRecorder,
  RecorderChannel,
  RecorderDeviceInfo
} from '../../../shared/video-source'
import type { HttpCredentials } from './http-client'

export interface RecorderAdapterContext {
  recorder: LocalRecorder
  credentials: HttpCredentials
  signal?: AbortSignal
  timeoutMs?: number
  maxChannels?: number
}

export interface RecorderSnapshot {
  data: Uint8Array
  contentType: string
}

export interface RecorderAdapter {
  readonly vendor: 'hikvision' | 'dahua' | 'generic' | 'unknown'
  detectDevice(): Promise<RecorderDeviceInfo>
  authenticate(): Promise<boolean>
  getChannels(): Promise<RecorderChannel[]>
  getStreamUri(channel: RecorderChannel, stream: 'main' | 'sub'): Promise<string>
  getSnapshot?(channel: RecorderChannel): Promise<RecorderSnapshot | null>
}
