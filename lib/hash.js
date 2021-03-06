const crypto = require('crypto');
const fs = require('fs');


/**
 * Returns a promise that resolves to the SHA1 hash of the stream given
 *
 * @param stream - Node stream of the content to hash.
 */
function hashStream(stream) {
	return new Promise(function(resolve, reject) {
		let hasher = crypto.createHash('sha1')
		hasher.setEncoding('hex')
		hasher.on('finish', function() {
			resolve(hasher.read());
		});

		stream.on('error', function(error) {
			// the docs doesn't say anything about what's passed on error
			reject(error);
		});

		stream.pipe(hasher);
	});
}

/**
 * Returns a promise that resolves to the SHA1 hash of the file given by path
 *
 * @param {string} path - Path to the file to hash.
 */
function hashFile(path) {
	return hashStream(fs.createReadStream(path));
}

module.exports = {
	hashStream,
	hashFile,
}
