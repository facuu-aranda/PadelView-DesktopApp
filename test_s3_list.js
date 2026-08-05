const { S3Client, ListObjectsV2Command, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const client = new S3Client({
  region: 'auto',
  endpoint: 'https://dae445c6c4d2d185bf9b4e83a17f3f67.r2.cloudflarestorage.com',
  forcePathStyle: true,
  credentials: {
    accessKeyId: '4bda9c9e5692881149dcb9781282a5e3',
    secretAccessKey: '9284c29ef67c0db99d0a466095d162488fc1c082fe2c33018947bbe80ba740c6'
  }
});

async function run() {
  try {
    const listCmd = new ListObjectsV2Command({ Bucket: 'padelview-matches' });
    const listRes = await client.send(listCmd);
    console.log('Objects:', listRes.Contents?.map(c => c.Key));

    if (listRes.Contents && listRes.Contents.length > 0) {
      const getCmd = new GetObjectCommand({ Bucket: 'padelview-matches', Key: listRes.Contents[0].Key });
      const url = await getSignedUrl(client, getCmd, { expiresIn: 3600 });
      console.log('Test Signed URL:', url);
    }
  } catch (err) {
    console.error('Error:', err);
  }
}
run();
