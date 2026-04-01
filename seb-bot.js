// seb's Crown bidding bot
var http = require("http");
var fs = require("fs");
var path = require("path");

var TOKEN_FILE = path.join(__dirname, ".seb-token");
var TOKEN = process.env.SEB_TOKEN || loadToken();
var BASE = "http://localhost:20005";
var GRID_SIZE = 11;
var CROWN_X = 5;
var CROWN_Y = 5;
var MY_INDEX = -1;

function loadToken() {
  try { return fs.readFileSync(TOKEN_FILE, "utf8").trim(); } catch(e) { return null; }
}

function saveToken(token) {
  fs.writeFileSync(TOKEN_FILE, token);
}

function api(method, apiPath, body) {
  return new Promise(function(resolve, reject) {
    var url = new URL(BASE + apiPath);
    var opts = { hostname: url.hostname, port: url.port, path: url.pathname, method: method, headers: { "Content-Type": "application/json" } };
    var req = http.request(opts, function(res) {
      var data = "";
      res.on("data", function(c) { data += c; });
      res.on("end", function() {
        try { resolve(JSON.parse(data)); } catch(e) { resolve(data); }
      });
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function distance(x1, y1, x2, y2) {
  return Math.abs(x1 - x2) + Math.abs(y1 - y2);
}

function isAdjacent(grid, x, y, playerIndex) {
  var dirs = [[0,1],[0,-1],[1,0],[-1,0]];
  for (var i = 0; i < dirs.length; i++) {
    var nx = x + dirs[i][0], ny = y + dirs[i][1];
    if (nx >= 0 && nx < GRID_SIZE && ny >= 0 && ny < GRID_SIZE)
      if (grid[ny][nx] === playerIndex) return true;
  }
  return false;
}

async function joinGame() {
  var r = await api("POST", "/api/join", { name: "seb" });
  if (r.token) {
    TOKEN = r.token;
    MY_INDEX = r.player_id;
    saveToken(TOKEN);
    console.log("Joined as player " + MY_INDEX + ", token saved");
    return true;
  } else {
    console.log("Join failed:", JSON.stringify(r));
    return false;
  }
}

async function playTurn() {
  if (!TOKEN) {
    console.log("No token, trying to join...");
    await joinGame();
    if (!TOKEN) return false;
  }

  var state = await api("GET", "/api/state");
  if (state.status !== "in_progress") return false;

  MY_INDEX = -1;
  for (var i = 0; i < state.players.length; i++) {
    if (state.players[i].name === "seb") { MY_INDEX = i; break; }
  }
  if (MY_INDEX === -1) { console.log("Not in game"); return false; }

  var me = state.players[MY_INDEX];
  var ap = me.ap;
  var grid = state.grid;
  var turn = state.turn;

  console.log("Turn " + turn + " | AP: " + ap + " | Tiles: " + me.tiles);

  var candidates = [];
  for (var y = 0; y < GRID_SIZE; y++) {
    for (var x = 0; x < GRID_SIZE; x++) {
      if (grid[y][x] === MY_INDEX) continue;
      var adj = isAdjacent(grid, x, y, MY_INDEX);
      if (!adj) continue;

      var distToCrown = distance(x, y, CROWN_X, CROWN_Y);
      var isEnemy = grid[y][x] !== null;
      var isCrown = (x === CROWN_X && y === CROWN_Y);

      var score = 100 - distToCrown * 5;
      if (isCrown) score += 200;
      if (!isEnemy) score += 10;
      if (isEnemy) score -= 5;
      if (isCrown && state.crown_holder === MY_INDEX) score += 300;

      candidates.push({ x: x, y: y, score: score, adj: adj, isEnemy: isEnemy, isCrown: isCrown, distToCrown: distToCrown });
    }
  }

  candidates.sort(function(a, b) { return b.score - a.score; });

  var bids = [];
  var totalCost = 0;
  var maxBids = 3;

  for (var c = 0; c < candidates.length && bids.length < maxBids; c++) {
    var cand = candidates[c];
    var amount;
    if (cand.isCrown) {
      amount = Math.min(Math.max(3, Math.ceil(ap * 0.4)), ap);
    } else if (cand.distToCrown <= 2) {
      amount = Math.min(2, ap);
    } else {
      amount = 1;
    }

    var effectiveCost = cand.adj ? Math.ceil(amount / 2) : amount;
    if (totalCost + effectiveCost > ap) {
      amount = 1;
      effectiveCost = cand.adj ? 1 : 1;
      if (totalCost + effectiveCost > ap) continue;
    }

    bids.push({ x: cand.x, y: cand.y, amount: amount });
    totalCost += effectiveCost;
  }

  if (bids.length === 0) {
    console.log("No valid bids, passing");
    await api("POST", "/api/bid", { token: TOKEN, bids: [] });
    return true;
  }

  console.log("Bidding:", JSON.stringify(bids));
  var result = await api("POST", "/api/bid", { token: TOKEN, bids: bids });
  if (result.error === "Invalid token") {
    console.log("Token invalid, clearing...");
    TOKEN = null;
    try { fs.unlinkSync(TOKEN_FILE); } catch(e) {}
  }
  console.log("Result:", JSON.stringify(result));
  return true;
}

// WebSocket-driven game loop
var WebSocket = require("ws");

async function startup() {
  var state = await api("GET", "/api/state");
  var inGame = false;
  if (state && state.players) {
    for (var i = 0; i < state.players.length; i++) {
      if (state.players[i].name === "seb") { inGame = true; break; }
    }
  }
  if (!inGame && state && state.status === "waiting") {
    await joinGame();
  }
}

function connectWS() {
  var ws = new WebSocket("ws://localhost:20005/ws");

  ws.on("open", function() {
    console.log("Connected to Crown WS");
  });

  ws.on("message", function(data) {
    var msg = JSON.parse(data);

    if (msg.type === "game_started") {
      console.log("Game started!");
      setTimeout(playTurn, 1000);
    } else if (msg.type === "turn_resolved") {
      console.log("Turn resolved, new turn: " + msg.turn);
      setTimeout(playTurn, 2000);
    } else if (msg.type === "game_over") {
      console.log("Game over! Winner: " + msg.winner_name + " by " + msg.reason);
    } else if (msg.type === "new_game") {
      console.log("New game started, rejoining...");
      setTimeout(async function() { await joinGame(); }, 2000);
    } else if (msg.type === "state") {
      if (msg.state && msg.state.status === "in_progress" && TOKEN) {
        setTimeout(playTurn, 1000);
      }
    }
  });

  ws.on("close", function() {
    console.log("WS disconnected, reconnecting in 5s...");
    setTimeout(connectWS, 5000);
  });

  ws.on("error", function(err) {
    console.log("WS error:", err.message);
  });
}

startup().then(function() {
  connectWS();
  console.log("seb Crown bot started. Token:", TOKEN ? TOKEN.substring(0, 8) + "..." : "NOT SET (will auto-join)");
});

// Keep process alive
setInterval(function() {}, 30000);
