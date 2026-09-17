import { createHash, randomBytes } from 'crypto'

export interface SnapshotOptions {
  rtspUrl: string
  httpPort?: number
}

export interface SnapshotResult {
  data: Uint8Array
  contentType: string
}

class CameraSnapshotService {
  public async getSnapshot(options: SnapshotOptions): Promise<SnapshotResult> {
    const rtspUrl = new URL(options.rtspUrl)
    if (rtspUrl.protocol !== 'rtsp:') {
      throw new Error('La URL de la cámara no es RTSP.')
    }

    const channel = this.extractChannel(rtspUrl)
    if (!channel) {
      throw new Error('No se pudo determinar el canal Hikvision desde la URL RTSP.')
    }

    const httpPort = options.httpPort ?? 80
    if (!Number.isInteger(httpPort) || httpPort < 1 || httpPort > 65535) {
      throw new Error('El puerto HTTP de la cámara no es válido.')
    }

    const username = decodeURIComponent(rtspUrl.username)
    const password = decodeURIComponent(rtspUrl.password)
    const snapshotUrl = `http://${rtspUrl.hostname}:${httpPort}/ISAPI/Streaming/channels/${channel}/picture`

    let response = await fetch(snapshotUrl)
    if (response.status === 401) {
      const challenge = response.headers.get('www-authenticate')
      if (!challenge) throw new Error('El DVR requiere autenticación Digest sin enviar desafío.')

      response = await fetch(snapshotUrl, {
        headers: {
          Authorization: this.createDigestAuthorization(challenge, username, password, snapshotUrl)
        }
      })
    }

    if (!response.ok) {
      throw new Error(`El DVR no pudo entregar el snapshot (${response.status}).`)
    }

    return {
      data: new Uint8Array(await response.arrayBuffer()),
      contentType: response.headers.get('content-type') || 'image/jpeg'
    }
  }

  private extractChannel(rtspUrl: URL): string | null {
    const channelMatch = rtspUrl.pathname.match(/channels?\/(\d+)/i)
    if (channelMatch?.[1]) return channelMatch[1]

    const channelParam = rtspUrl.searchParams.get('channel')
    if (!channelParam || !/^\d+$/.test(channelParam)) return null

    return `${Number(channelParam) * 100 + 1}`
  }

  private createDigestAuthorization(
    challenge: string,
    username: string,
    password: string,
    requestUrl: string
  ): string {
    const values = this.parseDigestChallenge(challenge)
    if (!values.realm || !values.nonce) {
      throw new Error('El desafío Digest del DVR es inválido.')
    }

    const uri = new URL(requestUrl).pathname
    const qop = values.qop
      ?.split(',')
      .map((value) => value.trim())
      .find((value) => value === 'auth')
    const nc = '00000001'
    const cnonce = randomBytes(16).toString('hex')
    const ha1 = this.md5(`${username}:${values.realm}:${password}`)
    const ha2 = this.md5(`GET:${uri}`)
    const response = qop
      ? this.md5(`${ha1}:${values.nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
      : this.md5(`${ha1}:${values.nonce}:${ha2}`)

    const parts = [
      `username="${this.escapeHeaderValue(username)}"`,
      `realm="${this.escapeHeaderValue(values.realm)}"`,
      `nonce="${this.escapeHeaderValue(values.nonce)}"`,
      `uri="${uri}"`,
      `response="${response}"`
    ]

    if (values.algorithm) parts.push(`algorithm=${values.algorithm}`)
    if (values.opaque) parts.push(`opaque="${this.escapeHeaderValue(values.opaque)}"`)
    if (qop) {
      parts.push(`qop=${qop}`)
      parts.push(`nc=${nc}`)
      parts.push(`cnonce="${cnonce}"`)
    }

    return `Digest ${parts.join(', ')}`
  }

  private parseDigestChallenge(challenge: string): Record<string, string> {
    const digestChallenge = challenge.replace(/^Digest\s+/i, '')
    const values: Record<string, string> = {}
    const expression = /([a-zA-Z][a-zA-Z0-9_-]*)=("(?:\\.|[^"])*"|[^,\s]+)/g
    let match: RegExpExecArray | null

    while ((match = expression.exec(digestChallenge))) {
      values[match[1]] = match[2].replace(/^"|"$/g, '').replace(/\\([\\"])/g, '$1')
    }

    return values
  }

  private md5(value: string): string {
    return createHash('md5').update(value).digest('hex')
  }

  private escapeHeaderValue(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  }
}

export const cameraSnapshotService = new CameraSnapshotService()
