/**
 * S3/MinIO client for file storage
 */
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { config } from '../config';
import { logger } from '../logger';

const s3Client = new S3Client({
    endpoint: config.S3_ENDPOINT,
    region: config.S3_REGION,
    credentials: {
        accessKeyId: config.S3_ACCESS_KEY,
        secretAccessKey: config.S3_SECRET_KEY,
    },
    forcePathStyle: config.S3_FORCE_PATH_STYLE,
});

/**
 * Download a file from S3
 */
export async function downloadFile(key: string): Promise<Buffer> {
    logger.debug({ key }, 'Downloading file from S3');

    const command = new GetObjectCommand({
        Bucket: config.S3_BUCKET,
        Key: key,
    });

    const response = await s3Client.send(command);

    if (!response.Body) {
        throw new Error(`Empty response body for key: ${key}`);
    }

    const chunks: Uint8Array[] = [];
    const stream = response.Body as AsyncIterable<Uint8Array>;

    for await (const chunk of stream) {
        chunks.push(chunk);
    }

    return Buffer.concat(chunks);
}

/**
 * Upload a file to S3
 */
export async function uploadFile(
    key: string,
    data: Buffer | string,
    contentType: string = 'application/octet-stream',
): Promise<void> {
    logger.debug({ key, contentType, size: Buffer.byteLength(data) }, 'Uploading file to S3');

    const upload = new Upload({
        client: s3Client,
        params: {
            Bucket: config.S3_BUCKET,
            Key: key,
            Body: typeof data === 'string' ? Buffer.from(data) : data,
            ContentType: contentType,
        },
    });

    await upload.done();

    logger.info({ key }, 'File uploaded to S3');
}

/**
 * Upload JSON result to S3
 */
export async function uploadJsonResult(jobId: string, data: unknown): Promise<string> {
    const key = `results/${jobId}/result.json`;
    await uploadFile(key, JSON.stringify(data), 'application/json');
    return key;
}

/**
 * Download model file for simulation
 */
export async function downloadModelFile(s3Key: string, destPath: string): Promise<void> {
    const fs = await import('fs/promises');
    const data = await downloadFile(s3Key);
    await fs.writeFile(destPath, data);
    logger.debug({ s3Key, destPath }, 'Model file downloaded');
}

export { s3Client };