import { S3Client, GetObjectCommand, ListObjectsV2Command, ListObjectsV2CommandOutput } from '@aws-sdk/client-s3'
import { Upload } from '@aws-sdk/lib-storage'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { vaultService } from './vault.service'
import fs from 'fs'

export interface UploadProgress {
  matchId: string
  loaded: number
  total: number
  percentage: number
}

export interface UploadOptions {
  matchId: string
  localFilePath: string
  destinationKey: string // e.g. 'videos/cancha_1/20260710_match_uuid.mp4'
  onProgress?: (progress: UploadProgress) => void
}

class R2Service {
  private activeUploads: Map<string, Upload> = new Map()

  /**
   * Helper to construct S3Client based on secrets currently saved in vault.
   */
  private getS3Client(): { client: S3Client; bucket: string } {
    const accessKeyId = vaultService.getSecret('R2_ACCESS_KEY_ID')
    const secretAccessKey = vaultService.getSecret('R2_SECRET_ACCESS_KEY')
    const endpoint = vaultService.getSecret('R2_ENDPOINT')
    const bucket = vaultService.getSecret('R2_BUCKET_NAME') || 'padelview-matches'

    if (!accessKeyId || !secretAccessKey || !endpoint) {
      throw new Error(
        'Cloudflare R2 configuration missing. Please save R2 credentials in configuration.'
      )
    }

    const client = new S3Client({
      region: 'auto',
      endpoint: endpoint,
      credentials: {
        accessKeyId,
        secretAccessKey
      }
    })

    return { client, bucket }
  }

  /**
   * Performs a multipart upload of a large video file to Cloudflare R2 bucket.
   */
  public async uploadVideo(options: UploadOptions): Promise<string> {
    const { matchId, localFilePath, destinationKey, onProgress } = options

    if (!fs.existsSync(localFilePath)) {
      throw new Error(`Local file not found for upload: ${localFilePath}`)
    }

    if (this.activeUploads.has(matchId)) {
      throw new Error(`Upload already in progress for match: ${matchId}`)
    }

    const { client, bucket } = this.getS3Client()
    const fileStream = fs.createReadStream(localFilePath)
    const fileStats = fs.statSync(localFilePath)
    const fileSize = fileStats.size

    console.log(
      `Starting multipart upload to R2: ${destinationKey} (${(fileSize / (1024 * 1024)).toFixed(2)} MB)`
    )

    try {
      const upload = new Upload({
        client,
        params: {
          Bucket: bucket,
          Key: destinationKey,
          Body: fileStream,
          ContentType: 'video/mp4'
        },
        queueSize: 4, // Concurrent upload parts
        partSize: 5 * 1024 * 1024 // 5 MB part size
      })

      this.activeUploads.set(matchId, upload)

      // Track progress
      upload.on('httpUploadProgress', (progress) => {
        const loaded = progress.loaded || 0
        const total = progress.total || fileSize
        const percentage = Math.min(Math.round((loaded / total) * 100), 100)

        onProgress?.({
          matchId,
          loaded,
          total,
          percentage
        })
      })

      // Execute upload
      await upload.done()
      console.log(`Multipart upload finished successfully for match: ${matchId}`)

      this.activeUploads.delete(matchId)
      return destinationKey
    } catch (error) {
      console.error(`Upload failed for match ${matchId}:`, error)
      this.activeUploads.delete(matchId)
      throw error
    }
  }

  /**
   * Cancel an ongoing upload.
   */
  public async cancelUpload(matchId: string): Promise<boolean> {
    const upload = this.activeUploads.get(matchId)
    if (upload) {
      console.log(`Aborting upload for match: ${matchId}`)
      try {
        await upload.abort()
        this.activeUploads.delete(matchId)
        return true
      } catch (err) {
        console.error(`Error aborting upload for match: ${matchId}`, err)
      }
    }
    return false
  }

  /**
   * Check if a match is currently uploading.
   */
  public isUploading(matchId: string): boolean {
    return this.activeUploads.has(matchId)
  }
  public async getSignedVideoUrl(key: string, expiresIn: number = 3600, forDownload: boolean = false): Promise<string> {
    try {
      const { client, bucket } = this.getS3Client()
      const command = new GetObjectCommand({
        Bucket: bucket,
        Key: key,
        ...(forDownload ? { ResponseContentDisposition: `attachment; filename="${key.split('/').pop()}"` } : {})
      })
      const url = await getSignedUrl(client, command, { expiresIn })
      return url
    } catch (error) {
      console.error(`Failed to generate signed URL for key ${key}:`, error)
      throw error
    }
  }

  public async getBucketUsage(): Promise<number> {
    try {
      const { client, bucket } = this.getS3Client()
      let totalSize = 0
      let isTruncated = true
      let continuationToken: string | undefined = undefined

      while (isTruncated) {
        const command = new ListObjectsV2Command({
          Bucket: bucket,
          ContinuationToken: continuationToken
        })
        const response = (await client.send(command)) as ListObjectsV2CommandOutput
        
        if (response.Contents) {
          totalSize += response.Contents.reduce((acc, obj) => acc + (obj.Size || 0), 0)
        }
        
        isTruncated = response.IsTruncated ?? false
        continuationToken = response.NextContinuationToken
      }

      return totalSize
    } catch (error) {
      console.error('Failed to get bucket usage:', error)
      return 0
    }
  }
}

export const r2Service = new R2Service()
