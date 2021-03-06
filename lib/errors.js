/**
 * Errors thrown in Clusterio
 * @module
 */

class CommandError extends Error { }
class RequestError extends Error { }

// Signal for messages that fail validation
class InvalidMessage extends Error { }

// Errror class for known errors occuring during startup
class StartupError extends Error { }

// Errors outside of our control.
class EnvironmentError extends Error { }

// Errors caused by plugins
class PluginError extends Error {
	constructor(pluginName, original) {
		super(`PluginError: ${original.message}`);
		this.pluginName = pluginName;
		this.original = original;
	}
}

module.exports = {
	CommandError,
	RequestError,
	InvalidMessage,
	StartupError,
	EnvironmentError,
	PluginError,
}
