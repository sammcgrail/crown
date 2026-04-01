var express = require("express");
var http = require("http");
var WebSocket = require("ws");
var crypto = require("crypto");
var fs = require("fs");
var path = require("path");

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
var LEADERBOARD_FILE = path.join(__dirname, "leaderboard.json");
var HISTORY_FILE = path.join(__dirname, "game-history.json");
var MAX_HISTORY = 50;

var PLAYER_COLORS = ["#e07070", "#70a0e0", "#70c070", "#d0a040"];
var CORNER_STARTS = [
  [{x:0,y:0},{x:1,y:0},{x:0,y:1},{x:1,y:1}],
  [{x:9,y:0},{x:10,y:0},{x:9,y:1},{x:10,y:1}],
  [{x:0,y:9},{x:1,y:9},{x:0,y:10},{x:1,y:10}],
  [{x:9,y:9},{x:10,y:9},{x:9,y:10},{x:10,y:10}]
];

// Single persistent game
var game = null;

app.use(express.json());
app.use(express.static(__dirname));

function uuid() { return crypto.randomUUID(); }

function loadLeaderboard() {
  try { return JSON.parse(fs.readFileSync(LEADERBOARD_FILE, "utf8")); }
  catch (e) { return []; }
}

function saveLeaderboard(lb) {
  fs.writeFileSync(LEADERBOARD_FILE, JSON.stringify(lb, null, 2));
}

function loadHistory() {
  try { return JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8")); }
  catch (e) { return []; }
}

function saveHistory(history) {
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history));
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

  var history = loadHistory();
  history.unshift(entry);
  if (history.length > MAX_HISTORY) history = history.slice(0, MAX_HISTORY);
  saveHistory(history);
  return entry.id;
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
    turnTimer: null
  };
  broadcast({ type: "new_game" });
  return game;
}

function getPublicState() {
  if (!game) return null;
  var players = game.players.map(function(p, i) {
    return {
      index: i, name: p.name, color: PLAYER_COLORS[i],
      tiles: countTiles(game.grid, i), ap: p.ap, connected: true
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

  var finalScores = game.players.map(function(p, i) { return { name: p.name, tiles: countTiles(game.grid, i) }; });
  broadcast({
    type: "game_over", winner: game.winner,
    winner_name: game.players[game.winner].name,
    reason: game.winReason, final_scores: finalScores
  });

  var lb = loadLeaderboard();
  var winnerName = game.players[game.winner].name;
  var found = false;
  for (var i = 0; i < lb.length; i++) {
    if (lb[i].name === winnerName) { lb[i].wins++; lb[i].last_win = new Date().toISOString(); found = true; break; }
  }
  if (!found) lb.push({ name: winnerName, wins: 1, last_win: new Date().toISOString() });
  lb.sort(function(a, b) { return b.wins - a.wins; });
  saveLeaderboard(lb);

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
  game.players.push({ name: playerName, token: token, ap: STARTING_AP, currentBids: null, hasBid: false });

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
  var history = loadHistory();
  var game_entry = null;
  for (var i = 0; i < history.length; i++) {
    if (history[i].id === req.params.id) { game_entry = history[i]; break; }
  }
  if (!game_entry) return res.status(404).json({ error: "Game not found" });
  res.json(game_entry);
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
