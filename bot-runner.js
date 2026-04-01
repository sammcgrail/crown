// Sandboxed bot runner — executed as a subprocess
// Two modes:
//   Single: { code, state }           → returns bids JSON
//   Batch:  { batch: [{code, state}] } → returns array of bids JSON
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

  try { delete global.Buffer; } catch(e) {}
  try { delete global.URL; } catch(e) {}
  try { delete global.URLSearchParams; } catch(e) {}
  try { delete global.TextDecoder; } catch(e) {}
  try { delete global.TextEncoder; } catch(e) {}

  // Cache compiled bot functions to avoid recompiling every turn
  var fnCache = {};
  function getBotFn(code) {
    if (fnCache[code]) return fnCache[code];
    var fn = new _Function("state", code + "\n;if (typeof decideBids === 'function') { return decideBids(state); } return [];");
    fnCache[code] = fn;
    return fn;
  }

  function runOne(code, state) {
    try {
      var fn = getBotFn(code);
      var bids = fn(state);
      if (!Array.isArray(bids)) return [];
      return bids;
    } catch (e) {
      return [];
    }
  }

  if (input.batch) {
    // Batch mode — run many calls, return array of results
    var results = [];
    for (var i = 0; i < input.batch.length; i++) {
      var item = input.batch[i];
      results.push(runOne(item.code, item.state));
    }
    _stdout.write(_JSON.stringify(results));
  } else {
    // Single mode
    var bids = runOne(input.code, input.state);
    _stdout.write(_JSON.stringify(bids));
  }
});
