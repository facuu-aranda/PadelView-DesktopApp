import { spawn } from 'child_process'
import type {
  LocalRecorder,
  RecorderChannel,
  RecorderVendor
} from '../../../shared/video-source'
import { buildRtspUrl, type HttpCredentials } from './http-client'
import { ffmpegService } from '../ffmpeg.service'

export interface RecorderProbeOptions {
  recorder: LocalRecorder
  credentials: HttpCredentials
  vendor: RecorderVendor
  maxChannels?: number
  possibleChannels?: RecorderChannel[]
  timeoutMs?: number
  signal?: AbortSignal
  onProgress?: (progress: RecorderProbeProgress) => void
}

export interface RecorderProbeProgress {
  percent: number
  completed: number
  total: number
  found: RecorderChannel[]
}

interface ProbeCandidate {
  number: number
  path: string
  stream: 'main' | 'sub'
}

const DEFAULT_MAX_CHANNELS = 16
const MAX_CHANNELS = 64
const CONCURRENCY = 3

export class RecorderProbeService {
  public async probe(options: RecorderProbeOptions): Promise<RecorderChannel[]> {
    const maxChannels = Math.min(
      Math.max(Math.floor(options.maxChannels ?? DEFAULT_MAX_CHANNELS), 1),
      MAX_CHANNELS
    )
    const numbers = this.getCandidateNumbers(maxChannels, options.possibleChannels)
    const candidates = numbers.flatMap((number) =>
      this.buildCandidates(
        number,
        options.vendor,
        options.possibleChannels?.find((channel) => channel.number === number)
      )
    )
    const found = new Map<number, RecorderChannel>()
    let completed = 0

    for (let index = 0; index < candidates.length; index += CONCURRENCY) {
      this.throwIfCancelled(options.signal)
      const batch = candidates.slice(index, index + CONCURRENCY)
      const results = await Promise.all(
        batch.map(async (candidate) => ({
          candidate,
          available: await this.probeCandidate(candidate, options)
        }))
      )

      for (const result of results) {
        if (result.available) {
          const current = found.get(result.candidate.number) || {
            id: `probe:${result.candidate.number}`,
            number: result.candidate.number,
            name: `Canal ${result.candidate.number}`,
            enabled: true,
            mainStreamAvailable: false,
            subStreamAvailable: false,
            snapshotAvailable: false,
            streamIds: {}
          }
          current.streamIds = {
            ...current.streamIds,
            [result.candidate.stream]: result.candidate.path
          }
          current.mainStreamAvailable = Boolean(current.streamIds.main)
          current.subStreamAvailable = Boolean(current.streamIds.sub)
          found.set(result.candidate.number, current)
        }
      }

      completed += batch.length
      options.onProgress?.({
        percent: Math.round((completed / candidates.length) * 100),
        completed,
        total: candidates.length,
        found: [...found.values()]
      })
    }

    return [...found.values()].sort((left, right) => (left.number || 0) - (right.number || 0))
  }

  private getCandidateNumbers(maxChannels: number, possibleChannels?: RecorderChannel[]): number[] {
    const knownNumbers = (possibleChannels || []).flatMap((channel) => {
      const number = channel.number
      return typeof number === 'number' && Number.isInteger(number) && number > 0 ? [number] : []
    })
    if (knownNumbers.length > 0) return [...new Set(knownNumbers)]
    return Array.from({ length: maxChannels }, (_, index) => index + 1)
  }

  private buildCandidates(
    number: number,
    vendor: RecorderVendor,
    knownChannel?: RecorderChannel
  ): ProbeCandidate[] {
    const knownPaths = knownChannel?.streamIds
    const paths = knownPaths && (knownPaths.main || knownPaths.sub)
      ? [{ main: knownPaths.main || '', sub: knownPaths.sub || '' }]
      : this.pathsFor(number, vendor)
    return paths
      .flatMap((path) => [
        { number, path: path.main, stream: 'main' as const },
        { number, path: path.sub, stream: 'sub' as const }
      ])
      .filter(
        (candidate, index, all) =>
          all.findIndex((item) => item.path === candidate.path) === index
      )
  }

  private pathsFor(number: number, vendor: RecorderVendor): Array<{ main: string; sub: string }> {
    if (vendor === 'hikvision') {
      return [{ main: `/Streaming/Channels/${number}01`, sub: `/Streaming/Channels/${number}02` }]
    }
    if (vendor === 'dahua') {
      return [{ main: `/cam/realmonitor?channel=${number}&subtype=0`, sub: `/cam/realmonitor?channel=${number}&subtype=1` }]
    }
    return [
      { main: `/h264/ch${number}/main/av_stream`, sub: `/h264/ch${number}/sub/av_stream` },
      { main: `/Streaming/Channels/${number}01`, sub: `/Streaming/Channels/${number}02` },
      { main: `/cam/realmonitor?channel=${number}&subtype=0`, sub: `/cam/realmonitor?channel=${number}&subtype=1` }
    ]
  }

  private async probeCandidate(candidate: ProbeCandidate, options: RecorderProbeOptions): Promise<boolean> {
    this.throwIfCancelled(options.signal)
    const url = buildRtspUrl(
      options.recorder.host,
      options.recorder.rtspPort || 554,
      options.credentials,
      candidate.path
    )
    return this.probeRtspUrl(url, options.timeoutMs ?? 4500, options.signal)
  }

  private probeRtspUrl(url: string, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
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
      '-frames:v',
      '1',
      '-f',
      'null',
      output
    ]

    return new Promise((resolve) => {
      let settled = false
      let timeout: NodeJS.Timeout | null = null
      const child = spawn(ffmpegService.getFFmpegPath(), args, {
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'ignore']
      })
      const abort = (): void => {
        if (!settled) child.kill()
        finish(false)
      }
      const finish = (available: boolean): void => {
        if (settled) return
        settled = true
        if (timeout) clearTimeout(timeout)
        signal?.removeEventListener('abort', abort)
        resolve(available)
      }

      signal?.addEventListener('abort', abort, { once: true })
      child.once('error', () => finish(false))
      child.once('close', (code) => finish(code === 0))
      timeout = setTimeout(() => {
        if (!settled) child.kill()
        finish(false)
      }, timeoutMs)
    })
  }

  private throwIfCancelled(signal?: AbortSignal): void {
    if (signal?.aborted) throw new Error('La búsqueda de canales fue cancelada.')
  }
}

export const recorderProbeService = new RecorderProbeService()
