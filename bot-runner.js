// Sandboxed bot runner — executed as a subprocess
// Receives bot code + game state via stdin, returns bids via stdout
// Dangerous globals are deleted before bot code runs.

var chunks = [];
process.stdin.on("data", function(chunk) { chunks.push(chunk); });
process.stdin.on("end", function() {
  var input;
  try {
    input = JSON.parse(Buffer.concat(chunks).toString());
  } catch (e) {
    process.stdout.write("[]");
    return;
  }

  var code = input.code;
  var state = input.state;
  var _Function = Function;
  var _stdout = process.stdout;
  var _JSON = JSON;

  // Nuke all dangerous globals and require paths
  delete global.require;
  delete global.module;
  delete global.exports;
  delete global.__filename;
  delete global.__dirname;

  // Nuke process properties that give access to require or system
  if (process.mainModule) delete process.mainModule;
  process.env = Object.create(null);
  process.chdir = undefined;
  process.kill = undefined;
  process.dlopen = undefined;
  process.binding = undefined;
  process._linkedBinding = undefined;
  process.moduleLoadList = undefined;

  // Nuke globalThis paths to constructors that could re-import modules
  try { delete global.Buffer; } catch(e) {}
  try { delete global.URL; } catch(e) {}
  try { delete global.URLSearchParams; } catch(e) {}
  try { delete global.TextDecoder; } catch(e) {}
  try { delete global.TextEncoder; } catch(e) {}

  try {
    var fn = new _Function("state", code + "\n;if (typeof decideBids === 'function') { return decideBids(state); } return [];");
    var bids = fn(state);
    if (!Array.isArray(bids)) bids = [];
    _stdout.write(_JSON.stringify(bids));
  } catch (e) {
    _stdout.write("[]");
  }
});
