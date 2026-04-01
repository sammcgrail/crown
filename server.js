var express = require("express");
var http = require("http");
var WebSocket = require("ws");
var crypto = require("crypto");
var fs = require("fs");
var path = require("path");
var child_process = require("child_process");
var Database = require("better-sqlite3");

var app = express();
var server = http.createServer(app);
var wss = new WebSocket.Server({ noServer: true });

var PORT = 20005;
var GRID_SIZE = 11;
var MAX_PLAYERS = 4;
var MAX_TURNS = 30;
var CROWN_X = 5;
var CROWN_Y = 5;
var CROWN_WIN_STREAK = 3;
var BID_TIMEOUT_MS = 10000;
var MAX_BIDS_PER_TURN = 3;
var STARTING_AP = 10;
var DB_PATH = process.env.CROWN_DB || path.join(__dirname, "data", "crown.db");
var MAX_HISTORY = 50;
var BOTS_DIR = path.join(__dirname, "data", "bots");
var BOTS_VERSIONS_DIR = path.join(__dirname, "data", "bots_versions");
var AUTOBOT_DELAY_MS = 2000; // delay before running autobots each turn

var PLAYER_COLORS = ["#e07070", "#70a0e0", "#70c070", "#d0a040"];
var CORNER_STARTS = [
  [{x:0,y:0},{x:1,y:0},{x:0,y:1},{x:1,y:1}],
  [{x:9,y:0},{x:10,y:0},{x:9,y:1},{x:10,y:1}],
  [{x:0,y:9},{x:1,y:9},{x:0,y:10},{x:1,y:10}],
  [{x:9,y:9},{x:10,y:9},{x:9,y:10},{x:10,y:10}]
];

// Single persistent game
var game = null;

app.use(express.json({ limit: "100kb" }));
app.use(express.static(__dirname));

function uuid() { return crypto.randomUUID(); }

function loadLeaderboard() {
  try {
    return db.prepare("SELECT name, wins, last_win FROM leaderboard ORDER BY wins DESC").all();
  } catch (e) { return []; }
}

function updateLeaderboard(winnerName) {
  db.prepare(
    "INSERT INTO leaderboard (name, wins, last_win) VALUES (?, 1, ?) ON CONFLICT(name) DO UPDATE SET wins = wins + 1, last_win = ?"
  ).run(winnerName, new Date().toISOString(), new Date().toISOString());
}

// SQLite database for persistent history
var db;
function initDB() {
  var dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.exec(`CREATE TABLE IF NOT EXISTS games (
    id TEXT PRIMARY KEY,
    date TEXT NOT NULL,
    data TEXT NOT NULL
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS leaderboard (
    name TEXT PRIMARY KEY,
    wins INTEGER NOT NULL DEFAULT 0,
    last_win TEXT
  )`);
}
initDB();

// One-time migration from leaderboard.json to SQLite
(function migrateLeaderboard() {
  var jsonPath = path.join(__dirname, "leaderboard.json");
  try {
    if (!fs.existsSync(jsonPath)) return;
    var existing = db.prepare("SELECT COUNT(*) as c FROM leaderboard").get();
    if (existing.c > 0) return; // already migrated
    var data = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
    var insert = db.prepare("INSERT OR IGNORE INTO leaderboard (name, wins, last_win) VALUES (?, ?, ?)");
    for (var i = 0; i < data.length; i++) {
      insert.run(data[i].name, data[i].wins, data[i].last_win || null);
    }
    fs.renameSync(jsonPath, jsonPath + ".migrated");
    console.log("Migrated " + data.length + " leaderboard entries from JSON to SQLite");
  } catch (e) { console.error("Leaderboard migration error:", e.message); }
})();

function loadHistory() {
  try {
    var rows = db.prepare("SELECT data FROM games ORDER BY date DESC LIMIT ?").all(MAX_HISTORY);
    return rows.map(function(r) { return JSON.parse(r.data); });
  } catch (e) { console.error("Failed to load history:", e.message); return []; }
}

function saveHistory(history) {
  // no-op — individual saves handled by saveGameToHistory
}

function saveGameToHistory() {
  if (!game || game.winner === null) return;

  var entry = {
    id: uuid(),
    date: new Date().toISOString(),
    players: game.players.map(function(p, i) {
      return { name: p.name, color: PLAYER_COLORS[i], tiles: countTiles(game.grid, i) };
    }),
    winner: game.winner,
    winner_name: game.players[game.winner].name,
    reason: game.winReason,
    turns: game.history.map(function(h) {
      return {
        turn: h.turn,
        grid: h.grid,
        bids: h.bids,
        scores: game.players.map(function(p, i) {
          var tiles = 0;
          for (var y = 0; y < GRID_SIZE; y++)
            for (var x = 0; x < GRID_SIZE; x++)
              if (h.grid[y][x] === i) tiles++;
          return { name: p.name, tiles: tiles, ap: h.ap_snapshot ? h.ap_snapshot[i] : 0 };
        }),
        crown_holder: null,
        crown_streak: 0
      };
    })
  };

  // Reconstruct crown state per turn
  var crownHolder = null, crownStreak = 0;
  for (var t = 0; t < entry.turns.length; t++) {
    var turn = entry.turns[t];
    var crownOwner = turn.grid[CROWN_Y][CROWN_X];
    if (crownOwner !== null && crownOwner === crownHolder) crownStreak++;
    else if (crownOwner !== null) { crownHolder = crownOwner; crownStreak = 1; }
    else { crownHolder = null; crownStreak = 0; }
    turn.crown_holder = crownHolder;
    turn.crown_streak = crownStreak;
  }

  try {
    db.prepare("INSERT INTO games (id, date, data) VALUES (?, ?, ?)").run(entry.id, entry.date, JSON.stringify(entry));
    // Prune old entries beyond MAX_HISTORY
    db.prepare("DELETE FROM games WHERE id NOT IN (SELECT id FROM games ORDER BY date DESC LIMIT ?)").run(MAX_HISTORY);
  } catch (e) { console.error("Failed to save game history:", e.message); }
  return entry.id;
}

// --- Autobot file management ---

if (!fs.existsSync(BOTS_DIR)) fs.mkdirSync(BOTS_DIR, { recursive: true });
if (!fs.existsSync(BOTS_VERSIONS_DIR)) fs.mkdirSync(BOTS_VERSIONS_DIR, { recursive: true });

function listBots() {
  try {
    var files = fs.readdirSync(BOTS_DIR).filter(function(f) { return f.endsWith(".js"); });
    return files.map(function(f) {
      var name = f.replace(/\.js$/, "");
      var code = fs.readFileSync(path.join(BOTS_DIR, f), "utf8");
      var stat = fs.statSync(path.join(BOTS_DIR, f));
      var versions = listBotVersions(name);
      return { name: name, code: code, updated: stat.mtime.toISOString(), size: code.length, versions: versions.length };
    });
  } catch (e) { return []; }
}

function getBot(name) {
  var filePath = path.join(BOTS_DIR, name + ".js");
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (e) { return null; }
}

function listBotVersions(name) {
  var botDir = path.join(BOTS_VERSIONS_DIR, name);
  if (!fs.existsSync(botDir)) return [];
  try {
    var files = fs.readdirSync(botDir).filter(function(f) { return f.endsWith(".js"); });
    return files.map(function(f) {
      var ver = f.replace(/\.js$/, "");
      var stat = fs.statSync(path.join(botDir, f));
      var code = fs.readFileSync(path.join(botDir, f), "utf8");
      return { version: ver, date: stat.mtime.toISOString(), size: code.length };
    }).sort(function(a, b) { return b.version.localeCompare(a.version); });
  } catch (e) { return []; }
}

function getBotVersion(name, version) {
  var filePath = path.join(BOTS_VERSIONS_DIR, name, version + ".js");
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (e) { return null; }
}

function saveBot(name, code) {
  // Archive current version before overwriting
  var currentCode = getBot(name);
  if (currentCode) {
    var botDir = path.join(BOTS_VERSIONS_DIR, name);
    if (!fs.existsSync(botDir)) fs.mkdirSync(botDir, { recursive: true });
    var ts = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
    fs.writeFileSync(path.join(botDir, ts + ".js"), currentCode);
  }
  var filePath = path.join(BOTS_DIR, name + ".js");
  fs.writeFileSync(filePath, code);
}

function deleteBot(name) {
  var filePath = path.join(BOTS_DIR, name + ".js");
  try { fs.unlinkSync(filePath); return true; } catch (e) { return false; }
}

// Fast in-process execution for autobattle (code is pre-validated on upload)
function runAutobotFast(code, gameState) {
  try {
    var fn = new Function("state", code + "\n;if (typeof decideBids === 'function') { return decideBids(state); } return [];");
    var bids = fn(JSON.parse(JSON.stringify(gameState))); // deep copy to isolate
    return validateBids(bids);
  } catch (e) {
    return [];
  }
}

// Subprocess sandbox for live game turns (untrusted execution boundary)
function runAutobotSandboxed(code, gameState) {
  try {
    var input = JSON.stringify({ code: code, state: gameState });
    var result = child_process.execFileSync(
      process.execPath,
      ["--max-old-space-size=32", "--no-warnings", path.join(__dirname, "bot-runner.js")],
      {
        input: input,
        timeout: 3000,
        maxBuffer: 1024 * 64,
        stdio: ["pipe", "pipe", "pipe"],
        env: {}
      }
    );
    var bids = [];
    try { bids = JSON.parse(result.toString()); } catch (e) {}
    return validateBids(bids);
  } catch (e) {
    console.error("Autobot sandbox error:", e.message);
    return [];
  }
}

function validateBids(bids) {
  if (!Array.isArray(bids)) return [];
  var validated = [];
  for (var i = 0; i < Math.min(bids.length, MAX_BIDS_PER_TURN); i++) {
    var b = bids[i];
    if (b && typeof b.x === "number" && typeof b.y === "number" && typeof b.amount === "number" &&
        b.x >= 0 && b.x < GRID_SIZE && b.y >= 0 && b.y < GRID_SIZE &&
        b.amount > 0 && Number.isInteger(b.amount)) {
      validated.push({ x: b.x, y: b.y, amount: b.amount });
    }
  }
  return validated;
}

// Main entry point — uses subprocess for live games, in-process for autobattle
function runAutobot(name, gameState, overrideCode, fast) {
  var code = overrideCode || getBot(name);
  if (!code) return null;
  if (fast) return runAutobotFast(code, gameState);
  return runAutobotSandboxed(code, gameState);
}

function getAutobotState(playerIndex) {
  if (!game) return null;
  var players = game.players.map(function(p, i) {
    return {
      index: i, name: p.name, color: PLAYER_COLORS[i],
      tiles: countTiles(game.grid, i), ap: p.ap
    };
  });
  return {
    grid: game.grid,
    grid_size: GRID_SIZE,
    players: players,
    my_index: playerIndex,
    crown: { x: CROWN_X, y: CROWN_Y },
    crown_holder: game.crownHolder,
    crown_streak: game.crownStreak,
    turn: game.turn,
    max_turns: MAX_TURNS,
    previous_bids: game.previousBids || []
  };
}

function runAutobotTurn() {
  if (!game || game.status !== "in_progress") return;

  for (var pi = 0; pi < game.players.length; pi++) {
    var player = game.players[pi];
    if (player.hasBid) continue;
    if (!player.isAutobot) continue;

    var botState = getAutobotState(pi);
    var bids = runAutobot(player.name, botState);
    if (!bids || bids.length === 0) {
      // Autobot passes — submit empty bids
      player.currentBids = [];
      player.hasBid = true;
      broadcast({ type: "player_bid_locked", player_index: pi, player_name: player.name });
      continue;
    }

    // Process bids like the /api/bid endpoint
    var totalCost = 0;
    var processedBids = [];
    var valid = true;
    for (var b = 0; b < bids.length; b++) {
      var bid = bids[b];
      var adjacent = isAdjacent(game.grid, bid.x, bid.y, pi);
      var effectiveCost = adjacent ? Math.ceil(bid.amount / 2) : bid.amount;
      totalCost += effectiveCost;
      processedBids.push({ x: bid.x, y: bid.y, amount: bid.amount, effectiveCost: effectiveCost, adjacent: adjacent });
    }

    if (totalCost > player.ap) {
      // Too expensive — trim bids until they fit
      processedBids = [];
      totalCost = 0;
      for (var b2 = 0; b2 < bids.length; b2++) {
        var bid2 = bids[b2];
        var adj2 = isAdjacent(game.grid, bid2.x, bid2.y, pi);
        var eff2 = adj2 ? Math.ceil(bid2.amount / 2) : bid2.amount;
        if (totalCost + eff2 <= player.ap) {
          processedBids.push({ x: bid2.x, y: bid2.y, amount: bid2.amount, effectiveCost: eff2, adjacent: adj2 });
          totalCost += eff2;
        }
      }
    }

    player.currentBids = processedBids;
    player.hasBid = true;
    broadcast({ type: "player_bid_locked", player_index: pi, player_name: player.name });
  }

  // Check if all players have bid after autobot runs
  var allBid = true;
  for (var pi2 = 0; pi2 < game.players.length; pi2++) {
    if (!game.players[pi2].hasBid) { allBid = false; break; }
  }
  if (allBid) resolveTurn();
}

function autoJoinBots() {
  if (!game || game.status !== "waiting") return;
  var bots = listBots();
  for (var i = 0; i < bots.length; i++) {
    if (game.players.length >= MAX_PLAYERS) break;
    var botName = bots[i].name;
    // Check not already in game
    var already = false;
    for (var j = 0; j < game.players.length; j++) {
      if (game.players[j].name === botName) { already = true; break; }
    }
    if (already) continue;

    var token = uuid();
    var playerIndex = game.players.length;
    game.players.push({ name: botName, token: token, ap: STARTING_AP, currentBids: null, hasBid: false, isAutobot: true });
    var starts = CORNER_STARTS[playerIndex];
    for (var s = 0; s < starts.length; s++) game.grid[starts[s].y][starts[s].x] = playerIndex;
    broadcast({ type: "player_joined", player_index: playerIndex, player_name: botName, player_count: game.players.length });
  }

  if (game.players.length === MAX_PLAYERS && game.status === "waiting") {
    game.status = "in_progress";
    broadcast({ type: "game_started", state: getPublicState() });
    startTurnTimer();
  }
}

function createGrid() {
  var grid = [];
  for (var y = 0; y < GRID_SIZE; y++) {
    var row = [];
    for (var x = 0; x < GRID_SIZE; x++) row.push(null);
    grid.push(row);
  }
  return grid;
}

function countTiles(grid, playerIndex) {
  var count = 0;
  for (var y = 0; y < GRID_SIZE; y++)
    for (var x = 0; x < GRID_SIZE; x++)
      if (grid[y][x] === playerIndex) count++;
  return count;
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

function newGame() {
  if (game && game.turnTimer) clearTimeout(game.turnTimer);
  if (game && game.autobotTimer) clearTimeout(game.autobotTimer);
  game = {
    status: "waiting",
    turn: 1,
    grid: createGrid(),
    players: [],
    crownHolder: null,
    crownStreak: 0,
    previousBids: [],
    history: [],
    winner: null,
    winReason: null,
    turnTimer: null,
    autobotTimer: null
  };
  broadcast({ type: "new_game" });
  // Auto-join registered autobots after a short delay
  setTimeout(function() { autoJoinBots(); }, 1000);
  return game;
}

function getPublicState() {
  if (!game) return null;
  var players = game.players.map(function(p, i) {
    return {
      index: i, name: p.name, color: PLAYER_COLORS[i],
      tiles: countTiles(game.grid, i), ap: p.ap, connected: true,
      is_autobot: !!p.isAutobot
    };
  });
  return {
    status: game.status, turn: game.turn, max_turns: MAX_TURNS,
    grid: game.grid, grid_size: GRID_SIZE,
    crown: { x: CROWN_X, y: CROWN_Y },
    crown_holder: game.crownHolder, crown_streak: game.crownStreak,
    players: players, previous_bids: game.previousBids,
    winner: game.winner, win_reason: game.winReason
  };
}

function broadcast(message) {
  var msg = JSON.stringify(message);
  wss.clients.forEach(function(client) {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  });
}

function startTurnTimer() {
  if (game.turnTimer) clearTimeout(game.turnTimer);
  game.turnTimer = setTimeout(function() { resolveTurn(); }, BID_TIMEOUT_MS);
  // Schedule autobot execution after a short delay
  if (game.autobotTimer) clearTimeout(game.autobotTimer);
  game.autobotTimer = setTimeout(function() { runAutobotTurn(); }, AUTOBOT_DELAY_MS);
}

function resolveTurn() {
  if (!game || game.status !== "in_progress") return;
  if (game.turnTimer) { clearTimeout(game.turnTimer); game.turnTimer = null; }

  var turnBids = {};
  for (var pi = 0; pi < game.players.length; pi++) {
    var playerBids = game.players[pi].currentBids || [];
    for (var bi = 0; bi < playerBids.length; bi++) {
      var bid = playerBids[bi];
      var key = bid.x + "," + bid.y;
      if (!turnBids[key]) turnBids[key] = [];
      turnBids[key].push({ playerIndex: pi, amount: bid.amount, effectiveCost: bid.effectiveCost });
    }
  }

  var results = [];
  var apSpent = new Array(game.players.length).fill(0);
  var keys = Object.keys(turnBids);

  for (var ki = 0; ki < keys.length; ki++) {
    var parts = keys[ki].split(",");
    var tx = parseInt(parts[0]), ty = parseInt(parts[1]);
    if (isNaN(tx) || isNaN(ty) || !game.grid[ty]) continue;
    var bids = turnBids[keys[ki]];
    bids.sort(function(a, b) { return b.amount - a.amount; });

    var result = { x: tx, y: ty, bids: bids, winner: null, tied: false };
    if (bids.length === 1) result.winner = bids[0].playerIndex;
    else if (bids[0].amount > bids[1].amount) result.winner = bids[0].playerIndex;
    else result.tied = true;

    for (var b = 0; b < bids.length; b++)
      apSpent[bids[b].playerIndex] += bids[b].effectiveCost;

    if (result.winner !== null) game.grid[ty][tx] = result.winner;
    results.push(result);
  }

  for (var p = 0; p < game.players.length; p++) {
    game.players[p].ap -= apSpent[p];
    if (game.players[p].ap < 0) game.players[p].ap = 0;
  }

  var revealedBids = [];
  for (var pi2 = 0; pi2 < game.players.length; pi2++) {
    var pb = game.players[pi2].currentBids || [];
    for (var j = 0; j < pb.length; j++) {
      revealedBids.push({
        player: pi2, player_name: game.players[pi2].name,
        x: pb[j].x, y: pb[j].y, amount: pb[j].amount, effectiveCost: pb[j].effectiveCost
      });
    }
  }
  game.previousBids = revealedBids;

  game.history.push({
    turn: game.turn, bids: revealedBids, results: results,
    grid: game.grid.map(function(row) { return row.slice(); }),
    ap_snapshot: game.players.map(function(p) { return p.ap; })
  });

  for (var pi3 = 0; pi3 < game.players.length; pi3++) {
    game.players[pi3].currentBids = null;
    game.players[pi3].hasBid = false;
  }

  var crownOwner = game.grid[CROWN_Y][CROWN_X];
  if (crownOwner !== null && crownOwner === game.crownHolder) game.crownStreak++;
  else if (crownOwner !== null) { game.crownHolder = crownOwner; game.crownStreak = 1; }
  else { game.crownHolder = null; game.crownStreak = 0; }

  if (game.crownStreak >= CROWN_WIN_STREAK && game.crownHolder !== null) {
    game.status = "finished";
    game.winner = game.crownHolder;
    game.winReason = "crown";
    finishGame();
    return;
  }

  if (game.turn >= MAX_TURNS) {
    game.status = "finished";
    var maxTiles = -1, maxPlayer = null;
    for (var pi4 = 0; pi4 < game.players.length; pi4++) {
      var tc = countTiles(game.grid, pi4);
      if (tc > maxTiles) { maxTiles = tc; maxPlayer = pi4; }
    }
    game.winner = maxPlayer;
    game.winReason = "territory";
    finishGame();
    return;
  }

  game.turn++;
  for (var pi5 = 0; pi5 < game.players.length; pi5++) {
    var earned = countTiles(game.grid, pi5);
    game.players[pi5].ap += earned;
  }

  broadcast({
    type: "turn_resolved", turn: game.turn, grid: game.grid,
    scores: game.players.map(function(p, i) { return { name: p.name, tiles: countTiles(game.grid, i), ap: p.ap }; }),
    bids_revealed: revealedBids,
    crown_holder: game.crownHolder, crown_streak: game.crownStreak
  });

  startTurnTimer();
}

function finishGame() {
  if (game.turnTimer) { clearTimeout(game.turnTimer); game.turnTimer = null; }
  if (game.autobotTimer) { clearTimeout(game.autobotTimer); game.autobotTimer = null; }

  var finalScores = game.players.map(function(p, i) { return { name: p.name, tiles: countTiles(game.grid, i) }; });
  broadcast({
    type: "game_over", winner: game.winner,
    winner_name: game.players[game.winner].name,
    reason: game.winReason, final_scores: finalScores
  });

  var winnerName = game.players[game.winner].name;
  updateLeaderboard(winnerName);

  // Save game history for replay
  saveGameToHistory();

  // Auto-start new game after 10 seconds
  setTimeout(function() { newGame(); }, 10000);
}

// --- REST API ---

app.post("/api/join", function(req, res) {
  if (!game || game.status === "finished") newGame();
  if (game.status !== "waiting") return res.status(400).json({ error: "Game in progress. Wait for it to finish." });
  if (game.players.length >= MAX_PLAYERS) return res.status(400).json({ error: "Game is full" });

  var playerName = req.body.name || ("Player " + (game.players.length + 1));
  
  // Check for duplicate names
  for (var i = 0; i < game.players.length; i++) {
    if (game.players[i].name === playerName) {
      return res.status(400).json({ error: "Name already taken" });
    }
  }

  var token = uuid();
  var playerIndex = game.players.length;
  var hasAutobot = getBot(playerName) !== null;
  game.players.push({ name: playerName, token: token, ap: STARTING_AP, currentBids: null, hasBid: false, isAutobot: hasAutobot });

  var starts = CORNER_STARTS[playerIndex];
  for (var i = 0; i < starts.length; i++) game.grid[starts[i].y][starts[i].x] = playerIndex;

  if (game.players.length === MAX_PLAYERS) {
    game.status = "in_progress";
    broadcast({ type: "game_started", state: getPublicState() });
    startTurnTimer();
  }

  broadcast({ type: "player_joined", player_index: playerIndex, player_name: playerName, player_count: game.players.length });
  res.json({ player_id: playerIndex, token: token, color: PLAYER_COLORS[playerIndex], game_status: game.status });
});

app.get("/api/state", function(req, res) {
  if (!game) newGame();
  res.json(getPublicState());
});

app.post("/api/bid", function(req, res) {
  if (!game) return res.status(400).json({ error: "No game" });
  if (game.status !== "in_progress") return res.status(400).json({ error: "Game not in progress" });

  var token = req.body.token;
  var bids = req.body.bids || [];
  var playerIndex = -1;
  for (var i = 0; i < game.players.length; i++) {
    if (game.players[i].token === token) { playerIndex = i; break; }
  }
  if (playerIndex === -1) return res.status(403).json({ error: "Invalid token" });

  var player = game.players[playerIndex];
  if (player.hasBid) return res.status(400).json({ error: "Already bid this turn" });
  if (bids.length > MAX_BIDS_PER_TURN) return res.status(400).json({ error: "Maximum " + MAX_BIDS_PER_TURN + " bids per turn" });

  var totalCost = 0;
  var processedBids = [];
  for (var b = 0; b < bids.length; b++) {
    var bid = bids[b];
    if (bid.x < 0 || bid.x >= GRID_SIZE || bid.y < 0 || bid.y >= GRID_SIZE) return res.status(400).json({ error: "Out of bounds" });
    if (bid.amount <= 0 || !Number.isInteger(bid.amount)) return res.status(400).json({ error: "Amount must be positive integer" });
    var adjacent = isAdjacent(game.grid, bid.x, bid.y, playerIndex);
    var effectiveCost = adjacent ? Math.ceil(bid.amount / 2) : bid.amount;
    totalCost += effectiveCost;
    processedBids.push({ x: bid.x, y: bid.y, amount: bid.amount, effectiveCost: effectiveCost, adjacent: adjacent });
  }

  if (totalCost > player.ap) return res.status(400).json({ error: "Not enough AP. Have: " + player.ap + ", need: " + totalCost });

  player.currentBids = processedBids;
  player.hasBid = true;
  broadcast({ type: "player_bid_locked", player_index: playerIndex, player_name: player.name });

  var allBid = true;
  for (var pi = 0; pi < game.players.length; pi++) { if (!game.players[pi].hasBid) { allBid = false; break; } }
  if (allBid) resolveTurn();

  res.json({ ok: true, effective_cost: totalCost, remaining_ap: player.ap - totalCost });
});

app.get("/api/leaderboard", function(req, res) { res.json(loadLeaderboard()); });

app.get("/api/history", function(req, res) {
  var history = loadHistory();
  // Return summary list without full turn data
  var summary = history.map(function(g) {
    return {
      id: g.id,
      date: g.date,
      players: g.players,
      winner: g.winner,
      winner_name: g.winner_name,
      reason: g.reason,
      turns: g.turns ? g.turns.length : 0
    };
  });
  res.json(summary);
});

app.get("/api/history/:id", function(req, res) {
  var row = db.prepare("SELECT data FROM games WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Game not found" });
  res.json(JSON.parse(row.data));
});

// --- Autobot API ---

app.get("/api/bots", function(req, res) {
  var bots = listBots();
  res.json(bots.map(function(b) { return { name: b.name, updated: b.updated, size: b.size, versions: b.versions }; }));
});

app.get("/api/bot/:name/versions", function(req, res) {
  var versions = listBotVersions(req.params.name);
  res.json({ name: req.params.name, versions: versions });
});

app.get("/api/bot/:name/version/:ver", function(req, res) {
  var code = getBotVersion(req.params.name, req.params.ver);
  if (!code) return res.status(404).json({ error: "Version not found" });
  res.json({ name: req.params.name, version: req.params.ver, code: code });
});

app.post("/api/bot/:name/revert/:ver", function(req, res) {
  var code = getBotVersion(req.params.name, req.params.ver);
  if (!code) return res.status(404).json({ error: "Version not found" });
  saveBot(req.params.name, code);
  res.json({ ok: true, name: req.params.name, reverted_to: req.params.ver });
});

app.get("/api/bot/:name", function(req, res) {
  var code = getBot(req.params.name);
  if (!code) return res.status(404).json({ error: "Bot not found" });
  res.json({ name: req.params.name, code: code });
});

app.post("/api/bot/upload", function(req, res) {
  var name = req.body.name;
  var code = req.body.code;
  if (!name || !code) return res.status(400).json({ error: "name and code are required" });
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) return res.status(400).json({ error: "Invalid bot name (alphanumeric, hyphens, underscores only)" });
  if (code.length > 50000) return res.status(400).json({ error: "Bot code too large (max 50KB)" });

  // Validate the code can at least parse (syntax check via subprocess)
  try {
    child_process.execFileSync(
      process.execPath,
      ["-e", "new Function(" + JSON.stringify(code) + ")"],
      { timeout: 2000, stdio: ["pipe", "pipe", "pipe"], env: {} }
    );
  } catch (e) {
    var stderr = e.stderr ? e.stderr.toString().split("\n")[0] : e.message;
    return res.status(400).json({ error: "Syntax error in bot code: " + stderr });
  }

  saveBot(name, code);

  // If this bot is in the current game, mark it as autobot
  if (game) {
    for (var i = 0; i < game.players.length; i++) {
      if (game.players[i].name === name) {
        game.players[i].isAutobot = true;
      }
    }
  }

  res.json({ ok: true, name: name, size: code.length });
});

app.delete("/api/bot/:name", function(req, res) {
  if (deleteBot(req.params.name)) {
    // Unmark from current game
    if (game) {
      for (var i = 0; i < game.players.length; i++) {
        if (game.players[i].name === req.params.name) {
          game.players[i].isAutobot = false;
        }
      }
    }
    res.json({ ok: true });
  } else {
    res.status(404).json({ error: "Bot not found" });
  }
});

// Autobattle: run a full game using only autobot files, no WebSocket needed
app.post("/api/autobattle", function(req, res) {
  var botNames = req.body.bots; // array of bot names, or omit to use all registered
  var overrides = req.body.overrides || {}; // optional code overrides: { botname: "code..." }
  if (!botNames) {
    botNames = listBots().map(function(b) { return b.name; });
  }
  if (botNames.length < 2) return res.status(400).json({ error: "Need at least 2 bots" });
  if (botNames.length > MAX_PLAYERS) botNames = botNames.slice(0, MAX_PLAYERS);

  // Verify all bots exist
  for (var i = 0; i < botNames.length; i++) {
    if (!overrides[botNames[i]] && !getBot(botNames[i])) return res.status(400).json({ error: "Bot not found: " + botNames[i] });
  }

  // Shuffle bot order for random starting positions
  for (var si = botNames.length - 1; si > 0; si--) {
    var sj = Math.floor(Math.random() * (si + 1));
    var tmp = botNames[si]; botNames[si] = botNames[sj]; botNames[sj] = tmp;
  }

  // Create an isolated game state for the autobattle
  var abGame = {
    status: "in_progress",
    turn: 1,
    grid: createGrid(),
    players: [],
    crownHolder: null,
    crownStreak: 0,
    previousBids: [],
    history: [],
    winner: null,
    winReason: null
  };

  // Add players
  for (var pi = 0; pi < botNames.length; pi++) {
    abGame.players.push({ name: botNames[pi], token: uuid(), ap: STARTING_AP, currentBids: null, hasBid: false, isAutobot: true });
    var starts = CORNER_STARTS[pi];
    for (var s = 0; s < starts.length; s++) abGame.grid[starts[s].y][starts[s].x] = pi;
  }

  // Pad with remaining corner starts if < 4 players (2 or 3 player game)
  // Actually, the game requires 4 players. Pad with copies if needed.
  while (abGame.players.length < MAX_PLAYERS) {
    var padIdx = abGame.players.length % botNames.length;
    var padName = botNames[padIdx] + "_" + abGame.players.length;
    abGame.players.push({ name: padName, token: uuid(), ap: STARTING_AP, currentBids: null, hasBid: false, isAutobot: true });
    var starts2 = CORNER_STARTS[abGame.players.length - 1];
    for (var s2 = 0; s2 < starts2.length; s2++) abGame.grid[starts2[s2].y][starts2[s2].x] = abGame.players.length - 1;
  }

  // Run the game turn by turn
  for (var turn = 1; turn <= MAX_TURNS; turn++) {
    abGame.turn = turn;

    // Get bids from each bot
    for (var bpi = 0; bpi < abGame.players.length; bpi++) {
      var bp = abGame.players[bpi];
      var realName = botNames[bpi % botNames.length]; // for padded players, use original bot
      var bState = {
        grid: abGame.grid,
        grid_size: GRID_SIZE,
        players: abGame.players.map(function(p, i) {
          return { index: i, name: p.name, color: PLAYER_COLORS[i], tiles: countTiles(abGame.grid, i), ap: p.ap };
        }),
        my_index: bpi,
        crown: { x: CROWN_X, y: CROWN_Y },
        crown_holder: abGame.crownHolder,
        crown_streak: abGame.crownStreak,
        turn: turn,
        max_turns: MAX_TURNS,
        previous_bids: abGame.previousBids || []
      };

      var overrideCode = overrides[realName] || null;
      var bids = runAutobot(realName, bState, overrideCode, true);
      if (!bids) bids = [];

      // Process bids
      var totalCost = 0;
      var processedBids = [];
      for (var bi = 0; bi < bids.length; bi++) {
        var bid = bids[bi];
        if (bid.x < 0 || bid.x >= GRID_SIZE || bid.y < 0 || bid.y >= GRID_SIZE) continue;
        var adjacent = isAdjacent(abGame.grid, bid.x, bid.y, bpi);
        var effectiveCost = adjacent ? Math.ceil(bid.amount / 2) : bid.amount;
        if (totalCost + effectiveCost <= bp.ap) {
          processedBids.push({ x: bid.x, y: bid.y, amount: bid.amount, effectiveCost: effectiveCost, adjacent: adjacent });
          totalCost += effectiveCost;
        }
      }

      bp.currentBids = processedBids;
      bp.hasBid = true;
    }

    // Resolve turn (inline logic mirroring resolveTurn)
    var turnBids = {};
    for (var rpi = 0; rpi < abGame.players.length; rpi++) {
      var rPlayerBids = abGame.players[rpi].currentBids || [];
      for (var rbi = 0; rbi < rPlayerBids.length; rbi++) {
        var rb = rPlayerBids[rbi];
        var rkey = rb.x + "," + rb.y;
        if (!turnBids[rkey]) turnBids[rkey] = [];
        turnBids[rkey].push({ playerIndex: rpi, amount: rb.amount, effectiveCost: rb.effectiveCost });
      }
    }

    var apSpent = new Array(abGame.players.length).fill(0);
    var keys = Object.keys(turnBids);
    for (var ki = 0; ki < keys.length; ki++) {
      var parts = keys[ki].split(",");
      var tx = parseInt(parts[0]), ty = parseInt(parts[1]);
      if (isNaN(tx) || isNaN(ty) || !abGame.grid[ty]) continue;
      var cellBids = turnBids[keys[ki]];
      cellBids.sort(function(a, b) { return b.amount - a.amount; });

      var winner = null;
      if (cellBids.length === 1) winner = cellBids[0].playerIndex;
      else if (cellBids[0].amount > cellBids[1].amount) winner = cellBids[0].playerIndex;

      for (var cb = 0; cb < cellBids.length; cb++)
        apSpent[cellBids[cb].playerIndex] += cellBids[cb].effectiveCost;

      if (winner !== null) abGame.grid[ty][tx] = winner;
    }

    // Deduct AP
    for (var dp = 0; dp < abGame.players.length; dp++) {
      abGame.players[dp].ap -= apSpent[dp];
      if (abGame.players[dp].ap < 0) abGame.players[dp].ap = 0;
    }

    // Build revealed bids
    var revealedBids = [];
    for (var rbp = 0; rbp < abGame.players.length; rbp++) {
      var rpb = abGame.players[rbp].currentBids || [];
      for (var rbj = 0; rbj < rpb.length; rbj++) {
        revealedBids.push({
          player: rbp, player_name: abGame.players[rbp].name,
          x: rpb[rbj].x, y: rpb[rbj].y, amount: rpb[rbj].amount, effectiveCost: rpb[rbj].effectiveCost
        });
      }
    }
    abGame.previousBids = revealedBids;

    abGame.history.push({
      turn: turn, bids: revealedBids,
      grid: abGame.grid.map(function(row) { return row.slice(); }),
      ap_snapshot: abGame.players.map(function(p) { return p.ap; })
    });

    // Reset bids
    for (var rp2 = 0; rp2 < abGame.players.length; rp2++) {
      abGame.players[rp2].currentBids = null;
      abGame.players[rp2].hasBid = false;
    }

    // Crown logic
    var crownOwner = abGame.grid[CROWN_Y][CROWN_X];
    if (crownOwner !== null && crownOwner === abGame.crownHolder) abGame.crownStreak++;
    else if (crownOwner !== null) { abGame.crownHolder = crownOwner; abGame.crownStreak = 1; }
    else { abGame.crownHolder = null; abGame.crownStreak = 0; }

    // Check crown win
    if (abGame.crownStreak >= CROWN_WIN_STREAK && abGame.crownHolder !== null) {
      abGame.winner = abGame.crownHolder;
      abGame.winReason = "crown";
      break;
    }

    // AP income
    if (turn < MAX_TURNS) {
      for (var ip = 0; ip < abGame.players.length; ip++) {
        abGame.players[ip].ap += countTiles(abGame.grid, ip);
      }
    }
  }

  // Territory win if no crown win
  if (abGame.winner === null) {
    var maxTiles = -1, maxPlayer = null;
    for (var fp = 0; fp < abGame.players.length; fp++) {
      var tc = countTiles(abGame.grid, fp);
      if (tc > maxTiles) { maxTiles = tc; maxPlayer = fp; }
    }
    abGame.winner = maxPlayer;
    abGame.winReason = "territory";
  }

  // Save to history
  var entry = {
    id: uuid(),
    date: new Date().toISOString(),
    players: abGame.players.map(function(p, i) {
      return { name: p.name, color: PLAYER_COLORS[i], tiles: countTiles(abGame.grid, i) };
    }),
    winner: abGame.winner,
    winner_name: abGame.players[abGame.winner].name,
    reason: abGame.winReason,
    is_autobattle: true,
    turns: abGame.history.map(function(h) {
      return {
        turn: h.turn, grid: h.grid, bids: h.bids,
        scores: abGame.players.map(function(p, i) {
          var tiles = 0;
          for (var y = 0; y < GRID_SIZE; y++)
            for (var x = 0; x < GRID_SIZE; x++)
              if (h.grid[y][x] === i) tiles++;
          return { name: p.name, tiles: tiles, ap: h.ap_snapshot ? h.ap_snapshot[i] : 0 };
        }),
        crown_holder: null, crown_streak: 0
      };
    })
  };

  // Reconstruct crown state per turn
  var cHolder = null, cStreak = 0;
  for (var ct = 0; ct < entry.turns.length; ct++) {
    var cTurn = entry.turns[ct];
    var cOwner = cTurn.grid[CROWN_Y][CROWN_X];
    if (cOwner !== null && cOwner === cHolder) cStreak++;
    else if (cOwner !== null) { cHolder = cOwner; cStreak = 1; }
    else { cHolder = null; cStreak = 0; }
    cTurn.crown_holder = cHolder;
    cTurn.crown_streak = cStreak;
  }

  try {
    db.prepare("INSERT INTO games (id, date, data) VALUES (?, ?, ?)").run(entry.id, entry.date, JSON.stringify(entry));
    db.prepare("DELETE FROM games WHERE id NOT IN (SELECT id FROM games ORDER BY date DESC LIMIT ?)").run(MAX_HISTORY);
  } catch (e) { console.error("Failed to save autobattle:", e.message); }

  // Update leaderboard
  updateLeaderboard(entry.winner_name);

  // Broadcast to spectators that a new game was recorded
  broadcast({ type: "autobattle_complete", game_id: entry.id, winner: entry.winner_name, reason: entry.reason });

  res.json({
    game_id: entry.id,
    winner: entry.winner_name,
    reason: entry.reason,
    turns: entry.turns.length,
    players: entry.players
  });
});

// Legacy API routes (redirect old game-id routes to new ones)
app.post("/api/game/new", function(req, res) {
  if (!game || game.status === "finished") newGame();
  res.json({ game_id: "default" });
});
app.post("/api/game/:id/join", function(req, res) {
  // Forward to new join endpoint
  req.url = "/api/join";
  app.handle(req, res);
});
app.get("/api/game/:id/state", function(req, res) {
  req.url = "/api/state";
  app.handle(req, res);
});
app.post("/api/game/:id/bid", function(req, res) {
  req.url = "/api/bid";
  app.handle(req, res);
});

// --- WebSocket ---

server.on("upgrade", function(request, socket, head) {
  wss.handleUpgrade(request, socket, head, function(ws) {
    wss.emit("connection", ws, request);
  });
});

wss.on("connection", function(ws) {
  if (!game) newGame();
  ws.send(JSON.stringify({ type: "state", state: getPublicState() }));
});

// Init
newGame();

server.listen(PORT, function() {
  console.log("Crown server running on port " + PORT);
});
