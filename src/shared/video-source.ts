export type RecorderVendor = 'hikvision' | 'dahua' | 'generic' | 'unknown'

export type RecorderDiscoveryMethod = 'onvif' | 'vendor' | 'rtsp-probe' | 'manual'

export interface DirectCameraSource {
  type: 'direct-camera'
  rtspKey: string
}

export interface RecorderSource {
  type: 'recorder'
  recorderId: string
  channelId: string
  channelNumber?: number
  stream: 'main' | 'sub'
  manualRtspKey?: string
  streamPaths?: {
    main?: string
    sub?: string
  }
}

export type VideoSource = DirectCameraSource | RecorderSource

export interface LocalCourt {
  id: string
  name: string
  created_at: string
  updated_at: string
  profile_id: string
  is_dvr: boolean
  video_source: VideoSource
}

export interface RecorderDeviceInfo {
  vendor: RecorderVendor
  model?: string
  serialNumber?: string
  firmware?: string
  onvifSupported?: boolean
}

export interface RecorderChannel {
  id: string
  number?: number
  name?: string
  enabled: boolean
  mainStreamAvailable?: boolean
  subStreamAvailable?: boolean
  snapshotAvailable?: boolean
  profileToken?: string
  streamIds?: {
    main?: string
    sub?: string
  }
}

export interface LocalRecorder {
  id: string
  name: string
  host: string
  httpPort?: number
  httpsPort?: number
  rtspPort: number
  vendor: RecorderVendor
  model?: string
  serialNumber?: string
  onvifSupported?: boolean
  lastSuccessfulConnectionAt?: string
  lastDetectedVendor?: RecorderVendor
  lastDetectedModel?: string
  profile_id: string
  created_at: string
  updated_at: string
}
