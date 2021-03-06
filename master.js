/**
Clusterio master server. Facilitates communication between slaves through
a webserver, storing data related to slaves like production graphs.

@module clusterioMaster
@author Danielv123

@example
node master
*/

// Attempt updating
// const updater = require("./updater");
// updater.update().then(console.log);

// argument parsing
const args = require('minimist')(process.argv.slice(2));

const deepmerge = require("deepmerge");
const path = require("path");
const fs = require("fs-extra");
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const base64url = require('base64url');
const moment = require("moment");
const request = require("request");
const setBlocking = require("set-blocking");
const events = require("events");
const version = require("./package").version;

// constants
let config = {};

// homebrew modules
const generateSSLcert = require("lib/generateSSLcert");
const database = require("lib/database");
const factorio = require("lib/factorio");
const schema = require("lib/schema");
const link = require("lib/link");
const errors = require("lib/errors");
const plugin = require("lib/plugin");
const prometheus = require("lib/prometheus");

// homemade express middleware for token auth
const authenticate = require("lib/authenticate");

const express = require("express");
const compression = require('compression');
const cookieParser = require('cookie-parser');
// Required for express post requests
const bodyParser = require("body-parser");
const fileUpload = require('express-fileupload');
var app = express();
var httpServer;
var httpsServer;

app.use(cookieParser());
app.use(bodyParser.json({
	limit: '10mb',
}));
app.use(bodyParser.urlencoded({
	parameterLimit: 100000,
	limit: '10mb',
	extended: true
}));
app.use(fileUpload());
app.use(compression());

// dynamic HTML generations with EJS
app.set('view engine', 'ejs');
app.set('views', ['views', 'sharedPlugins']);

// give ejs access to some interesting information
app.use(function(req, res, next){
	res.locals.res = res;
	res.locals.req = req;
	res.locals.slaves = db.slaves;
	res.locals.moment = moment;
	next();
});

require("./routes")(app);
require("./routes/api/getPictures")(app);
// Set folder to serve static content from (the website)
app.use(express.static('static'));

const endpointHitCounter = new prometheus.Gauge(
	'clusterio_master_http_endpoint_hits_total', "How many requests a particular endpoint has gotten",
	{ labels: ['route'] }
);

// Prometheus polling endpoint
async function getMetrics(req, res, next) {
	endpointHitCounter.labels(req.route.path).inc();

	let results = []
	for (let masterPlugin of masterPlugins.values()) {
		let pluginResults = await masterPlugin.onMetrics();
		if (pluginResults !== undefined) {
			for await (let result of pluginResults) {
				results.push(result)
			}
		}
	}

	let requests = [];
	for (let slaveConnection of slaveConnections.values()) {
		// XXX this needs a timeout
		requests.push(link.messages.getMetrics.send(slaveConnection));
	}

	for await (let result of await prometheus.defaultRegistry.collect()) {
		results.push(result);
	}

	let resultMap = new Map();
	for (let response of await Promise.all(requests)) {
		for (let result of response.results) {
			if (!resultMap.has(result.metric.name)) {
				resultMap.set(result.metric.name, result);

			} else {
				// Merge metrics received by multiple slaves
				let stored = resultMap.get(result.metric.name);
				stored.samples.push(...result.samples);
			}
		}
	}

	for (let result of resultMap.values()) {
		results.push(prometheus.deserializeResult(result));
	}

	let text = await prometheus.exposition(results);
	res.set('Content-Type', prometheus.exposition.contentType);
	res.send(text);
}
app.get('/metrics', (req, res, next) => getMetrics(req, res, next).catch(next));


const masterConnectedClientsCount = new prometheus.Gauge(
	'clusterio_master_connected_clients_count', "How many clients are currently connected to this master server",
	{
		labels: ['type'], callback: async function(gauge) {
			gauge.labels("slave").set(slaveConnections.size);
			gauge.labels("control").set(controlConnections.length);
		},
	},
);

// set up database
const db = {};

/**
 * Load Map from JSON file in the database directory.
 */
async function loadMap(databaseDirectory, file) {
	let databasePath = path.resolve(databaseDirectory, file);
	console.log(`Loading ${databasePath}`);
	return await database.loadJsonArrayAsMap(databasePath);
}

/**
 * Save Map to JSON file in the database directory.
 */
async function saveMap(databaseDirectory, file, map) {
	let databasePath = path.resolve(config.databaseDirectory, file);
	console.log(`Saving ${databasePath}`);
	await database.saveMapAsJsonArray(databasePath, map);
}


/**
 * Innitiate shutdown of master server
 */
async function shutdown() {
	console.log('Shutting down');
	let exitStartTime = Date.now();
	try {
		await saveMap(config.databaseDirectory, "slaves.json", db.slaves);
		await saveMap(config.databaseDirectory, "instances.json", db.instances);

		for (let [pluginName, masterPlugin] of masterPlugins) {
			let startTime = Date.now();
			await masterPlugin.onExit();
			console.log(`Plugin ${pluginName} exited in ${Date.now() - startTime}ms`);
		}

		for (let controlConnection of controlConnections) {
			controlConnection.connector.close("shutdown");
		}

		for (let slaveConnection of slaveConnections.values()) {
			slaveConnection.connector.close("shutdown");
		}

		if (httpServer) {
			console.log("Stopping HTTP server");
			await new Promise(resolve => httpServer.close(resolve));
		}

		if (httpsServer) {
			console.log("Stopping HTTPS server");
			await new Promise(resolve => httpsServer.close(resolve));
		}

		console.log(`Clusterio cleanly exited in ${Date.now() - exitStartTime}ms`);

	} catch(err) {
		setBlocking(true);
		console.error(`
+--------------------------------------------------------------------+
| Unexpected error occured while shutting down master, please report |
| it to https://github.com/clusterio/factorioClusterio/issues        |
+--------------------------------------------------------------------+`
		);
		console.error(err);
		process.exit(1);
	}
}

// wrap a request in an promise
async function downloadPage(url) {
	return new Promise((resolve, reject) => {
		request(url, (error, response, body) => {
			resolve(body);
		});
	});
}

app.get("/api/modmeta", async function(req, res) {
	endpointHitCounter.labels(req.route.path).inc();
	res.header("Access-Control-Allow-Origin", "*");
	res.setHeader('Content-Type', 'application/json');
	let modData = await downloadPage("https://mods.factorio.com/api/mods/" + req.query.modname);
	res.send(modData);
});


var localeCache;
/**
GET endpoint. Returns factorio's base locale as a JSON object.

@memberof clusterioMaster
@instance
@alias api/getFactorioLocale
@returns {object<string, object>} 2 deep nested object with base game factorio locale as key:value pairs
*/
app.get("/api/getFactorioLocale", function(req,res){
	endpointHitCounter.labels(req.route.path).inc();
	if (!localeCache) {
		factorio.getLocale(path.join(config.factorioDirectory, "data"), "en").then(locale => {
			localeCache = locale;
			res.send(localeCache);
		});
	} else {
		res.send(localeCache);
	}
});

// socket.io connection for slaves
var io = require("socket.io")({});

class BaseConnection extends link.Link {
	constructor(target, connector) {
		super('master', target, connector);
		link.attachAllMessages(this);
		for (let masterPlugin of masterPlugins.values()) {
			plugin.attachPluginMessages(this, masterPlugin.info, masterPlugin);
		}
	}

	async forwardRequestToInstance(message, request) {
		let instance = db.instances.get(message.data.instance_id);
		if (!instance) {
			throw new errors.RequestError(`Instance with ID ${instance_id} does not exist`);
		}

		let connection = slaveConnections.get(instance.slaveId);
		if (!connection) {
			throw new errors.RequestError("Slave containing instance is not connected");
		}

		return await request.send(connection, message.data);
	}

	async forwardEventToInstance(message, event) {
		let instance = db.instance.get(message.data.instance_id);
		if (!instance) { return; }

		let connection = slaveConnection.get(instance.slaveId);
		if (!connection) { return; }

		event.send(connection, message.data);
	}

	async broadcastEventToInstance(message, event) {
		for (let slaveConnection of slaveConnections.values()) {
			if (slaveConnection === this) {
				continue; // Do not broadcast back to the source
			}

			event.send(slaveConnection, message.data);
		}
	}
}

let controlConnections = new Array();
class ControlConnection extends BaseConnection {
	constructor(registerData, connector) {
		super('control', connector)

		this._agent = registerData.agent;
		this._version = registerData.version;

		this.connector.on('disconnect', () => {
			let index = controlConnections.indexOf(this);
			if (index !== -1) {
				controlConnections.splice(index, 1);
			}
		});

		this.instanceOutputSubscriptions = new Set();
	}

	async listSlavesRequestHandler(message) {
		let list = [];
		for (let slave of db.slaves.values()) {
			list.push({
				agent: slave.agent,
				version: slave.version,
				id: slave.id,
				name: slave.name,
				connected: slaveConnections.has(slave.id),
			});
		}
		return { list };
	}

	async listInstancesRequestHandler(message) {
		let list = [];
		for (let instance of db.instances.values()) {
			list.push({
				id: instance.id,
				name: instance.name,
				slave_id: instance.slaveId,
			});
		}
		return { list };
	}

	// XXX should probably add a hook for slave reuqests?
	async createInstanceCommandRequestHandler(message) {
		let { slave_id, name } = message.data;
		let connection = slaveConnections.get(slave_id);
		if (!connection) {
			throw new errors.RequestError("Slave is not connected");
		}

		await link.messages.createInstance.send(connection, {
			id: Math.random() * 2**31 | 0, // TODO: add id option
			options: {
				'name': name,
				'description': config.description,
				'visibility': config.visibility,
				'username': config.username,
				'token': config.token,
				'game_password': config.game_password,
				'verify_user_identity': config.verify_user_identity,
				'allow_commands': config.allow_commands,
				'auto_pause': config.auto_pause,
			}
		});
	}

	async setInstanceOutputSubscriptionsRequestHandler(message) {
		this.instanceOutputSubscriptions = new Set(message.data.instance_ids);
	}
}

var slaveConnections = new Map();
class SlaveConnection extends BaseConnection {
	constructor(registerData, connector) {
		super('slave', connector);

		this._agent = registerData.agent;
		this._id = registerData.id;
		this._name = registerData.name;
		this._version = registerData.version;

		db.slaves.set(this._id, {
			agent: this._agent,
			id: this._id,
			name: this._name,
			version: this._version,
		});

		this.connector.on('message', () => {
			// XXX prometheusWsUsageCounter.labels('message', "other").inc();
		});

		this.connector.on('disconnect', () => {
			if (slaveConnections.get(this._id) === this) {
				slaveConnections.delete(this._id);
			}
		});
	}

	async updateInstancesEventHandler(message) {
		// Prune any instances previously had by the slave
		for (let id of [...db.instances.keys()]) {
			if (db.instances.get(id).slaveId === this._id) {
				db.instances.delete(id);
			}
		}

		for (let instance of message.data.instances) {
			db.instances.set(instance.id, {
				id: instance.id,
				name: instance.name,
				slaveId: this._id,
			});
		}
	}

	async instanceOutputEventHandler(message) {
		let { instance_id, output } = message.data;
		for (let controlConnection of controlConnections) {
			if (controlConnection.instanceOutputSubscriptions.has(instance_id)) {
				link.messages.instanceOutput.send(controlConnection, message.data);
			}
		}
	}
}

// Authentication middleware for socket.io connections
io.use((socket, next) => {
	let token = socket.handshake.query.token;
	authenticate.check(token).then((result) => {
		if (result.ok) {
			next();
		} else {
			console.error(`SOCKET | authentication failed for ${socket.handshake.address}`);
			next(new Error(result.msg));
		}
	});
});

/**
 * Returns true if value is a signed 32-bit integer
 *
 * @param value - value to test.
 * @returns {Boolean}
 *     true if value is an integer between -2**31 and 2**31-1.
 */
function isInteger(value) {
	return value | 0 === value;
}


/**
 * Connector for master server connections
 */
class SocketIOServerConnector extends events.EventEmitter {
	constructor(socket) {
		super();

		this._seq = 1;
		this._socket = socket;

		this._socket.on('message', message => {
			this.emit('message', message);
		});
		this._socket.on('disconnect', () => {
			this.emit('disconnect');
		});
	}

	/**
	 * Send a message over the socket
	 *
	 * @returns the sequence number of the message sent
	 */
	send(type, data = {}) {
		this._socket.send({ seq: this._seq, type, data });
		return this._seq++;
	}

	/**
	 * Close the connection with the given reason.
	 *
	 * Sends a close message and disconnects the connector.
	 */
	close(reason) {
		this.send('close', { reason });
		this.disconnect();
	}

	/**
	 * Immediatly close the connection
	 */
	disconnect() {
		this._socket.disconnect(true);
	}
}

io.on('connection', function (socket) {
	console.log(`SOCKET | new connection from ${socket.handshake.address}`);

	// Start connection handshake
	let connector = new SocketIOServerConnector(socket);
	connector.send('hello', { version });

	// Handle socket handshake
	socket.once('message', (payload) => {
		// XXX prometheusWsUsageCounter.labels('message', "other").inc();
		if (!schema.clientHandshake(payload)) {
			console.log(`SOCKET | closing ${socket.handshake.address} after receiving invalid handshake`, payload);
			connector.send('close', { reason: "Invalid handshake" });
			connector.disconnect(true);
			return;
		}

		let { seq, type, data } = payload;
		if (type === "register_slave") {
			let connection = slaveConnections.get(data.id);
			if (connection) {
				console.log(`SOCKET | disconecting existing connection for slave ${data.id}`);
				connection.connector.close("Registered from another connection");
			}

			console.log(`SOCKET | registered slave ${data.id} version ${data.version}`);
			slaveConnections.set(data.id, new SlaveConnection(data, connector));
			connector.send('ready');

		} else if (type === "register_control") {
			console.log(`SOCKET | registered control from ${socket.handshake.address}`);
			controlConnections.push(new ControlConnection(data, connector));
			connector.send('ready');

		} else if (type === "close") {
			console.log(`SOCKET | received close from ${socket.handshake.address}: ${data.reason}`);
			connector.disconnect();
			return;
		}
	});
});

// handle plugins on the master
var masterPlugins = new Map();
async function pluginManagement(){
	let startPluginLoad = Date.now();
	masterPlugins = await loadPlugins();
	console.log("All plugins loaded in "+(Date.now() - startPluginLoad)+"ms");
}

async function loadPlugins() {
	let plugins = new Map();
	for (pluginInfo of await plugin.getPluginInfos("plugins")) {
		if (!pluginInfo.enabled) {
			continue;
		}

		let pluginLoadStarted = Date.now();
		let MasterPlugin = plugin.BaseMasterPlugin;
		if (pluginInfo.masterEntrypoint) {
			({ MasterPlugin } = require(`./plugins/${pluginInfo.name}/${pluginInfo.masterEntrypoint}`));
		}

		let masterPlugin = new MasterPlugin(pluginInfo);
		await masterPlugin.init();
		plugins.set(pluginInfo.name, masterPlugin);

		console.log(`Clusterio | Loaded plugin ${pluginInfo.name} in ${Date.now() - pluginLoadStarted}ms`);
		/*
			main:new masterPlugin({
			TODO?
				config, socketio: io, express: app,
				db,
			}),
			pluginConfig,
		});*/
	}
	return plugins;
}

/**
 * Calls listen on server capturing any errors that occurs
 * binding to the port.
 */
function listen(server, ...args) {
	return new Promise((resolve, reject) => {
		function wrapError(err) {
			reject(new errors.StartupError(
				`Server listening failed: ${err.message}`
			));
		}

		server.once('error', wrapError);
		server.listen(...args, () => {
			server.off('error', wrapError);
			resolve();
		});
	});
}

async function startServer() {
	// Set the process title, shows up as the title of the CMD window on windows
	// and as the process name in ps/top on linux.
	process.title = "clusterioMaster";

	// add better stack traces on promise rejection
	process.on('unhandledRejection', r => console.log(r));

	console.log(`Requiring config from ${args.config || './config'}`);
	config = require(args.config || './config');

	/** Sync */
	function randomStringAsBase64Url(size) {
	  return base64url(crypto.randomBytes(size));
	}

	if (!fs.existsSync("secret-api-token.txt")) {
		config.masterAuthSecret = randomStringAsBase64Url(256);
		fs.writeFileSync("config.json",JSON.stringify(config, null, 4));
		fs.writeFileSync("secret-api-token.txt", jwt.sign({ id: "api" }, config.masterAuthSecret, {
			expiresIn: 86400*365 // expires in 1 year
		}));
		console.log("Generated new master authentication private key!");
		process.exit(0);
	}
	// write an auth token to file
	fs.writeFileSync("secret-api-token.txt", jwt.sign({ id: "api" }, config.masterAuthSecret, {
		expiresIn: 86400*365 // expires in 1 year
	}));

	let secondSigint = false
	process.on('SIGINT', () => {
		if (secondSigint) {
			console.log("Caught second interrupt, terminating immediately");
			process.exit(1);
		}

		secondSigint = true;
		console.log("Caught interrupt signal, shutting down");
		shutdown();
	});

	// terminal closed
	process.on('SIGHUP', () => {
		// No graceful cleanup, no warning out (stdout is likely closed.)
		// Don't close the terminal with the clusterio master in it.
		process.exit(1);
	});

	config.databaseDirectory = args.databaseDirectory || config.databaseDirectory || "./database";
	await fs.ensureDir(config.databaseDirectory);

	db.slaves = await loadMap(config.databaseDirectory, "slaves.json");
	db.instances = await loadMap(config.databaseDirectory, "instances.json");

	authenticate.setAuthSecret(config.masterAuthSecret);

	// Make sure we're actually going to listen on a port
	let httpPort = args.masterPort || config.masterPort;
	let httpsPort = args.sslPort || config.sslPort;
	if (!httpPort && !httpsPort) {
		console.error("Error: at least one of httpPort and sslPort must be configured");
		process.exit(1);
	}

	// Create a self signed certificate if the certificate files doesn't exist
	if (httpsPort && !await fs.exists(config.sslCert) && !await fs.exists(config.sslPrivKey)) {
		await generateSSLcert({
			sslCertPath: config.sslCert,
			sslPrivKeyPath: config.sslPrivKey,
			doLogging: true,
		});
	}

	// Load plugins
	await pluginManagement();

	// Only start listening for connections after all plugins have loaded
	if (httpPort) {
		httpServer = require("http").Server(app);
		await listen(httpServer, httpPort);
		io.attach(httpServer);
		console.log("Listening for HTTP on port %s...", httpServer.address().port);
	}

	if (httpsPort) {
		let certificate, privateKey;
		try {
			certificate = await fs.readFile(config.sslCert);
			privateKey = await fs.readFile(config.sslPrivKey);

		} catch (err) {
			throw new errors.StartupError(
				`Error loading ssl certificate: ${err.message}`
			);
		}

		httpsServer = require("https").createServer({
			key: privateKey,
			cert: certificate
		}, app)
		await listen(httpsServer, httpsPort);

		// XXX I'm uncertain whether or not socket.io actually supports
		// attaching to multiple servers at the same time.
		io.attach(httpsServer);
		console.log("Listening for HTTPS on port %s...", httpsServer.address().port);
	}
}

module.exports = {
	app,

	// For testing only
	_db: db,
	_config: config,
	_SocketIOServerConnector: SocketIOServerConnector,
	_controlConnections: controlConnections,
	_ControlConnection: ControlConnection,
	_slaveConnections: slaveConnections,
	_SlaveConnection: SlaveConnection,
}

if (module === require.main) {
	console.warn(`
+==========================================================+
I WARNING:  This is the development branch for the 2.0     I
I           version of clusterio.  Expect things to break. I
+==========================================================+
`
	);
	startServer().catch(err => {
		if (err instanceof errors.StartupError) {
			console.error(`
+----------------------------------+
| Unable to to start master server |
+----------------------------------+`
			);
		} else if (err instanceof errors.PluginError) {
			console.error(`
Error: ${err.pluginName} plugin threw an unexpected error
       during startup, please report it to the plugin author.
--------------------------------------------------------------`
			);
			err = err.original;
		} else {
			console.error(`
+---------------------------------------------------------------+
| Unexpected error occured while starting master, please report |
| it to https://github.com/clusterio/factorioClusterio/issues   |
+---------------------------------------------------------------+`
			);
		}

		console.error(err);
		return shutdown();
	});
}
