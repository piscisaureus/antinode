var http = require('http'),
    fs = require('fs'),
    pathlib = require('path'),
    uri = require('url'),
    mime = require('./content-type'),
    log = require('./log'),
    package = JSON.parse(fs.readFileSync(__dirname+'/../package.json', 'utf8')),
    sys = require('sys'),
    spawn = require('child_process').spawn,
    Script = process.binding('evals').Script;

exports.default_settings = {
    "timeout_milliseconds": 1000 * 30,
    "hosts" : {},
    "port" : 8080, /* a port that you don't need root to bind to */
    "default_host" : {
        "root" : process.cwd()
    },
    "log_level" : log.levels.DEBUG
};
exports.log_levels = log.levels;

var serverInfo = "Antinode/" + package.version + " Node.js/" + process.version;

var settings;

var server;

/* require() all the scripts at the start, so there's no
 * waiting for in the middle of a request */
function load_hostspecific_handlers() {
    for (var host in settings.hosts) {
        var script = settings.hosts[host]['handler'];
        if (script !== undefined && typeof script === 'string') {
            /* remove filename extension */
            var require_name = script.match(/(.*)\..*/)[1];
            settings.hosts[host].handler = require(require_name);
        }
    }
}

/* call the module_init method if exists on each registered module.
   allows modules to hook in to the server startup event. */
function handlers_init() {
    for(var host in settings.hosts) {
        if(settings.hosts[host].handler && settings.hosts[host].handler.handler_init) {
            settings.hosts[host].handler.handler_init();
        }
    }
}

/* convert string-encapsulated regular expressions
   that belong to runners to real regular expressions */
function runners_init() {
    if (!settings.runners) {
        break;
    }
    for (var i = 0; i < settings.runners.length; i++) {
        var runner = settings.runners[i];
        if (typeof runner.regexp === 'string') {
            runner.regexp = new RegExp(runner.regexp, runner.regexpFlags || "");
        }
    }
}

/* default preprocessor - just send the file out */
var preprocess_request = map_request_to_local_file; 

exports.start = function(custom_settings, callback) {
    settings = custom_settings || {};
    settings.__proto__ = exports.default_settings;
    
    load_hostspecific_handlers();
    if (settings.request_preprocessor) {
        preprocess_request = settings.request_preprocessor;
    }

    log.level = settings.log_level;
    log.info( "Starting server on port", settings.port);
    
    server = http.createServer(function(req,resp) {
        log.debug("Request from", req.connection.remoteAddress, "for", req.url);
        log.debug(JSON.stringify(req.headers));
        preprocess_request(req, resp, map_request_to_local_file);
    });
    server.listen(settings.port);
    handlers_init();
    runners_init();
    server.addListener('listening', function() {
        if (callback) callback();
    });
    server.addListener('connection', function(connection) {
        connection.setTimeout(settings.timeout_milliseconds);
        connection.addListener('timeout', function() {
            log.debug("Connection from",connection.remoteAddress,"timed out. Closing it...");
            connection.destroy();
        });
    });
};

function decode_path(path) {
    return path
        // convert %xx encoded chars
        .replace(/\%([\da-f]{2})/gi, function(match, code) {
            return String.fromCharCode(parseInt(code, 16));
        })
        // disallow parent directory access
        .replace(/\.\.\//g,'');
}

/* decides which file on our file system the request is asking for
 * then dispatch to stream_file to send it out */
function map_request_to_local_file(req, resp) {
    function select_vhost() {
        if (req.headers.host) {
            var hostname = req.headers.host.split(':')[0]; //remove port
            return settings.hosts[hostname] || settings.default_host;
        } else {
            return settings.default_host;
        }
    }
    var vhost = select_vhost(req.headers.host);
    if (vhost.handler && vhost.handler.handle) {
        var action = vhost.handler.handle(req,resp);
        if(action && typeof action === 'function') {
            if(vhost.handler.handler_environment){
                action.apply(vhost.handler.handler_environment(req, resp))
            }
            else {
                action(req, resp);
            }
            return;
        }
    } 

    // Decode the url
    var url = uri.parse(req.url);
    var rawpath = (url.pathname || '/');

    // By default serve the file as static 
    var runner = {type: 'static'};

    /*
     * We're going to split the url path into two pieces:
     * - `file` is the file or script that the url is mapped to.
     * - `extra` contains the text between the matched file/script and the query,
     *   i.e. if the url path is '/home/test.sjs/something/else?whatever=value' then
     *   extra becoms '/something/else'.
     */
    var file = decode_path(rawpath), 
        extra = '';

    // Search for handlers that match this pathname
    var runners = settings.runners || [];
    for (var i = 0; i < runners.length; i++) {
        var result;
        if ((result = runners[i].regexp.exec(rawpath))) {
            runner = runners[i];
            file = decode_path(result[0]);
            extra = decode_path(rawpath.slice(result[0].length));
            break;
        }
    }

    // Now create a pathInfo object with various path info for consumption by runners
    var pathInfo = {
        file: file,
        fileLocal: pathlib.join(vhost.root, file),
        extra: extra,
        extraLocal: pathlib.join(vhost.root, extra)
    };

    // What type of runner did we find?
    switch (runner.type) {
        // serve static file
        case "static":
            serve_static_file(req, resp, pathInfo.fileLocal);
            break;

        // execute sjs file
        case "sjs":
            execute_sjs(req, resp, pathInfo);
            break;

        // run CGI handler
        case "cgi":
            execute_cgi(req, resp, pathInfo, runner);
            break;

        // fail!
        default:
            throw "Invalid runner type: " + sys.inspect(runner);
    }
}

exports.stop = function(callback) {
    if (server) {
        if (callback) server.addListener('close', callback);
        server.close();
    }
};

function serve_static_file(req, resp, path) {
    function send_headers(httpstatus, length, content_type, modified_time) {
        var headers = {
            "Server": serverInfo,
            "Date": (new Date()).toUTCString()
        };
        if (length) {
            headers["Content-Length"] = length;
        }
        if (content_type) {
            headers["Content-Type"] = content_type || "application/octet-stream";
        }
        if (modified_time) { 
            headers["Last-Modified"] = modified_time.toUTCString(); 
        }
        resp.writeHead(httpstatus, headers);
        log.info(req.connection.remoteAddress,req.method,path,httpstatus,length);
    }

    fs.stat(path, function (err, stats) {
        if (err) {
            // ENOENT is normal on 'file not found'
            if (err.errno != process.ENOENT) { 
                // any other error is abnormal - log it
                log.error("fs.stat(",path,") failed: ", err);
            }
            return file_not_found();
        }
        if (stats.isDirectory()) {
            return serve_static_file(pathlib.join(path, "index.html"), req, resp);
        }
        if (!stats.isFile()) {
            return file_not_found();
        } else {
            var if_modified_since = req.headers['if-modified-since'];
            if (if_modified_since) {
                var req_date = new Date(if_modified_since);
                if (stats.mtime <= req_date && req_date <= Date.now()) {
                    return not_modified();
                }
                else stream_file(path, stats);
            } else if (req.method == 'HEAD') {
                send_headers(200, stats.size, mime.mime_type(path), stats.mtime);
                resp.end('');
            } else {
                return stream_file(path, stats);
            }
        }
    });

    function stream_file(file, stats) {
        try {
            var readStream = fs.createReadStream(file);
        } 
        catch (err) {
            log.debug("fs.createReadStream(",file,") error: ",sys.inspect(err,true));
            return file_not_found();
        }

        send_headers(200, stats.size, mime.mime_type(file), stats.mtime);
        sys.pump(readStream, resp, function() {
            log.debug('pumped',file);
        });

        req.connection.addListener('timeout', function() {
            /* dont destroy it when the fd's already closed */
            if (readStream.readable) {
                log.debug('timed out. destroying file read stream');
                readStream.destroy();
            }
        });

        readStream.addListener('fd', function(fd) {
            log.debug("opened",path,"on fd",fd);
        });

        readStream.addListener('error', function (err) {
            log.error('error reading',file,sys.inspect(err));
            resp.end('');
        });
        resp.addListener('error', function (err) {
            log.error('error writing',file,sys.inspect(err));
            readStream.destroy();
        });
    }

    function not_modified() {
        // no need to send content length or type
        log.debug("304 for resource ", path);
        send_headers(304);
        resp.end('');
    }

    function file_not_found() {
        log.debug("404 opening path: '"+path+"'");
        var body = "404: " + req.url + " not found.\n";
        send_headers(404,body.length,"text/plain");
        if (req.method != 'HEAD') {
            resp.end(body, 'utf-8');
        } else {
            resp.end('');
        }
    }

    function server_error(message) {
        log.error(message);
        send_headers(500, message.length, "text/plain");
        if (req.method !== 'HEAD') {
            resp.end(message,'utf-8');
        }
    }
}

function execute_sjs(req, resp, pathInfo) {
    var path = pathInfo.fileLocal;
    fs.readFile(path, 'utf8', function(err, script) {
        try {
            if (err) throw err;
            var sandbox = {
                log: log,
                require: require,
                __filename: path,
                __dirname: pathlib.dirname(path)
            };
            Script.runInNewContext(script, sandbox, path);
            sandbox.handle(req, resp, pathInfo);
        }
        catch (e) {
            resp.writeHead(500,{'Content-Type':'text/plain'});
            resp.end("Error executing server script "+path+": "+e);
        }
    });
}

// HTTP headers that shouldn't be set as HTTP_something in the environment
var specialHttpHeaders = /^(athorization|proxy-authorization|content-type|content-length)$/i;

// Regular expressions used for CGI response header parsing
var statusHeaderMatch = /^Status:\s*(\d+)\s*(\S.*)?$/i,
    normalHeaderMatch = /^([^:]*)\:\s*(\S.*)?$/;

function execute_cgi(req, resp, pathInfo, runner) {
    var reqHeaders = req.headers;
    var parsedUrl = uri.parse(req.url);

    // Split script path into directory and name
    var cwd = pathlib.dirname(pathInfo.fileLocal);
    var script = pathlib.basename(pathInfo.fileLocal);

    // Add non-http CGI fields to env
    var env = {
        // Gateway and webserver info
        SERVER_SOFTWARE   : serverInfo,
        GATEWAY_INTERFACE : 'CGI/1.1',

        // Request envelope
        SERVER_NAME       : req.headers.host || '',
        SERVER_PORT       : settings.port,
        SERVER_PROTOCOL   : 'HTTP/' + req.httpVersion,
        REQUEST_METHOD    : req.method,

        // Script and parameters
        SCRIPT_NAME       : pathInfo.file,
        QUERY_STRING      : parsedUrl.query || '',
        PATH_INFO         : pathInfo.extra || "",
        PATH_TRANSLATED   : pathInfo.extraLocal || "",

        // Request body
        CONTENT_TYPE      : reqHeaders['content-type'] || '',
        CONTENT_LENGTH    : reqHeaders['content-length'] || '',

        // Remote end
        REMOTE_ADDR       : req.connection.remoteAddress,
        REMOTE_HOST       : '',    // not mandatory and we don't want to do a reverse DNS lookup
        AUTH_TYPE         : '',    // unsupported (HTTP athentication related)
        REMOTE_IDENT      : '',    // unsupported (HTTP athentication related)

        // Non-standard; required to keep PHP-CGI happy
        REDIRECT_STATUS   : 'CGI',
        SCRIPT_FILENAME   : script
    };

    // Add other http header fields prefixed with `HTTP_`,
    // except for content-type, content-length and authentication-related fields
    for (var name in reqHeaders) {
        if (reqHeaders.hasOwnProperty(name) && !specialHttpHeaders.test(name)) {
            env["HTTP_" + name.replace('-', "_").toUpperCase()] = reqHeaders[name];
        }
    }

    // Here we keep track of headers parsed so far
    var statusCode = 200,
        statusText = "OK",
        respHeaders = {};

    // Buffer unprocessed header text here when a data chunk ends with a partial header line
    var bufferedHeaderText = "";

    // Spawn cgi process
    log.debug(cwd + "$ " + runner.exec + " " + script);
    var child = spawn(runner.exec, [script], {env: env, cwd: cwd});

    // We don't need this any more, free up memory
    delete env;

    // Pump request body straight to child process' stdin
    sys.pump(req, child.stdin);

    // Send child process' stderr to log so we know when something's going wrong
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', function(chunk) {
        log.error(chunk);
    });

    // Read the child process' stdout; parse headers first, then use a dumb pump to get the body out
    child.stdout.on("data", function onData(chunk) {
        var match;

        // Concatenate the new chunk to unprocessed data from the previous chunk
        var text = bufferedHeaderText + chunk.toString('ascii');

        // Create a *new* regexp; we depend on the lastIndex property to be correct
        var lineMatch = /^(.*?)\r?\n/mg;

        // Set to true when we're done with the headers
        var headersDone = false;

        // Keep track of the position in `text`
        var offset = 0;

        // Try to split text into lines
        while ((match = lineMatch.exec(text))) {
            offset = lineMatch.lastIndex;

            var line = match[1];
            if (!line) {
                // Empty line, indicates start of body
                headersDone = true;
                break;
            } else if ((match = statusHeaderMatch.exec(line))) {
                // HTTP status
                statusCode = match[1];
                statusText = match[2];
            } else if ((match = normalHeaderMatch.exec(line))) {
                // Normal HTTP header
                respHeaders[match[1]] = match[2];
            } else {
                // Unsupported, ignore for now
                log.error('Got invalid HTTP header from CGI script: ' + line);
            }
        }

        // Done with the headers?
        if (!headersDone) {
            // Store any unprocessed characters in bufferedHeaderText
            bufferedHeaderText = text.slice(offset);
        } else {
            // Flush the headers
            resp.writeHead(statusCode, statusText, respHeaders);

            // The remaining bytes in the chunk buffer belong to the response body; send them
            var chunkOffset = offset - bufferedHeaderText.length;
            if (chunkOffset < chunk.length) {
                resp.write(chunk.slice(chunkOffset, chunk.length));
            }

            // Pump all subsequent chunks straight back to the client
            child.stdout.removeListener('data', onData);
            sys.pump(child.stdout, resp);
        }
    });

    // Wait for the child process to exit
    child.on('exit', function() {
        // Close the response
        resp.end();

        // The child process may be finished even before it has the complete message,
        // therefore close the tcp connection itself too.
        req.connection.end();
    });
}

function close(fd) {
    fs.close(fd);
    log.debug("closed fd",fd);
}
