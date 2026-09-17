import { spawn } from 'child_process'
import { ffmpegService } from '../ffmpeg.service'
import type { RecorderSnapshot } from './recorder-adapter'

export interface RtspSnapshotOptions {
  rtspUrl: string
  timeoutMs?: number
  signal?: AbortSignal
}

export class RecorderSnapshotService {
  public async captureFromRtsp(options: RtspSnapshotOptions): Promise<RecorderSnapshot | null> {
    const args = [
      '-hide_banner',
      '-nostdin',
      '-loglevel',
      'error',
      '-rtsp_transport',
      'tcp',
      '-i',
      options.rtspUrl,
      '-frames:v',
      '1',
      '-f',
      'image2pipe',
      '-vcodec',
      'mjpeg',
      'pipe:1'
    ]

    return new Promise((resolve) => {
      let settled = false
      let timeout: NodeJS.Timeout | null = null
      const chunks: Buffer[] = []
      const child = spawn(ffmpegService.getFFmpegPath(), args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore']
      })

      const finish = (result: RecorderSnapshot | null): void => {
        if (settled) return
        settled = true
        if (timeout) clearTimeout(timeout)
        options.signal?.removeEventListener('abort', abort)
        resolve(result)
      }
      const abort = (): void => {
        if (!settled) child.kill()
        finish(null)
      }

      options.signal?.addEventListener('abort', abort, { once: true })
      child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk))
      child.once('error', () => finish(null))
      child.once('close', (code) => {
        if (code !== 0 || chunks.length === 0) {
          finish(null)
          return
        }
        finish({ data: Buffer.concat(chunks), contentType: 'image/jpeg' })
      })
      timeout = setTimeout(() => {
        if (!settled) child.kill()
        finish(null)
      }, Math.min(Math.max(options.timeoutMs ?? 7000, 1000), 20000))
    })
  }
}

export const recorderSnapshotService = new RecorderSnapshotService()
