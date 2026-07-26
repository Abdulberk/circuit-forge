/** S3/MinIO client (mirrors worker-sim/storage/s3-client.ts). GLB + Gerbers spill here; the row keeps keys. */
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';

import { config } from '../config';
import { logger } from '../logger';

const s3Client = new S3Client({
    endpoint: config.S3_ENDPOINT,
    region: config.S3_REGION,
    credentials: { accessKeyId: config.S3_ACCESS_KEY, secretAccessKey: config.S3_SECRET_KEY },
    forcePathStyle: config.S3_FORCE_PATH_STYLE,
});

export async function uploadFile(key: string, data: Buffer | string, contentType = 'application/octet-stream'): Promise<void> {
    const upload = new Upload({
        client: s3Client,
        params: { Bucket: config.S3_BUCKET, Key: key, Body: typeof data === 'string' ? Buffer.from(data) : data, ContentType: contentType },
    });
    await upload.done();
    logger.info({ key, size: Buffer.byteLength(data) }, 'Uploaded to S3');
}

export async function downloadFile(key: string): Promise<Buffer> {
    const res = await s3Client.send(new GetObjectCommand({ Bucket: config.S3_BUCKET, Key: key }));
    if (!res.Body) throw new Error(`Empty S3 body for key: ${key}`);
    const chunks: Uint8Array[] = [];
    for await (const chunk of res.Body as AsyncIterable<Uint8Array>) chunks.push(chunk);
    return Buffer.concat(chunks);
}

export { s3Client };
