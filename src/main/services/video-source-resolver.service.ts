import type { VideoSource } from '../../shared/video-source'
import { localCourtService } from './local-court.service'
import { recorderService } from './recorder/recorder.service'

export interface ResolvedVideoSource {
  recordingUrl: string
  previewUrl?: string
  source: VideoSource
}

class VideoSourceResolverService {
  public async resolveVideoSource(
    courtId: string,
    profileId: string,
    purpose: 'recording' | 'preview' = 'recording'
  ): Promise<ResolvedVideoSource> {
    const court = localCourtService.getById(courtId, profileId)
    if (!court) throw new Error('La configuración local de la cancha no existe.')

    const resolved = await recorderService.resolveVideoSource(court.video_source, profileId, purpose)
    return { ...resolved, source: court.video_source }
  }

  public async resolveSource(
    source: VideoSource,
    profileId: string,
    purpose: 'recording' | 'preview' = 'recording'
  ): Promise<ResolvedVideoSource> {
    const resolved = await recorderService.resolveVideoSource(source, profileId, purpose)
    return { ...resolved, source }
  }
}

export const videoSourceResolver = new VideoSourceResolverService()
