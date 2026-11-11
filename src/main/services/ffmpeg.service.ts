import { app } from 'electron'
import { spawn, ChildProcess } from 'child_process'
import path from 'path'
import fs from 'fs'
import { supportDiagnosticsService } from './support-diagnostics.service'

export interface RecordingProgress {
  matchId: string
  elapsedSeconds: number
  outputFilePath: string
}

export interface RecordingCompletion {
  elapsedSeconds: number
  durationSeconds: number
  partial: boolean
  manualStop: boolean
}

export interface RecordingOptions {
  matchId: string
  rtspUrl: string
  durationSeconds: number
  outputFilePath: string
  includeAudio?: boolean
  onProgress?: (progress: RecordingProgress) => void
  onComplete?: (outputFilePath: string, completion: RecordingCompletion) => void
  onError?: (error: Error) => void
}

class FFmpegService {
  private activeProcesses: Map<string, ChildProcess> = new Map()
  private progressIntervals: Map<string, NodeJS.Timeout> = new Map()
  private manualStopRequests: Set<string> = new Set()

  /**
   * Resolves the path to the ffmpeg executable.
   */
  public getFFmpegPath(): string {
    // If user has a custom path configured in vault/store, we could use that.
    // By default, we search in resources/bin/ffmpeg.exe
    const isDev = !app.isPackaged

    // In development, we can check if it's in resources/bin/ffmpeg.exe
    // or if there's a local fallback.
    const binaryName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'

    const resourcePath = isDev
      ? path.join(app.getAppPath(), 'resources', 'bin', binaryName)
      : path.join(process.resourcesPath, 'bin', binaryName)

    // Fallback: check if we can run it from system path or project root 'bin/'
    if (!fs.existsSync(resourcePath)) {
      const localBinPath = path.join(app.getAppPath(), 'bin', binaryName)
      if (fs.existsSync(localBinPath)) {
        return localBinPath
      }

      // Return the standard path and let spawn throw if it doesn't exist,
      // or try to run global 'ffmpeg'
      return isDev ? 'ffmpeg' : resourcePath
    }

    return resourcePath
  }

  /**
   * Starts a recording session for an RTSP camera stream.
   */
  public startRecording(options: RecordingOptions): void {
    const {
      matchId,
      rtspUrl,
      durationSeconds,
      outputFilePath,
      includeAudio = true,
      onProgress,
      onComplete,
      onError
    } = options

    if (this.activeProcesses.has(matchId)) {
      onError?.(new Error(`Recording already active for match: ${matchId}`))
      return
    }

    // Ensure the output folder exists
    const outputDir = path.dirname(outputFilePath)
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true })
    }

    const ffmpegPath = this.getFFmpegPath()
    const recordingStartedAt = new Date().toISOString()
    supportDiagnosticsService.record({
      level: 'info',
      event: 'recording.ffmpeg.started',
      component: 'ffmpeg',
      action: 'record',
      status: 'started',
      message: `FFmpeg inició la grabación ${matchId}.`,
      metadata: {
        matchId,
        ffmpegPath,
        durationSeconds,
        includeAudio,
        outputFilePath,
        startedAt: recordingStartedAt
      }
    })
    console.log(`Starting FFmpeg recording using: ${ffmpegPath}`)
    console.log('Starting recording from the configured local RTSP source.')
    console.log(`Output: ${outputFilePath}`)

    const args = [
      '-rtsp_transport',
      'tcp', // Force TCP to prevent artifacting/frame loss
      // FFmpeg's RTSP demuxer exposes -timeout in microseconds for socket I/O.
      '-timeout',
      '15000000', // Do not wait indefinitely for a network read (15 seconds)
      '-y', // Overwrite output files without asking
      '-i',
      rtspUrl, // Input URL
      '-t',
      durationSeconds.toString(), // Duration limit
      '-map',
      '0:v:0',
      '-c:v',
      'copy'
    ]

    if (includeAudio) {
      args.push('-map', '0:a?', '-c:a', 'copy')
    } else {
      args.push('-an')
    }

    args.push('-movflags', '+faststart', outputFilePath)

    try {
      const child = spawn(ffmpegPath, args)
      this.activeProcesses.set(matchId, child)

      let errorLog = ''
      let handled = false
      const startTime = Date.now()

      // Monitor recording duration & invoke progress callback
      const progressTimer = setInterval(() => {
        const elapsedSeconds = Math.floor((Date.now() - startTime) / 1000)
        onProgress?.({
          matchId,
          elapsedSeconds: Math.min(elapsedSeconds, durationSeconds),
          outputFilePath
        })
      }, 5000)

      this.progressIntervals.set(matchId, progressTimer)

      child.stderr?.on('data', (data) => {
        errorLog += data.toString()
        // Keep the tail: FFmpeg generally prints the most actionable error last.
        if (errorLog.length > 10000) {
          errorLog = errorLog.slice(-10000)
        }
      })

      child.on('error', (err) => {
        if (handled) return
        handled = true
        console.error(`FFmpeg process failed to spawn or crashed:`, err)
        this.cleanup(matchId)

        let customErr: Error = err
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          customErr = new Error(
            `FFmpeg binary not found at: ${ffmpegPath}. Please configure the static binary.`
          )
        }
        const stderr = this.redactRtspUrls(errorLog).trim()
        if (stderr) customErr.message += `\nFFmpeg stderr:\n${stderr}`
        supportDiagnosticsService.record({
          level: 'error',
          event: 'recording.ffmpeg.process_error',
          component: 'ffmpeg',
          action: 'record',
          status: 'failed',
          message: `FFmpeg no pudo iniciar o se cerró con un error para ${matchId}.`,
          metadata: { matchId, ffmpegPath, durationSeconds, outputFilePath },
          error: customErr
        })
        onError?.(customErr)
      })

      child.on('close', (code, signal) => {
        if (handled) return
        handled = true
        const elapsedSeconds = Math.floor((Date.now() - startTime) / 1000)
        const manualStopRequested = this.manualStopRequests.delete(matchId)
        const outputExists = fs.existsSync(outputFilePath)
        const outputSize = outputExists ? fs.statSync(outputFilePath).size : 0
        const stderr = this.redactRtspUrls(errorLog).trim()
        const durationToleranceSeconds = Math.max(5, durationSeconds * 0.05)
        const reachedExpectedDuration = elapsedSeconds + durationToleranceSeconds >= durationSeconds

        console.log(
          `FFmpeg process for match ${matchId} closed with exit code ${code}, signal ${signal ?? 'none'}, ` +
            `elapsed ${elapsedSeconds}s/${durationSeconds}s`
        )
        this.cleanup(matchId)

        if (code === 0 && outputSize > 0 && reachedExpectedDuration) {
          supportDiagnosticsService.record({
            level: 'info',
            event: 'recording.ffmpeg.completed',
            component: 'ffmpeg',
            action: 'record',
            status: 'success',
            message: `FFmpeg completó la grabación ${matchId}.`,
            durationMs: elapsedSeconds * 1000,
            metadata: {
              matchId,
              exitCode: code,
              signal,
              elapsedSeconds,
              durationSeconds,
              outputSize,
              outputExists,
              outputFilePath
            }
          })
          onComplete?.(outputFilePath, {
            elapsedSeconds,
            durationSeconds,
            partial: false,
            manualStop: false
          })
          return
        }

        // A clean user-requested stop may produce a valid partial file. This is
        // intentionally explicit; code === null alone never means completion.
        if (manualStopRequested && outputSize > 1024 * 1024 && (code === 0 || code === null)) {
          console.log(`Recording for match ${matchId} stopped manually; saving partial file.`)
          supportDiagnosticsService.record({
            level: 'info',
            event: 'recording.ffmpeg.partial',
            component: 'ffmpeg',
            action: 'record',
            status: 'success',
            message: `FFmpeg guardó una grabación parcial solicitada manualmente para ${matchId}.`,
            durationMs: elapsedSeconds * 1000,
            metadata: {
              matchId,
              exitCode: code,
              signal,
              elapsedSeconds,
              durationSeconds,
              outputSize,
              outputFilePath
            }
          })
          onComplete?.(outputFilePath, {
            elapsedSeconds,
            durationSeconds,
            partial: true,
            manualStop: true
          })
          return
        }

        const status = code === null ? `signal ${signal ?? 'unknown'}` : `exit code ${code}`
        const reason =
          code === 0
            ? `terminated prematurely after ${elapsedSeconds}s (expected ${durationSeconds}s)`
            : `terminated with ${status} after ${elapsedSeconds}s`
        const details = stderr ? `\nFFmpeg stderr:\n${stderr}` : '\nFFmpeg stderr: (empty)'
        const recordingError = new Error(`FFmpeg recording ${reason}.${details}`)
        supportDiagnosticsService.record({
          level: 'error',
          event: 'recording.ffmpeg.failed',
          component: 'ffmpeg',
          action: 'record',
          status: 'failed',
          message: `FFmpeg falló durante la grabación ${matchId}: ${reason}.`,
          durationMs: elapsedSeconds * 1000,
          metadata: {
            matchId,
            exitCode: code,
            signal,
            elapsedSeconds,
            durationSeconds,
            outputSize,
            outputExists,
            reachedExpectedDuration,
            manualStopRequested,
            outputFilePath,
            stderrTail: stderr || null
          },
          error: recordingError
        })
        onError?.(recordingError)
      })
    } catch (err) {
      console.error(`Error spawning FFmpeg:`, err)
      supportDiagnosticsService.record({
        level: 'error',
        event: 'recording.ffmpeg.spawn_failed',
        component: 'ffmpeg',
        action: 'spawn',
        status: 'failed',
        message: `No se pudo iniciar FFmpeg para la grabación ${matchId}.`,
        metadata: { matchId, ffmpegPath, durationSeconds, outputFilePath },
        error: err
      })
      this.cleanup(matchId)
      onError?.(err as Error)
    }
  }

  /**
   * Force stop/kill an active recording session.
   */
  public killRecording(matchId: string): boolean {
    const child = this.activeProcesses.get(matchId)
    if (child) {
      console.log(`Stopping active recording cleanly via stdin for match: ${matchId}`)
      supportDiagnosticsService.record({
        level: 'info',
        event: 'recording.ffmpeg.stop_requested',
        component: 'ffmpeg',
        action: 'stop',
        status: 'started',
        message: `Se solicitó detener manualmente FFmpeg para ${matchId}.`,
        metadata: { matchId }
      })
      this.manualStopRequests.add(matchId)
      try {
        if (child.stdin && child.stdin.writable) {
          child.stdin.write('q\n')
          child.stdin.end()
          // Let the 'close' event trigger the cleanup naturally
          return true
        }
      } catch (err) {
        console.error(`Failed to write 'q' to FFmpeg stdin, falling back to process kill:`, err)
      }

      // Fallback if stdin is not writable or writing failed
      const killed = child.kill('SIGTERM') || child.kill('SIGKILL')
      this.cleanup(matchId)
      return killed
    }
    return false
  }

  /**
   * Check if a match is currently being recorded.
   */
  public isRecording(matchId: string): boolean {
    return this.activeProcesses.has(matchId)
  }

  /**
   * Get total count of active recordings.
   */
  public getActiveCount(): number {
    return this.activeProcesses.size
  }

  private redactRtspUrls(value: string): string {
    return value.replace(/rtsp:\/\/[^\s"'<>]+/gi, 'rtsp://[redacted]')
  }

  /**
   * Cleanup process references and intervals.
   */
  private cleanup(matchId: string): void {
    this.activeProcesses.delete(matchId)
    this.manualStopRequests.delete(matchId)

    const interval = this.progressIntervals.get(matchId)
    if (interval) {
      clearInterval(interval)
      this.progressIntervals.delete(matchId)
    }
  }
}

export const ffmpegService = new FFmpegService()
