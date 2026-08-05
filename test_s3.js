const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

async function test() {
  const client = new S3Client({
    region: 'auto',
    endpoint: 'https://dae445c6c4d2d185bf9b4e83a17f3f67.r2.cloudflarestorage.com',
    forcePathStyle: true,
    credentials: {
      accessKeyId: 'test',
      secretAccessKey: 'test'
    }
  });

  const command = new GetObjectCommand({
    Bucket: 'padelview-matches',
    Key: 'videos/test.mp4'
  });

  const url = await getSignedUrl(client, command, { expiresIn: 3600 });
  console.log(url);
}

test();
