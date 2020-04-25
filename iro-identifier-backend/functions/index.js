const os = require("os");
const path = require("path");
const fs = require("fs");
const functions = require("firebase-functions");
const spawn = require("child-process-promise").spawn;
const cors = require("cors")({origin: true});
const Busboy = require("busboy");
const UUID = require("uuid-v4");
const sizeOf = require("image-size");
const { Storage } = require("@google-cloud/storage");
const { Datastore } = require('@google-cloud/datastore');

const pathToGcKey = "iro-identifier-firebase-adminsdk-i96zj-6e4002e6a4.json";
const gcs = new Storage({
    projectId: "iro-identifier",
    keyFilename: pathToGcKey
});
const datastore = new Datastore({
    keyFilename: pathToGcKey
});

const newDbImage = (owner, name, type, url, thumbnailUrl, width, height) => {
    const kind = "Image";
    const key = datastore.key(kind);
    
    const imageName = path.parse(name).name;

    const ratio = width/height;
    
    const image = {
        owner: owner,
        name: imageName,
        type: type,
        url: url,
        thumbnailUrl: thumbnailUrl,
        width: width,
        height: height,
        aspectRatio: ratio,
    }

    const entity = {
        key: key,
        data: image,
    }

    return datastore.save(entity).then(() => {
        console.log(`Saved ${imageName} to database.`);
        return true;
    }).catch(err => {
        console.log(err);
    });
}

exports.onImageUpload = functions.storage.object().onFinalize(event => {
    const bucket = event.bucket;
    const contentType = event.contentType;
    const filepath = event.name;
    console.log("File detected");

    if (path.basename(filepath).startsWith("iro-thumbnail-")) {
        console.log("Already resized this file!");
        return true;
    }

    const originalInfo = event.metadata;
    const size = originalInfo.size;
    const splitSize = size.split("x");
    const owner = originalInfo.owner;
    const destBucket = gcs.bucket(bucket);
    const tmpFilepath = path.join(os.tmpdir(), path.basename(filepath));
    const uuid = UUID();
    const metadata = { 
        contentType, 
        metadata: {
            contentType,
            owner: owner,
            firebaseStorageDownloadTokens: uuid, 
        }
    };

    const uploaded = destBucket.file(filepath);
    let originalUrl = null;

    return destBucket.file(filepath).download({
        destination: tmpFilepath,
    }).then(() => {
        return spawn("convert", [tmpFilepath, "-resize", "500x500", tmpFilepath]);
    }).then(() => {
        return destBucket.upload(tmpFilepath, {
            destination: path.join(owner, "thumbnails", ('iro-thumbnail-' + path.basename(filepath))),
            metadata: metadata
        });
    }).then(() => {
        return uploaded.getSignedUrl({
            action: "read",
            expires: "12-31-2490"
        });
    }).then((url) => {
            originalUrl = url;
    }).then(() => {
        return destBucket.file(path.join(owner, "thumbnails", ('iro-thumbnail-' + path.basename(filepath)))).getSignedUrl({
            action: "read",
            expires: "12-31-2490"
        });
    }).then((thumbnailUrl) => {
        console.log("Adding database entry...");
        return newDbImage(owner, path.basename(filepath), contentType, originalUrl, thumbnailUrl, parseInt(splitSize[0]), parseInt(splitSize[1]));
    }).then(() => {
        return true;
    });
});

exports.onImageDelete = functions.storage.object().onDelete(event => {
    const bucket = gcs.bucket(event.bucket);
    const owner = "guest";
    const filePath = event.name;
    const basename = path.basename(filePath);

    if (basename.startsWith("iro-thumbnail-")) {
        return true;
    }
    
    bucket.file(path.join(owner, "thumbnails", ('iro-thumbnail-' + basename))).delete();
    console.log("File was deleted...");

    const query = datastore.createQuery("Image").filter("owner", "=", owner).filter("name", "=", path.parse(basename).name);
    return datastore.runQuery(query).then((res) => {
        if (res) {
            datastore.delete(res[0][0][datastore.KEY]).then(() => {
                console.log(`Deleted database entry for ${basename}.`);
                return true;
            });
        } else {
            console.log(`No database entry found for ${basename} so there was no deletion.`);
            return false;
        }
    });
});

exports.uploadImages = functions.https.onRequest((req, res) => {
    cors(req, res, () => {
        if (req.method !== "POST") {
            return res.status(500).json({
                message: "Not allowed"
            })
        }
        const busboy = new Busboy({ headers: req.headers });
        let uploadData = [];
        busboy.on("file", (fieldname, file, filename, encoding, mimetype) => {
            const filepath = path.join(os.tmpdir(), filename);
            uploadData.push({file: filepath, type: mimetype});
            file.pipe(fs.createWriteStream(filepath));
        });

        busboy.on("finish", () => {
            const bucket = gcs.bucket("iro-identifier.appspot.com");
            const owner = "guest";
            let promises = [];
            uploadData.map(upload => {
                const uuid = UUID();
                const destination = path.join(owner, "images", path.basename(upload.file));

                const dimensions = sizeOf(upload.file);
                let width = dimensions.width;
                let height = dimensions.height;
                if ((dimensions.orientation === 6) || (dimensions.orientation === 8)) {
                    width = dimensions.height;
                    height = dimensions.width;
                }

                // upload current file to storage
                promises.push(bucket.upload(upload.file, {
                    destination: destination,
                    uploadType: "media",
                    metadata: {
                        contentType: upload.type,
                        metadata: {
                            size: `${width}x${height}`,
                            owner: owner,
                            firebaseStorageDownloadTokens: uuid
                        }
                    },
                    resumable: false
                }));
            });
            
            Promise.all(promises).then(() => {
                    res.status(200).json({
                        message: "Files uploaded successfully!"
                    });
                }).catch(err => {
                    res.status(500).json({
                    error: err
                });
            });
        });

        busboy.end(req.rawBody);
    });
});
