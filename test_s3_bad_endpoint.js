const { S3Client, ListObjectsV2Command } = require('@aws-sdk/client-s3');

const client = new S3Client({
  region: 'auto',
  endpoint: 'https://dae445c6c4d2d185bf9b4e83a17f3f67.r2.cloudflarestorage.com/viewpadel-client-facu-aranda-2',
  forcePathStyle: true,
  credentials: {
    accessKeyId: '9e3300237a167a0e67aa5c4bcf88176d',
    secretAccessKey: '149ad03179badca467206cb7a10b5b2ede9eb136c52675bcfcb809ab45bdb51b'
  }
});

async function run() {
  try {
    const listCmd = new ListObjectsV2Command({ Bucket: 'viewpadel-client-facu-aranda-2' });
    const listRes = await client.send(listCmd);
    console.log('Objects:', listRes.Contents?.map(c => c.Key));
  } catch (err) {
    console.error('Error listing objects:', err);
  }
}
run();
