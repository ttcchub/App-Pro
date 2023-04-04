// using express JS
var express = require("express");
var app = express();

// express formidable is used to parse the form data values
var formidable = require("express-formidable");
app.use(formidable({
    // max upload file size 300 MB
    "maxFileSize": 300 * 1024 * 1024
}));

var jwt = require("jsonwebtoken");
var accessTokenSecret = "1234567890AdminTokenSecret";

// use mongo DB as database
var mongodb = require("mongodb");
var mongoClient = mongodb.MongoClient;

// the unique ID for each mongo DB document
var ObjectId = mongodb.ObjectId;

// receiving http requests
var httpObj = require("http");
var http = httpObj.createServer(app);

// to encrypt/decrypt passwords
var bcrypt = require("bcrypt");

// to store files
var fileSystem = require("fs");

// module to create ZIP files
var zipper = require('zip-local');

// to send emails
var nodemailer = require("nodemailer");

// for realtime communication
const socketIO = require("socket.io")(http, {
    cors: {
        origin: "*"
    }
});

// to compress image
const compressImages = require("compress-images");

// npm install pngquant-bin@6.0.1 --save
// npm install gifsicle@5.2.1 --save

// to start the session
var session = require("express-session");
app.use(session({
    secret: 'secret key',
    resave: false,
    saveUninitialized: false
}));

// define the publically accessible folders
app.use("/public/uploads", express.static(__dirname + "/public/uploads"));
app.use("/public/wysiwyg", express.static(__dirname + "/public/wysiwyg"));
app.use("/public/admin", express.static(__dirname + "/public/admin"));
app.use("/public/css", express.static(__dirname + "/public/css"));
app.use("/public/js", express.static(__dirname + "/public/js"));
app.use("/public/font-awesome-4.7.0", express.static(__dirname + "/public/font-awesome-4.7.0"));

// using EJS as templating engine
app.set("view engine", "ejs");

// main URL of website
var mainURL = "http://localhost:4000";

// to remove folder and all sub-directories in it
var rimraf = require("rimraf");

// setup SMTP for sending mails
var nodemailerFrom = "support@adnan-tech.com";
var nodemailerObject = {
    service: "gmail",
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: {
        user: "support@adnan-tech.com",
        pass: ""
    }
};

var requestModule = require("request");

const admin = require("./modules/admin");
admin.init(app, express);
const functions = require("./modules/functions");

var paypalClientID = "";
var paypalClientIDProduction = "";
var paypalClientSecret = "";

var paypal = require('paypal-rest-sdk');
paypal.configure({
    'mode': 'sandbox', //sandbox or live
    'client_id': paypalClientID,
    'client_secret': paypalClientSecret
});

// global database object
var database = null;

// app middleware to attach main URL and user object with each request
app.use(function (request, result, next) {
    request.mainURL = mainURL;
    request.isLogin = (typeof request.session.user !== "undefined");
    request.user = request.session.user;

    // continue the request
    next();
});

var stripeSecretKey = "";
var stripePublicKey = "";

const Stripe = require('stripe');
const stripe = Stripe(stripeSecretKey);

// start the http server
http.listen(4000, function () {
    console.log("Server started at " + mainURL);

    // connect with mongo DB server
    mongoClient.connect("mongodb://localhost:27017", {
        useUnifiedTopology: true
    }, function (error, client) {

        // connect database (it will automatically create the database if not exists)
        database = client.db("file_transfer");
        console.log("Database connected.");

        var socketUsers = [];
        
        socketIO.on("connection", function (socket) {
            console.log("User connected: " + socket.id);

            socket.on("logged_in", function (user_id) {
                socketUsers[user_id] = socket.id;
                admin.socketUsers = socketUsers;
            });
        });

        admin.setData(database, socketIO, socketUsers);

        app.get("/Blog/:slug", async function (request, result) {
            // get data from mongo DB
            const post = await database.collection("posts").findOne({
                slug: request.params.slug
            });
            if (post == null) {
                result.render("Errors/404", {
                    message: "Post no longer exists.",
                    request: request
                });
                return false;
            }

            const relatedPosts = await database.collection("posts").find({
                $and: [{
                    "_id": {
                        $ne: post._id
                    }
                }, {
                    "categories": {
                        $in: post.categories
                    }
                }]
            }).toArray();

            const recentPosts = await database.collection("posts").find({
                $and: [{
                    "_id": {
                        $ne: post._id
                    }
                }]
            })
                .sort("_id", "desc")
                .limit(10)
                .toArray();
         
            // render an HTML page with post object
            result.render("SinglePost", {
                post: post,
                request: request,
                relatedPosts: relatedPosts,
                recentPosts: recentPosts
            });
        });

        app.get("/Blog", async function (request, result) {
            // number of records you want to show per page
            var perPage = 10;
         
            // total number of records from database
            var total = await database.collection("posts").count();
         
            // Calculating number of pagination links required
            var pages = Math.ceil(total / perPage);
         
            // get current page number
            var pageNumber = (request.query.page == null) ? 1 : request.query.page;
         
            // get records to skip
            var startFrom = (pageNumber - 1) * perPage;
         
            // get data from mongo DB using pagination
            var posts = await database.collection("posts").find({})
                .sort({ "_id": -1 })
                .skip(startFrom)
                .limit(perPage)
                .toArray();
         
            // render an HTML page with number of pages, and posts data
            result.render("Blog", {
                pages: pages,
                posts: posts,
                request: request
            });
        });

        app.post("/CreateBackup", async function (request, result) {
            if (request.session.user) {

                var user = await database.collection("users").findOne({
                    "_id": ObjectId(request.session.user._id)
                });

                zipper.sync.zip("./public/uploads/" + user.email).compress().save("./public/backups/" + user.email + ".zip");

                var CHUNK_SIZE = 10 * 1024 * 1024; // 10MB
                var buffer = Buffer.alloc(CHUNK_SIZE);
                var bufferArr = [];
                var totalSizeRead = 0;

                // Read file stats
                const userSocketID = socketUsers[request.session.user._id];

                fileSystem.open("public/backups/" + user.email + ".zip", 'r', function(err, fd) {
                    if (err) throw err;
                    function readNextChunk() {
                        fileSystem.read(fd, buffer, 0, CHUNK_SIZE, null, function(err, nread) {
                            if (err) throw err;

                            if (nread === 0) {
                                // done reading file, do any necessary finalization steps

                                socketIO.to(userSocketID).emit("download_completed", {
                                    "fileType": "zip",
                                    "fileName": user.email + ".zip"
                                });

                                fileSystem.close(fd, function(err) {
                                    if (err) throw err;
                                });

                                try {
                                    fileSystem.unlinkSync("public/backups/" + user.email + ".zip");
                                } catch (exp) {
                                    console.log(exp);
                                }

                                result.json({
                                    "status": "success",
                                    "message": "Backup has been made."
                                });
                                return;
                            }

                            var data;
                            if (nread < CHUNK_SIZE) {
                                data = buffer.slice(0, nread);
                            } else {
                                data = buffer;
                            }

                            // if (totalSizeRead < file.size) {
                                socketIO.to(userSocketID).emit("download_chunk_received", data);
                                
                                bufferArr.push(data);
                                totalSizeRead += CHUNK_SIZE;
                                
                                readNextChunk();
                                console.log("readNextChunk...");
                            // }
                            // do something with `data`, then call `readNextChunk();`
                        });
                    }
                    readNextChunk();
                });
                return false;
            }

            result.json({
                "status": "error",
                "message": "User has been logged out."
            });
        });

        app.post("/ForceDeleteFile", async function (request, result) {
            if (request.session.user) {

                const _id = request.fields._id;

                var user = await database.collection("users").findOne({
                    $and: [{
                        "_id": ObjectId(request.session.user._id)
                    }, {
                        "trashCan._id": ObjectId(_id)
                    }]
                });

                if (user == null) {
                    request.session.status = "error";
                    request.session.message = "File does not exists.";
                    result.redirect("/TrashCan");

                    return false;
                }

                var file = null;
                for (var a = 0; a < user.trashCan.length; a++) {
                    if (user.trashCan[a]._id.toString() == _id) {
                        file = user.trashCan[a];
                        break;
                    }
                }
                if (file == null) {
                    request.session.status = "error";
                    request.session.message = "File does not exists.";
                    result.redirect("/TrashCan");

                    return false;
                }

                await database.collection("users").updateOne({
                    $and: [{
                        "_id": ObjectId(request.session.user._id)
                    }, {
                        "trashCan._id": ObjectId(_id)
                    }]
                }, {
                    $pull: {
                        "trashCan": {
                            "_id": ObjectId(_id)
                        }
                    }
                });

                try {
                    fileSystem.unlinkSync(file.filePath);
                } catch (exp) {
                    
                }

                request.session.status = "success";
                request.session.message = "File has been deleted permanently.";
                result.redirect("/TrashCan");

                return false;
            }

            result.redirect("/Login");
        });

        app.post("/RecoverFile", async function (request, result) {
            if (request.session.user) {

                const _id = request.fields._id;

                var user = await database.collection("users").findOne({
                    $and: [{
                        "_id": ObjectId(request.session.user._id)
                    }, {
                        "trashCan._id": ObjectId(_id)
                    }]
                });

                if (user == null) {
                    request.session.status = "error";
                    request.session.message = "File does not exists.";
                    result.redirect("/TrashCan");

                    return false;
                }

                var file = null;
                for (var a = 0; a < user.trashCan.length; a++) {
                    if (user.trashCan[a]._id.toString() == _id) {
                        file = user.trashCan[a];
                        break;
                    }
                }
                if (file == null) {
                    request.session.status = "error";
                    request.session.message = "File does not exists.";
                    result.redirect("/TrashCan");

                    return false;
                }

                // check if upload limit exceeded
                const fileSize = file.size;
                if (fileSize > user.remainingData) {
                    request.session.status = "error";
                    request.session.message = "Kindly buy more data to upload this file.";
                    result.redirect("/TrashCan");

                    return false;
                }

                // subtract from user remaining data
                user.remainingData = user.remainingData - fileSize;

                await database.collection("users").updateOne({
                    $and: [{
                        "_id": ObjectId(request.session.user._id)
                    }, {
                        "trashCan._id": ObjectId(_id)
                    }]
                }, {
                    $pull: {
                        "trashCan": {
                            "_id": ObjectId(_id)
                        }
                    }
                });

                await database.collection("users").updateOne({
                    "_id": ObjectId(request.session.user._id)
                }, {
                    $set: {
                        "remainingData": user.remainingData
                    },
                    $push: {
                        "uploaded": file
                    }
                });

                request.session.status = "success";
                request.session.message = "File has been recovered.";
                result.redirect("/TrashCan");

                return false;
            }

            result.redirect("/Login");
        });

        app.get("/TrashCan", async function (request, result) {
            if (request.session.user) {

                var user = await database.collection("users").findOne({
                    "_id": ObjectId(request.session.user._id)
                });

                result.render("TrashCan", {
                    "request": request,
                    "trashCan": user.trashCan
                });
                return true;
            }

            result.redirect("/Login");
        });

        app.post("/EditFile", async function (request, result) {
            if (request.session.user) {
                var user = await database.collection("users").findOne({
                    "_id": ObjectId(request.session.user._id)
                });

                var _id = request.fields._id;
                var content = request.fields.content;

                var fileUploaded = await functions.recursiveGetFile(user.uploaded, _id);
                var fileShared = await functions.recursiveGetSharedFile(user.sharedWithMe, _id);
                
                if (fileUploaded == null && fileShared == null) {
                    result.json({
                        "status": "error",
                        "message": "File is neither uploaded nor shared with you."
                    });
                    return false;
                }

                var file = (fileUploaded == null) ? fileShared : fileUploaded;

                if (file.type != "text/plain") {
                    result.json({
                        "status": "error",
                        "message": "Please select a plain text file to edit."
                    });
                    return false;
                }

                fileSystem.writeFile(file.filePath, content, async function (err) {
                    if (err) {
                        console.error(err)
                        return
                    }
                    // file written successfully

                    if (fileUploaded == null) {
                        // it is shared with me

                        // get user who uploaded the file
                        const users = await database.collection("users").find({}).toArray();
                        for (var a = 0; a < users.length; a++) {
                            var tempFileUploaded = await functions.recursiveGetFile(users[a].uploaded, _id);
                            if (tempFileUploaded != null) {
                                socketIO.to(socketUsers[users[a]._id]).emit("file_updated", {
                                    "updatedBy": {
                                        "_id": user._id,
                                        "name": user.name,
                                        "email": user.email
                                    },
                                    "content": content
                                });
                                break;
                            }
                        }

                    } else if (fileShared == null) {
                        // it is uploaded by me

                        const users = await database.collection("users").find({
                            "sharedWithMe.file._id": ObjectId(_id)
                        }).toArray();

                        for (var a = 0; a < users.length; a++) {
                            socketIO.to(socketUsers[users[a]._id]).emit("file_updated", {
                                "updatedBy": {
                                    "_id": user._id,
                                    "name": user.name,
                                    "email": user.email
                                },
                                "content": content
                            });
                        }
                    }

                    result.json({
                        "status": "success",
                        "message": "File has been updated."
                    });
                });

                return false;
            }

            result.json({
                "status": "error",
                "message": "You have been logged out. Kindly login again."
            });
        });

        app.get("/EditFile/:_id", async function (request, result) {
            if (request.session.user) {
                var user = await database.collection("users").findOne({
                    "_id": ObjectId(request.session.user._id)
                });

                var _id = request.params._id;

                var fileUploaded = await functions.recursiveGetFile(user.uploaded, _id);
                var fileShared = await functions.recursiveGetSharedFile(user.sharedWithMe, _id);
                
                if (fileUploaded == null && fileShared == null) {
                    result.json({
                        "status": "error",
                        "message": "File is neither uploaded nor shared with you."
                    });
                    return false;
                }

                var file = (fileUploaded == null) ? fileShared : fileUploaded;

                if (file.type != "text/plain") {
                    result.json({
                        "status": "error",
                        "message": "Please select a plain text file to edit."
                    });
                    return false;
                }

                // console.log(file);

                fileSystem.readFile(file.filePath, 'utf8' , function (err, data) {
                    if (err) {
                        console.error(err)
                        return
                    }
                    // console.log(data);

                    file.content = data;

                    result.render("EditFile", {
                        "request": request,
                        "file": file
                    });
                });

                return false;
            }

            result.redirect("/Login");
        });

        app.post("/IncreaseDataPayPal", async function (request, result) {
            if (request.session.user) {
                var user = await database.collection("users").findOne({
                    "_id": ObjectId(request.session.user._id)
                });

                const payerID = request.fields.payerID;
                const paymentID = request.fields.paymentID;

                var CLIENT = paypalClientID;
                var SECRET = paypalClientSecret;
                var PAYPAL_API = 'https://api-m.sandbox.paypal.com/v1';

                var headers = {
                    'Accept': 'application/json',
                    'Accept-Language': 'en_US'
                };

                var dataString = 'grant_type=client_credentials';

                var options = {
                    url: PAYPAL_API + '/oauth2/token',
                    method: 'POST',
                    headers: headers,
                    body: dataString,
                    auth: {
                        'user': CLIENT,
                        'pass': SECRET
                    }
                };

                requestModule(options, function (error, response, body) {
                    if (!error && response.statusCode == 200) {
                        // console.log(body);
                        body = JSON.parse(body);
                        // console.log(body);

                        var accessToken = body.access_token;

                        var headers = {
                            'Content-Type': 'application/json',
                            'Authorization': 'Bearer ' + accessToken
                        };

                        var dataString = "{\n  \"payer_id\": \"" + payerID + "\"\n}";

                        var options = {
                            url: PAYPAL_API + '/payments/payment/' + paymentID + "/execute",
                            method: 'POST',
                            headers: headers,
                            body: dataString,
                            auth: {
                                'user': CLIENT,
                                'pass': SECRET
                            }
                        };

                        requestModule(options, async function (error, response, body) {
                            if (!error && response.statusCode == 200) {
                                // console.log(body);
                                body = JSON.parse(body);
                                // console.log(body);

                                if (typeof body.id === "undefined") {
                                    result.json({
                                        "status": "error",
                                        "message": "Payment is not verified."
                                    });
                                } else {
                                    const oneGB = 1 * 1024 * 1024 * 1024;
                                    await database.collection("users").findOneAndUpdate({
                                        "_id": ObjectId(request.session.user._id)
                                    }, {
                                        $inc: {
                                            "remainingData": oneGB
                                        }
                                    });

                                    result.json({
                                        "status": "success",
                                        "message": "Data has been added."
                                    });
                                }

                                return false;
                            }

                            /*console.log({
                                "error": error,
                                "response": response,
                                "body": body
                            });*/
                        });
                        return false;
                    }
                });
                return false;
            }

            result.redirect("/Login");
        });

        app.post("/IncreaseData", async function (request, result) {
            if (request.session.user) {
                var user = await database.collection("users").findOne({
                    "_id": ObjectId(request.session.user._id)
                });

                const payment_intent_id = request.fields.payment_intent_id;
                // To create a PaymentIntent for confirmation, see our guide at: https://stripe.com/docs/payments/payment-intents/creating-payment-intents#creating-for-automatic
                const paymentIntent = await stripe.paymentIntents.retrieve(
                    payment_intent_id
                );
                console.log(paymentIntent);
                if (paymentIntent.status == "succeeded") {
                    const oneGB = 1 * 1024 * 1024 * 1024;
                    await database.collection("users").findOneAndUpdate({
                        "_id": ObjectId(request.session.user._id)
                    }, {
                        $inc: {
                            "remainingData": oneGB
                        }
                    });

                    result.json({
                        "status": "success",
                        "message": "Data has been added."
                    });
                    return false;
                }

                result.json({
                    "status": "error",
                    "message": "Payment is not verified."
                });
            }

            result.redirect("/Login");
        });

        // route to show my remaining and consumed data
        app.get("/MyData", async function (request, result) {
            if (request.session.user) {
                var user = await database.collection("users").findOne({
                    "_id": ObjectId(request.session.user._id)
                });

                const totalUploaded = functions.recursiveGetTotalUploadedData(user.uploaded);

                const paymentIntent = await stripe.paymentIntents.create({
                    amount: 1 * 100,
                    currency: 'usd',
                    payment_method_types: ['card'],
                });

                result.render("MyData", {
                    "request": request,
                    "totalUploaded": totalUploaded,
                    "remainingData": user.remainingData,
                    "paymentIntent": paymentIntent,
                    "paypalClientID": paypalClientID,
                    "paypalClientIDProduction": paypalClientIDProduction,
                    "paypalClientSecret": paypalClientSecret,
                    "stripeSecretKey": stripeSecretKey,
                    "stripePublicKey": stripePublicKey
                });
                return false;
            }

            result.redirect("/Login");
        });

        app.post("/DeleteLink", async function (request, result) {

            const _id = request.fields._id;

            if (request.session.user) {
                var link = await database.collection("public_links").findOne({
                    $and: [{
                        "uploadedBy._id": ObjectId(request.session.user._id)
                    }, {
                        "_id": ObjectId(_id)
                    }]
                });

                if (link == null) {
                    request.session.status = "error";
                    request.session.message = "Link does not exists.";

                    const backURL = request.header("Referer") || "/";
                    result.redirect(backURL);
                    return false;
                }

                await database.collection("public_links").deleteOne({
                    $and: [{
                        "uploadedBy._id": ObjectId(request.session.user._id)
                    }, {
                        "_id": ObjectId(_id)
                    }]
                });

                request.session.status = "success";
                request.session.message = "Link has been deleted.";

                const backURL = request.header("Referer") || "/";
                result.redirect(backURL);
                return false;
            }

            result.redirect("/Login");
        });

        app.get("/MySharedLinks", async function (request, result) {
            if (request.session.user) {
                var links = await database.collection("public_links").find({
                    "uploadedBy._id": ObjectId(request.session.user._id)
                }).toArray();

                result.render("MySharedLinks", {
                    "request": request,
                    "links": links
                });
                return false;
            }

            result.redirect("/Login");
        });

        app.get("/SharedViaLink/:hash", async function (request, result) {
            const hash = request.params.hash;

            var link = await database.collection("public_links").findOne({
                "hash": hash
            });

            if (link == null) {
                request.session.status = "error";
                request.session.message = "Link expired.";

                result.render("SharedViaLink", {
                    "request": request
                });
                return false;
            }

            result.render("SharedViaLink", {
                "request": request,
                "link": link
            });
        });

        app.post("/ShareViaLink", async function (request, result) {
            const _id = request.fields._id;

            if (request.session.user) {
                var user = await database.collection("users").findOne({
                    "_id": ObjectId(request.session.user._id)
                });
                var file = await functions.recursiveGetFile(user.uploaded, _id);
                var folder = await functions.recursiveGetFolder(user.uploaded, _id);

                if (file == null && folder == null) {
                    request.session.status = "error";
                    request.session.message = "File does not exists";

                    const backURL = request.header("Referer") || "/";
                    result.redirect(backURL);
                    return false;
                }

                if (folder != null) {
                    folder.name = folder.folderName;
                    folder.filePath = folder.folderPath;
                    delete folder.files;
                    file = folder;
                }

                bcrypt.hash(file.name, 10, async function (error, hash) {
                    hash = hash.substring(10, 20);
                    const link = mainURL + "/SharedViaLink/" + hash;
                    await database.collection("public_links").insertOne({
                        "hash": hash,
                        "file": file,
                        "downloads": 0,
                        "uploadedBy": {
                            "_id": user._id,
                            "name": user.name,
                            "email": user.email
                        },
                        "createdAt": new Date().getTime()
                    });

                    request.session.status = "success";
                    request.session.message = "Share link: " + link;

                    const backURL = request.header("Referer") || "/";
                    result.redirect(backURL);
                });

                return false;
            }

            result.redirect("/Login");
        });

        // search files or folders
        app.get("/Search", async function (request, result) {
            const search = request.query.search;

            if (request.session.user) {
                var user = await database.collection("users").findOne({
                    "_id": ObjectId(request.session.user._id)
                });
                var fileUploaded = await functions.recursiveSearch(user.uploaded, search);
                var fileShared = await functions.recursiveSearchShared(user.sharedWithMe, search);

                // check if file is uploaded or shared with user
                if (fileUploaded == null && fileShared == null) {
                    request.status = "error";
                    request.message = "File/folder '" + search + "' is neither uploaded nor shared with you.";

                    result.render("Search", {
                        "request": request
                    });
                    return false;
                }

                var file = (fileUploaded == null) ? fileShared : fileUploaded;
                file.isShared = (fileUploaded == null);
                result.render("Search", {
                    "request": request,
                    "file": file
                });

                return false;
            }

            result.redirect("/Login");
        });

        // move file from one folder to another
        app.post("/MoveFile", async function (request, result) {
            const _id = request.fields._id;
            const type = request.fields.type;
            const folder = request.fields.folder;

            if (request.session.user) {

                var user = await database.collection("users").findOne({
                    "_id": ObjectId(request.session.user._id)
                });

                var updatedArray = user.uploaded;

                if (type == "folder") {
                    // get both folders
                    var moveFolder = await functions.recursiveGetFolder(user.uploaded, _id);
                    var moveToFolder = await functions.recursiveGetFolder(user.uploaded, folder);

                    // move folder in uploads folder 
                    updatedArray = await functions.moveFolderReturnUpdated(user.uploaded, _id, moveFolder, moveToFolder);

                    // update folder array where the file is moved
                    updatedArray = await functions.updateMovedToFolderParent_ReturnUpdated(updatedArray, folder, moveFolder);
                }

                await database.collection("users").updateOne({
                    "_id": ObjectId(request.session.user._id)
                }, {
                    $set: {
                        "uploaded": updatedArray
                    }
                });

                const backURL = request.header('Referer') || '/';
                result.redirect(backURL);
                return false;
            }

            result.redirect("/Login");
        });

        // get all folders
        app.post("/GetAllFolders", async function (request, result) {
            const _id = request.fields._id;
            const type = request.fields.type;

            if (request.session.user) {
                var user = await database.collection("users").findOne({
                    "_id": ObjectId(request.session.user._id)
                });

                var tempAllFolders = functions.recursiveGetAllFolders(user.uploaded, _id);
                var folders = [];
                for (var a = 0; a < tempAllFolders.length; a++) {
                    folders.push({
                        "_id": tempAllFolders[a]._id,
                        "folderName": tempAllFolders[a].folderName
                    });
                }

                result.json({
                    "status": "success",
                    "message": "Record has been fetched.",
                    "folders": folders
                });
                return false;
            }

            result.json({
                "status": "error",
                "message": "Please login to perform this action."
            });
        });

        // remove shared access
        app.post("/RemoveSharedAccess", async function (request, result) {
            const _id = request.fields._id;

            if (request.session.user) {
                const user = await database.collection("users").findOne({
                    $and: [{
                        "sharedWithMe._id": ObjectId(_id)
                    }, {
                        "sharedWithMe.sharedBy._id": ObjectId(request.session.user._id)
                    }]
                });

                // remove from array
                for (var a = 0; a < user.sharedWithMe.length; a++) {
                    if (user.sharedWithMe[a]._id == _id) {
                        user.sharedWithMe.splice(a, 1);
                    }
                }

                await database.collection("users").findOneAndUpdate({
                    $and: [{
                        "sharedWithMe._id": ObjectId(_id)
                    }, {
                        "sharedWithMe.sharedBy._id": ObjectId(request.session.user._id)
                    }]
                }, {
                    $set: {
                        "sharedWithMe": user.sharedWithMe
                    }
                });

                request.session.status = "success";
                request.session.message = "Shared access has been removed.";

                const backURL = request.header('Referer') || '/';
                result.redirect(backURL);
                return false;
            }

            result.redirect("/Login");
        });

        // get users whom file has been shared
        app.post("/GetFileSharedWith", async function (request, result) {
            const _id = request.fields._id;

            if (request.session.user) {
                const tempUsers = await database.collection("users").find({
                    $and: [{
                        "sharedWithMe.file._id": ObjectId(_id)
                    }, {
                        "sharedWithMe.sharedBy._id": ObjectId(request.session.user._id)
                    }]
                }).toArray();

                var users = [];
                for (var a = 0; a < tempUsers.length; a++) {
                    var sharedObj = null;
                    for (var b = 0; b < tempUsers[a].sharedWithMe.length; b++) {
                        if (tempUsers[a].sharedWithMe[b].file._id == _id) {
                            sharedObj = {
                                "_id": tempUsers[a].sharedWithMe[b]._id,
                                "sharedAt": tempUsers[a].sharedWithMe[b].createdAt,
                            };
                        }
                    }
                    users.push({
                        "_id": tempUsers[a]._id,
                        "name": tempUsers[a].name,
                        "email": tempUsers[a].email,
                        "sharedObj": sharedObj
                    });
                }

                result.json({
                    "status": "success",
                    "message": "Record has been fetched.",
                    "users": users
                });
                return false;
            }

            result.json({
                "status": "error",
                "message": "Please login to perform this action."
            });
        });

        // rename file
        app.post("/RenameFile", async function (request, result) {
            const _id = request.fields._id;
            const name = request.fields.name;

            if (request.session.user) {

                var user = await database.collection("users").findOne({
                    "_id": ObjectId(request.session.user._id)
                });

                var updatedArray = await functions.renameFileReturnUpdated(user.uploaded, _id, name);
                for (var a = 0; a < updatedArray.length; a++) {
                    updatedArray[a]._id = ObjectId(updatedArray[a]._id);
                }

                await database.collection("users").updateOne({
                    "_id": ObjectId(request.session.user._id)
                }, {
                    $set: {
                        "uploaded": updatedArray
                    }
                });

                const backURL = request.header('Referer') || '/';
                result.redirect(backURL);
                return false;
            }

            result.redirect("/Login");
        });

        // rename folder
        app.post("/RenameFolder", async function (request, result) {
            const _id = request.fields._id;
            const name = request.fields.name;

            if (request.session.user) {

                var user = await database.collection("users").findOne({
                    "_id": ObjectId(request.session.user._id)
                });

                var updatedArray = await functions.renameFolderReturnUpdated(user.uploaded, _id, name);
                for (var a = 0; a < updatedArray.length; a++) {
                    updatedArray[a]._id = ObjectId(updatedArray[a]._id);
                }

                await database.collection("users").updateOne({
                    "_id": ObjectId(request.session.user._id)
                }, {
                    $set: {
                        "uploaded": updatedArray
                    }
                });

                const backURL = request.header('Referer') || '/';
                result.redirect(backURL);
                return false;
            }

            result.redirect("/Login");
        });

        // get all files shared with logged-in user
        app.get("/SharedWithMe/:_id?", async function (request, result) {
            const _id = request.params._id;
            if (request.session.user) {

                var user = await database.collection("users").findOne({
                    "_id": ObjectId(request.session.user._id)
                });

                var files = null;
                var folderName = "";
                if (typeof _id == "undefined") {
                    files = user.sharedWithMe;
                } else {
                    var folderObj = await functions.recursiveGetSharedFolder(user.sharedWithMe, _id);

                    if (folderObj == null) {
                        request.status = "error";
                        request.message = "Folder not found.";
                        result.render("Error", {
                            "request": request
                        });
                        return false;
                    }

                    files = folderObj.files;
                    folderName = folderObj.folderName;
                }

                if (files == null) {
                    request.status = "error";
                    request.message = "Directory not found.";
                    result.render("Error", {
                        "request": request
                    });
                    return false;
                }

                result.render("SharedWithMe", {
                    "request": request,
                    "files": files,
                    "_id": _id,
                    "folderName": folderName
                });
                return false;
            }

            result.redirect("/Login");
        });

        // share the file with the user
        app.post("/Share", async function (request, result) {
            const _id = request.fields._id;
            const type = request.fields.type;
            const email = request.fields.email;

            if (request.session.user) {
                var user = await database.collection("users").findOne({
                    "email": email
                });

                if (user == null) {
                    request.session.status = "error";
                    request.session.message = "User " + email + " does not exists.";
                    result.redirect("/MyUploads");

                    return false;
                }

                if (!user.isVerified) {
                    request.session.status = "error";
                    request.session.message = "User " + user.name + " account is not verified.";
                    result.redirect("/MyUploads");

                    return false;
                }

                var me = await database.collection("users").findOne({
                    "_id": ObjectId(request.session.user._id)
                });

                var file = null;
                if (type == "folder") {
                    file = await functions.recursiveGetFolder(me.uploaded, _id);
                } else {
                    file = await functions.recursiveGetFile(me.uploaded, _id);
                }

                if (file == null) {
                    request.session.status = "error";
                    request.session.message = "File does not exists.";
                    result.redirect("/MyUploads");

                    return false;
                }
                file._id = ObjectId(file._id);

                const sharedBy = me;

                await database.collection("users").findOneAndUpdate({
                    "_id": user._id
                }, {
                    $push: {
                        "sharedWithMe": {
                            "_id": ObjectId(),
                            "file": file,
                            "sharedBy": {
                                "_id": ObjectId(sharedBy._id),
                                "name": sharedBy.name,
                                "email": sharedBy.email
                            },
                            "createdAt": new Date().getTime()
                        }
                    }
                });

                request.session.status = "success";
                request.session.message = "File has been shared with " + user.name + ".";
                
                const backURL = request.header("Referer") || "/";
                result.redirect(backURL);
            }

            result.redirect("/Login");
        });

        // get user for confirmation
        app.post("/GetUser", async function (request, result) {
            const email = request.fields.email;

            if (request.session.user) {
                var user = await database.collection("users").findOne({
                    "email": email
                });

                if (user == null) {
                    result.json({
                        "status": "error",
                        "message": "User " + email + " does not exists."
                    });
                    return false;
                }

                if (!user.isVerified) {
                    result.json({
                        "status": "error",
                        "message": "User " + user.name + " account is not verified."
                    });
                    return false;
                }

                result.json({
                    "status": "success",
                    "message": "Data has been fetched.",
                    "user": {
                        "_id": user._id,
                        "name": user.name,
                        "email": user.email
                    }
                });
                return false;
            }

            result.json({
                "status": "error",
                "message": "Please login to perform this action."
            });
            return false;
        });

        // delete shared folder
        app.post("/DeleteSharedDirectory", async function (request, result) {
            const _id = request.fields._id;

            if (request.session.user) {

                var user = await database.collection("users").findOne({
                    "_id": ObjectId(request.session.user._id)
                });

                var updatedArray = await functions.removeSharedFolderReturnUpdated(user.sharedWithMe, _id);
                for (var a = 0; a < updatedArray.length; a++) {
                    updatedArray[a]._id = ObjectId(updatedArray[a]._id);
                }

                await database.collection("users").updateOne({
                    "_id": ObjectId(request.session.user._id)
                }, {
                    $set: {
                        "sharedWithMe": updatedArray
                    }
                });

                const backURL = request.header('Referer') || '/';
                result.redirect(backURL);
                return false;
            }

            result.redirect("/Login");
        });

        // delete uploaded folder
        app.post("/DeleteDirectory", async function (request, result) {
            const _id = request.fields._id;

            if (request.session.user) {

                var user = await database.collection("users").findOne({
                    "_id": ObjectId(request.session.user._id)
                });

                // free up the space so user can upload more
                const folder = functions.recursiveGetFolder(user.uploaded, _id);
                const folderSize = functions.getFolderSize(folder.files);
                user.remainingData += folderSize;

                var updatedArray = await functions.removeFolderReturnUpdated(user.uploaded, _id);
                for (var a = 0; a < updatedArray.length; a++) {
                    updatedArray[a]._id = ObjectId(updatedArray[a]._id);
                }

                await database.collection("users").updateOne({
                    "_id": ObjectId(request.session.user._id)
                }, {
                    $set: {
                        "remainingData": user.remainingData,
                        "uploaded": updatedArray
                    }
                });

                // const backURL = request.header('Referer') || '/';
                result.redirect("/");
                return false;
            }

            result.redirect("/Login");
        });

        // delete shared file
        app.post("/DeleteSharedFile", async function (request, result) {
            const _id = request.fields._id;

            if (request.session.user) {
                var user = await database.collection("users").findOne({
                    "_id": ObjectId(request.session.user._id)
                });

                var updatedArray = await functions.removeSharedFileReturnUpdated(user.sharedWithMe, _id);
                for (var a = 0; a < updatedArray.length; a++) {
                    updatedArray[a]._id = ObjectId(updatedArray[a]._id);
                }

                await database.collection("users").updateOne({
                    "_id": ObjectId(request.session.user._id)
                }, {
                    $set: {
                        "sharedWithMe": updatedArray
                    }
                });

                const backURL = request.header('Referer') || '/';
                result.redirect(backURL);
                return false;
            }

            result.redirect("/Login");
        });

        // delete uploaded file
        app.post("/DeleteFile", async function (request, result) {
            const _id = request.fields._id;

            if (request.session.user) {
                var user = await database.collection("users").findOne({
                    "_id": ObjectId(request.session.user._id)
                });

                // free up the space so user can upload more
                var file = functions.recursiveGetFile(user.uploaded, _id);
                user.remainingData += file.size;

                var updatedArray = await functions.removeFileReturnUpdated(user.uploaded, _id);
                for (var a = 0; a < updatedArray.length; a++) {
                    updatedArray[a]._id = ObjectId(updatedArray[a]._id);
                }

                await database.collection("users").updateOne({
                    "_id": ObjectId(request.session.user._id)
                }, {
                    $set: {
                        "remainingData": user.remainingData,
                        "uploaded": updatedArray
                    },

                    $push: {
                        "trashCan": file
                    }
                });

                // Delete the file
                fileSystem.unlink(file.filePath, function (err) {
                    if (err) throw err;
                    console.log('File deleted!');
                });

                const backURL = request.header('Referer') || '/';
                result.redirect(backURL);
                return false;
            }

            result.redirect("/Login");
        });

        // app.post("/GetSharedFileContent", async function (request, result) {
        //     const _id = request.fields._id;

        //     if (request.session.user) {

        //         var user = await database.collection("users").findOne({
        //             "_id": ObjectId(request.session.user._id)
        //         });

        //         var file = await functions.recursiveGetSharedFile(user.sharedWithMe, _id);
        //         if (file == null) {
        //             result.json({
        //                 "status": "error",
        //                 "message": "File does not exists."
        //             });
        //             return false;
        //         }

        //         // could be used when I prevent the direct file listing
        //         // fileSystem.readFile(file.filePath, function (error, data) {
        //         //     console.log(data);

        //             result.json({
        //                 "status": "success",
        //                 "message": "Data has been fetched.",
        //                 "file": mainURL + "/" + file.filePath
        //             });
        //         // });
        //         return false;
        //     }

        //     result.json({
        //         "status": "error",
        //         "message": "Please login to perform this action."
        //     });
        //     return false;
        // });

        // download file
        app.post("/DownloadFile", async function (request, result) {
            const _id = request.fields._id;

            var link = await database.collection("public_links").findOne({
                "file._id": ObjectId(_id)
            });

            if (link != null) {
                fileSystem.readFile(link.file.filePath, async function (error, data) {
                    // console.log(error);

                    // increment the downloads
                    link.downloads++;
                    await database.collection("public_links").findOneAndUpdate({
                        "file._id": ObjectId(_id)
                    }, {
                        $set: {
                            "downloads": link.downloads
                        }
                    });

                    result.json({
                        "status": "success",
                        "message": "Data has been fetched.",
                        "arrayBuffer": data,
                        "fileType": link.file.type,
                        // "file": mainURL + "/" + file.filePath,
                        "fileName": link.file.name
                    });
                });
                return false;
            }

            if (request.session.user) {

                var user = await database.collection("users").findOne({
                    "_id": ObjectId(request.session.user._id)
                });

                var fileUploaded = await functions.recursiveGetFile(user.uploaded, _id);
                var fileShared = await functions.recursiveGetSharedFile(user.sharedWithMe, _id);
                
                if (fileUploaded == null && fileShared == null) {
                    result.json({
                        "status": "error",
                        "message": "File is neither uploaded nor shared with you."
                    });
                    return false;
                }

                var file = (fileUploaded == null) ? fileShared : fileUploaded;

                /*fileSystem.readFile(file.filePath, function (error, data) {
                    // console.log(error);

                    result.json({
                        "status": "success",
                        "message": "Data has been fetched.",
                        "arrayBuffer": data,
                        "fileType": file.type,
                        // "file": mainURL + "/" + file.filePath,
                        "fileName": file.name
                    });
                });*/

                var CHUNK_SIZE = 10 * 1024 * 1024; // 10MB
                var buffer = Buffer.alloc(CHUNK_SIZE);
                var bufferArr = [];
                var totalSizeRead = 0;

                // Read file stats
                const userSocketID = socketUsers[request.session.user._id];

                console.log(file.filePath);

                fileSystem.open(file.filePath, 'r', function(err, fd) {
                    if (err) throw err;
                    function readNextChunk() {
                        fileSystem.read(fd, buffer, 0, CHUNK_SIZE, null, function(err, nread) {
                            if (err) throw err;

                            if (nread === 0) {
                                // done reading file, do any necessary finalization steps

                                socketIO.to(userSocketID).emit("download_completed", {
                                    "fileType": file.type,
                                    "fileName": file.name
                                });

                                fileSystem.close(fd, function(err) {
                                    if (err) throw err;
                                });

                                result.json({
                                    "status": "success",
                                    "message": "Data has been fetched."
                                });
                                return;
                            }

                            var data;
                            if (nread < CHUNK_SIZE) {
                                data = buffer.slice(0, nread);
                            } else {
                                data = buffer;
                            }

                            if (totalSizeRead < file.size) {
                                socketIO.to(userSocketID).emit("download_chunk_received", data);
                                
                                bufferArr.push(data);
                                totalSizeRead += CHUNK_SIZE;
                                
                                readNextChunk();
                            }
                            // do something with `data`, then call `readNextChunk();`
                        });
                    }
                    readNextChunk();
                });

                return false;

                // read binary data
                /*var bitmap = fileSystem.readFileSync(file.filePath);
                // convert binary data to base64 encoded string
                var base64str = new Buffer(bitmap).toString('base64');
                result.json({
                    "status": "success",
                    "message": "Data has been fetched.",
                    "arrayBuffer": "",
                    "base64str": base64str,
                    "fileType": file.type,
                    "fileName": file.name
                });
                return false;*/
            }

            result.json({
                "status": "error",
                "message": "Please login to perform this action."
            });
            return false;
        });

        // app.post("/GetFileContent", async function (request, result) {
        //     const _id = request.fields._id;

        //     if (request.session.user) {

        //         var user = await database.collection("users").findOne({
        //             "_id": ObjectId(request.session.user._id)
        //         });

        //         var file = await functions.recursiveGetFile(user.uploaded, _id);
        //         if (file == null) {
        //             result.json({
        //                 "status": "error",
        //                 "message": "File does not exists."
        //             });
        //             return false;
        //         }

        //         // could be used when I prevent the direct file listing
        //         // fileSystem.readFile(file.filePath, function (error, data) {
        //         //     console.log(data);

        //             result.json({
        //                 "status": "success",
        //                 "message": "Data has been fetched.",
        //                 "file": mainURL + "/" + file.filePath
        //             });
        //         // });
        //         return false;
        //     }

        //     result.json({
        //         "status": "error",
        //         "message": "Please login to perform this action."
        //     });
        //     return false;
        // });

        // create new folder
        app.post("/CreateFolder", async function (request, result) {

            const name = request.fields.name;
            const _id = request.fields._id;

            if (request.session.user) {

                var user = await database.collection("users").findOne({
                    "_id": ObjectId(request.session.user._id)
                });

                var uploadedObj = {
                    "_id": ObjectId(),
                    "type": "folder",
                    "folderName": name,
                    "files": [],
                    "folderPath": "",
                    "createdAt": new Date().getTime()
                };

                var folderPath = "";
                var updatedArray = [];
                if (_id == "") {
                    folderPath = "public/uploads/" + user.email + "/" + name;
                    uploadedObj.folderPath = folderPath;

                    if (!fileSystem.existsSync("public/uploads/" + user.email)) {
                        fileSystem.mkdirSync("public/uploads/" + user.email);
                    }
                } else {
                    var folderObj = await functions.recursiveGetFolder(user.uploaded, _id);
                    uploadedObj.folderPath = folderObj.folderPath + "/" + name;
                    updatedArray = await functions.getUpdatedArray(user.uploaded, _id, uploadedObj);
                }

                if (uploadedObj.folderPath == "") {
                    request.session.status = "error";
                    request.session.message = "Folder name must not be empty.";
                    result.redirect("/MyUploads");
                    return false;
                }

                if (fileSystem.existsSync(uploadedObj.folderPath)) {
                    request.session.status = "error";
                    request.session.message = "Folder with same name already exists";
                    result.redirect("/MyUploads");
                    return false;
                }

                fileSystem.mkdirSync(uploadedObj.folderPath);

                if (_id == "") {
                    await database.collection("users").updateOne({
                        "_id": ObjectId(request.session.user._id)
                    }, {
                        $push: {
                            "uploaded": uploadedObj
                        }
                    });
                } else {

                    for (var a = 0; a < updatedArray.length; a++) {
                        updatedArray[a]._id = ObjectId(updatedArray[a]._id);
                    }

                    await database.collection("users").updateOne({
                        "_id": ObjectId(request.session.user._id)
                    }, {
                        $set: {
                            "uploaded": updatedArray
                        }
                    });
                }

                result.redirect("/MyUploads/" + _id);
                return false;
            }

            result.redirect("/Login");
        });

        // view all files uploaded by logged-in user
        app.get("/MyUploads/:_id?", async function (request, result) {
            const _id = request.params._id;
            const accessToken = request.query.accessToken;
            const userId = request.query.user_id;

            if (accessToken != null && userId != null) {
                var admin = await database.collection("admin").findOne({
                    "accessToken": accessToken
                });

                if (admin != null) {

                    var user = await database.collection("users").findOne({
                        "_id": ObjectId(userId)
                    });

                    var folderObj = await functions.recursiveGetFolder(user.uploaded, _id);

                    if (folderObj == null) {
                        request.status = "error";
                        request.message = "Folder not found.";
                        result.render("Error", {
                            "request": request
                        });
                        return false;
                    }

                    uploaded = folderObj.files;
                    folderName = folderObj.folderName;
                    createdAt = folderObj.createdAt;

                    if (uploaded == null) {
                        request.status = "error";
                        request.message = "Directory not found.";
                        result.render("Error", {
                            "request": request
                        });
                        return false;
                    }

                    result.render("MyUploads", {
                        "request": request,
                        "uploaded": uploaded,
                        "_id": _id,
                        "folderName": folderName,
                        "createdAt": createdAt
                    });
                    return false;
                }
            }

            if (request.session.user) {

                var user = await database.collection("users").findOne({
                    "_id": ObjectId(request.session.user._id)
                });

                var uploaded = null;
                var folderName = "";
                var createdAt = "";
                if (typeof _id == "undefined") {
                    uploaded = user.uploaded;
                } else {
                    var folderObj = await functions.recursiveGetFolder(user.uploaded, _id);

                    if (folderObj == null) {
                        request.status = "error";
                        request.message = "Folder not found.";
                        result.render("Error", {
                            "request": request
                        });
                        return false;
                    }

                    uploaded = folderObj.files;
                    folderName = folderObj.folderName;
                    createdAt = folderObj.createdAt;
                }

                if (uploaded == null) {
                    request.status = "error";
                    request.message = "Directory not found.";
                    result.render("Error", {
                        "request": request
                    });
                    return false;
                }

                result.render("MyUploads", {
                    "request": request,
                    "uploaded": uploaded,
                    "_id": _id,
                    "folderName": folderName,
                    "createdAt": createdAt
                });
                return false;
            }

            result.redirect("/Login");
        });

        // upload new file
        app.post("/UploadFile", async function (request, result) {
            if (request.session.user) {

                const compression = request.fields.compression;

                var user = await database.collection("users").findOne({
                    "_id": ObjectId(request.session.user._id)
                });
                
                if (request.files.file.size > 0) {

                    const type = request.files.file.type;
                    const _id = request.fields._id;

                    // check if upload limit exceeded
                    const fileSize = request.files.file.size;
                    if (fileSize > user.remainingData) {
                        request.status = "error";
                        request.message = "Kindly buy more data to upload this file.";
                        result.render("Error", {
                            "request": request
                        });
                        return false;
                    }

                    // subtract from user remaining data
                    user.remainingData = user.remainingData - fileSize;

                    var uploadedObj = {
                        "_id": ObjectId(),
                        "size": request.files.file.size, // in bytes
                        "name": request.files.file.name,
                        "type": type,
                        "filePath": "",
                        "createdAt": new Date().getTime()
                    };

                    var filePath = "";
                    const isImage = (type == "image/png" || type == "image/jpeg" || type == "image/heic");

                    // if it is the root path
                    if (_id == "") {
                        const currentTimestamp = new Date().getTime();
                        filePath = "uploads/" + currentTimestamp + "-" + request.files.file.name;
                        const compressedFilePath = "public/uploads/" + user.email + "/";
                        uploadedObj.filePath = compressedFilePath + currentTimestamp + "-" + request.files.file.name;

                        if (!isImage) {
                            filePath = uploadedObj.filePath;
                        }

                        if (!fileSystem.existsSync("public/uploads/" + user.email)){
                            fileSystem.mkdirSync("public/uploads/" + user.email);
                        }

                        // Read the file
                        fileSystem.readFile(request.files.file.path, function (err, data) {
                            if (err) throw err;
                            console.log('File read!');

                            // Write the file
                            fileSystem.writeFile(filePath, data, async function (err) {
                                if (err) throw err;
                                console.log('File written!');

                                if (isImage) {
                                    compressImages(filePath, compressedFilePath, { compress_force: false, statistic: true, autoupdate: true }, false,
                                        { jpg: { engine: "mozjpeg", command: ["-quality", compression] } },
                                        { png: { engine: "pngquant", command: ["--quality=" + compression + "-" + compression, "-o"] } },
                                        { svg: { engine: "svgo", command: "--multipass" } },
                                        { gif: { engine: "gifsicle", command: ["--colors", "64", "--use-col=web"] } },
                                        async function (error, completed, statistic) {
                                            console.log("-------------");
                                            console.log(error);
                                            console.log(completed);
                                            console.log(statistic);
                                            console.log("-------------");

                                            uploadedObj.size = statistic.size_output;

                                            await database.collection("users").updateOne({
                                                "_id": ObjectId(request.session.user._id)
                                            }, {
                                                $set: {
                                                    "remainingData": user.remainingData
                                                },
                                                $push: {
                                                    "uploaded": uploadedObj
                                                }
                                            });

                                            // Delete the file
                                            fileSystem.unlink(filePath, function (err) {
                                                if (err) throw err;
                                                console.log('File deleted!');
                                            });
                                        }
                                    );
                                } else {
                                    await database.collection("users").updateOne({
                                        "_id": ObjectId(request.session.user._id)
                                    }, {
                                        $set: {
                                            "remainingData": user.remainingData
                                        },
                                        $push: {
                                            "uploaded": uploadedObj
                                        }
                                    });
                                }

                                result.redirect("/MyUploads/" + _id);
                            });

                            // Delete the file
                            fileSystem.unlink(request.files.file.path, function (err) {
                                if (err) throw err;
                                console.log('File deleted!');
                            });
                        });

                    } else {

                        // if it is a folder
                        var folderObj = await functions.recursiveGetFolder(user.uploaded, _id);

                        const currentTimestamp = new Date().getTime();
                        let filePath = "uploads/" + currentTimestamp + "-" + request.files.file.name;
                        const compressedFilePath = folderObj.folderPath + "/";
                        uploadedObj.filePath = compressedFilePath + currentTimestamp + "-" + request.files.file.name;

                        if (!isImage) {
                            filePath = uploadedObj.filePath;
                        }

                        // Read the file
                        fileSystem.readFile(request.files.file.path, function (err, data) {
                            if (err) throw err;
                            console.log('File read!');

                            // Write the file
                            fileSystem.writeFile(filePath, data, async function (err) {
                                if (err) throw err;
                                console.log('File written!');

                                if (isImage) {
                                    
                                    compressImages(filePath, compressedFilePath, { compress_force: false, statistic: true, autoupdate: true }, false,
                                        { jpg: { engine: "mozjpeg", command: ["-quality", compression] } },
                                        { png: { engine: "pngquant", command: ["--quality=" + compression + "-" + compression, "-o"] } },
                                        { svg: { engine: "svgo", command: "--multipass" } },
                                        { gif: { engine: "gifsicle", command: ["--colors", "64", "--use-col=web"] } },
                                        async function (error, completed, statistic) {
                                            console.log("-------------");
                                            console.log(error);
                                            console.log(completed);
                                            console.log(statistic);
                                            console.log("-------------");

                                            uploadedObj.size = statistic.size_output;

                                            var updatedArray = await functions.getUpdatedArray(user.uploaded, _id, uploadedObj);
                                            for (var a = 0; a < updatedArray.length; a++) {
                                                updatedArray[a]._id = ObjectId(updatedArray[a]._id);
                                            }

                                            await database.collection("users").updateOne({
                                                "_id": ObjectId(request.session.user._id)
                                            }, {
                                                $set: {
                                                    "uploaded": updatedArray,
                                                    "remainingData": user.remainingData
                                                }
                                            });

                                            // Delete the file
                                            fileSystem.unlink(filePath, function (err) {
                                                if (err) throw err;
                                                console.log('File deleted!');
                                            });
                                        }
                                    );
                                } else {

                                    var updatedArray = await functions.getUpdatedArray(user.uploaded, _id, uploadedObj);
                                    for (var a = 0; a < updatedArray.length; a++) {
                                        updatedArray[a]._id = ObjectId(updatedArray[a]._id);
                                    }

                                    await database.collection("users").updateOne({
                                        "_id": ObjectId(request.session.user._id)
                                    }, {
                                        $set: {
                                            "uploaded": updatedArray,
                                            "remainingData": user.remainingData
                                        }
                                    });
                                }

                                result.redirect("/MyUploads/" + _id);
                            });

                            // Delete the file
                            fileSystem.unlink(request.files.file.path, function (err) {
                                if (err) throw err;
                                console.log('File deleted!');
                            });
                        });
                    }
                    
                } else {
                    request.status = "error";
                    request.message = "Please select valid image.";

                    result.render("Error", {
                        "request": request
                    });
                }

                return false;
            }

            result.redirect("/Login");
        });

        // reset password
        app.post("/ResetPassword", async function (request, result) {
            var email = request.fields.email;
            var reset_token = request.fields.reset_token;
            var new_password = request.fields.new_password;
            var confirm_password = request.fields.confirm_password;

            if (new_password != confirm_password) {
                request.status = "error";
                request.message = "Password does not match.";

                result.render("ResetPassword", {
                    "request": request,
                    "email": email,
                    "reset_token": reset_token
                });
                
                return false;
            }

            var user = await database.collection("users").findOne({
                $and: [{
                    "email": email,
                }, {
                    "reset_token": parseInt(reset_token)
                }]
            });

            if (user == null) {
                request.status = "error";
                request.message = "Email does not exists. Or recovery link is expired.";

                result.render("ResetPassword", {
                    "request": request,
                    "email": email,
                    "reset_token": reset_token
                });
                
                return false;
            }

            bcrypt.hash(new_password, 10, async function (error, hash) {
                await database.collection("users").findOneAndUpdate({
                    $and: [{
                        "email": email,
                    }, {
                        "reset_token": parseInt(reset_token)
                    }]
                }, {
                    $set: {
                        "reset_token": "",
                        "password": hash
                    }
                });

                request.status = "success";
                request.message = "Password has been changed. Please try login again.";

                result.render("Login", {
                    "request": request
                });

            });
        });

        // show page to reset the password
        app.get("/ResetPassword/:email/:reset_token", async function (request, result) {

            var email = request.params.email;
            var reset_token = request.params.reset_token;

            var user = await database.collection("users").findOne({
                $and: [{
                    "email": email
                }, {
                    "reset_token": parseInt(reset_token)
                }]
            });

            if (user == null) {

                request.status = "error";
                request.message = "Link is expired.";
                result.render("Error", {
                    "request": request
                });
                
                return false;
            }

            result.render("ResetPassword", {
                "request": request,
                "email": email,
                "reset_token": reset_token
            });
        });

        // show page to send password reset link
        app.get("/ForgotPassword", function (request, result) {
            result.render("ForgotPassword", {
                "request": request
            });
        });

        // send password reset link
        app.post("/SendRecoveryLink", async function (request, result) {

            var email = request.fields.email;
            var user = await database.collection("users").findOne({
                "email": email
            });

            if (user == null) {
                request.status = "error";
                request.message = "Email does not exists.";

                result.render("ForgotPassword", {
                    "request": request
                });
                return false;
            }

            var reset_token = new Date().getTime();
                
            await database.collection("users").findOneAndUpdate({
                "email": email
            }, {
                $set: {
                    "reset_token": reset_token
                }
            });

            var transporter = nodemailer.createTransport(nodemailerObject);

            var text = "Please click the following link to reset your password: " + mainURL + "/ResetPassword/" + email + "/" + reset_token;
            var html = "Please click the following link to reset your password: <br><br> <a href='" + mainURL + "/ResetPassword/" + email + "/" + reset_token + "'>Reset Password</a> <br><br> Thank you.";

            transporter.sendMail({
                from: nodemailerFrom,
                to: email,
                subject: "Reset Password",
                text: text,
                html: html
            }, function (error, info) {
                if (error) {
                    console.error(error);
                } else {
                    console.log("Email sent: " + info.response);
                }

                request.status = "success";
                request.message = "Email has been sent with the link to recover the password.";

                result.render("ForgotPassword", {
                    "request": request
                });
            });
        });

        // logout the user
        app.get("/Logout", function (request, result) {
            request.session.destroy();
            result.redirect("/");
        });

        // show page to login
        app.get("/Login", function (request, result) {
            result.render("Login", {
                "request": request
            });
        });

        // authenticate the user
        app.post("/Login", async function (request, result) {
            var email = request.fields.email;
            var password = request.fields.password;

            var user = await database.collection("users").findOne({
                "email": email
            });

            if (user == null) {
                request.status = "error";
                request.message = "Email does not exist.";
                result.render("Login", {
                    "request": request
                });
                
                return false;
            }

            bcrypt.compare(password, user.password, function (error, isVerify) {
                if (isVerify) {
                    if (user.isVerified) {
                        request.session.user = user;
                        result.redirect("/");

                        return false;
                    }

                    request.status = "error";
                    request.message = "Kindly verify your email.";
                    result.render("Login", {
                        "request": request
                    });

                    return false;
                }

                request.status = "error";
                request.message = "Password is not correct.";
                result.render("Login", {
                    "request": request
                });
            });
        });

        // show page to verify the email
        app.get("/verifyEmail/:email/:verification_token", async function (request, result) {

            var email = request.params.email;
            var verification_token = request.params.verification_token;

            var user = await database.collection("users").findOne({
                $and: [{
                    "email": email,
                }, {
                    "verification_token": parseInt(verification_token)
                }]
            });

            if (user == null && false) {
                request.status = "error";
                request.message = "Email does not exists. Or verification link is expired.";
                result.render("Login", {
                    "request": request
                });
            } else {

                await database.collection("users").findOneAndUpdate({
                    $and: [{
                        "email": email,
                    }, {
                        "verification_token": parseInt(verification_token)
                    }]
                }, {
                    $set: {
                        "verification_token": "",
                        "isVerified": true
                    }
                });

                request.status = "success";
                request.message = "Account has been verified. Please try login.";
                result.render("Login", {
                    "request": request
                });
            }
        });

        // register the user
        app.post("/Register", async function (request, result) {

            var name = request.fields.name;
            var email = request.fields.email;
            var password = request.fields.password;
            var reset_token = "";
            var isVerified = false;
            var verification_token = new Date().getTime();
            const remainingData = 1 * 1024 * 1024 * 1024; // 1GB
            // const remainingData = 1 * 1024 * 1024; // 1MB

            var user = await database.collection("users").findOne({
                "email": email
            });

            if (user == null) {
                bcrypt.hash(password, 10, async function (error, hash) {
                    await database.collection("users").insertOne({
                        "name": name,
                        "email": email,
                        "password": hash,
                        "reset_token": reset_token,
                        "uploaded": [],
                        "sharedWithMe": [],
                        "trashCan": [],
                        "isVerified": isVerified,
                        "verification_token": verification_token,
                        "remainingData": remainingData
                    }, async function (error, data) {

                        var transporter = nodemailer.createTransport(nodemailerObject);

                        var text = "Please verify your account by click the following link: " + mainURL + "/verifyEmail/" + email + "/" + verification_token;
                        var html = "Please verify your account by click the following link: <br><br> <a href='" + mainURL + "/verifyEmail/" + email + "/" + verification_token + "'>Confirm Email</a> <br><br> Thank you.";

                        await transporter.sendMail({
                            from: nodemailerFrom,
                            to: email,
                            subject: "Email Verification",
                            text: text,
                            html: html
                        }, function (error, info) {
                            if (error) {
                                console.error(error);
                            } else {
                                console.log("Email sent: " + info.response);
                            }

                            request.status = "success";
                            request.message = "Signed up successfully. An email has been sent to verify your account. Once verified, you will be able to login and start using file transfer.";

                            result.render("Register", {
                                "request": request
                            });

                        });
                        
                    });
                });
            } else {
                request.status = "error";
                request.message = "Email already exist.";

                result.render("Register", {
                    "request": request
                });
            }
        });

        // show page to do the registration
        app.get("/Register", function (request, result) {
            result.render("Register", {
                "request": request
            });
        });

        // home page
        app.get("/", function (request, result) {
            result.render("index", {
                "request": request
            });
        });
    });
});