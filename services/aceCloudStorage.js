const {
    S3Client,
    PutObjectCommand,
    GetObjectCommand,
    DeleteObjectCommand,
} = require("@aws-sdk/client-s3");

const {
    getSignedUrl,
} = require("@aws-sdk/s3-request-presigner");

const fs = require("fs");
const path = require("path");

const client = new S3Client({
    endpoint: process.env.ACECLOUD_ENDPOINT,
    region: process.env.ACECLOUD_REGION,
    forcePathStyle: true,

    requestChecksumCalculation: "WHEN_REQUIRED",   // ← add
    responseChecksumValidation: "WHEN_REQUIRED",   // ← add

    credentials: {
        accessKeyId: process.env.ACECLOUD_ACCESS_KEY,
        secretAccessKey: process.env.ACECLOUD_SECRET_KEY,
    },
});



/**
 * Upload file to bucket
 */

async function uploadPrescription(localFilePath, fileName) {

    const stream = fs.createReadStream(localFilePath);

    const key = `prescriptions/${fileName}`;

    await client.send(
        new PutObjectCommand({
            Bucket: process.env.ACECLOUD_BUCKET,

            Key: key,

            Body: stream,

            ContentType: "application/pdf",
        })
    );

    return key;
}



/**
 * Generate Signed URL
 */

async function getPrescriptionUrl(key) {

    const command = new GetObjectCommand({

        Bucket: process.env.ACECLOUD_BUCKET,

        Key: key,
    });

    const url = await getSignedUrl(
        client,
        command,
        {
            expiresIn: 60 * 60 * 24,
        }
    );

    return url;
}



/**
 * Delete file from bucket
 */

async function deletePrescription(key) {

    await client.send(

        new DeleteObjectCommand({

            Bucket: process.env.ACECLOUD_BUCKET,

            Key: key,
        })

    );

}



/**
 * Upload + Get URL
 */

async function uploadAndGenerateUrl(localFilePath, fileName) {
  const key = await uploadPrescription(localFilePath, fileName);
  const signedUrl = await getPrescriptionUrl(key);
  const publicUrl = signedUrl.split("?")[0];   // strip signature → plain public URL
  return { key, url: publicUrl };
}



module.exports = {

    uploadPrescription,

    getPrescriptionUrl,

    deletePrescription,

    uploadAndGenerateUrl,

};