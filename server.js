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
var BID_TIMEOUT_MS = 30000;
var MAX_BIDS_PER_TURN = 3;
var STARTING_AP = 10;
var LEADERBOARD_FILE = path.join(__dirname, "leaderboard.json");

var PLAYER_COLORS = ["#e07070", "#70a0e0", "#70c070", "#d0a040"];
var CORNER_STARTS = [
  [{x:0,y:0},{x:1,y:0},{x:0,y:1},{x:1,y:1}],
  [{x:9,y:0},{x:10,y:0},{x:9,y:1},{x:10,y:1}],
  [{x:0,y:9},{x:1,y:9},{x:0,y:10},{x:1,y:10}],
  [{x:9,y:9},{x:10,y:9},{x:9,y:10},{x:10,y:10}]
];

var games = {};

app.use(express.json());
app.use(express.static(__dirname));

// --- Helpers ---

function uuid() {
  return crypto.randomUUID();
}

function loadLeaderboard() {
  try {
    return JSON.parse(fs.readFileSync(LEADERBOARD_FILE, "utf8"));
  } catch (e) {
    return [];
  }
}

function saveLeaderboard(lb) {
  fs.writeFileSync(LEADERBOARD_FILE, JSON.stringify(lb, null, 2));
}

function createGrid() {
  var grid = [];
  for (var y = 0; y < GRID_SIZE; y++) {
    var row = [];
    for (var x = 0; x < GRID_SIZE; x++) {
      row.push(null);
    }
    grid.push(row);
  }
  return grid;
}

function countTiles(grid, playerIndex) {
  var count = 0;
  for (var y = 0; y < GRID_SIZE; y++) {
    for (var x = 0; x < GRID_SIZE; x++) {
      if (grid[y][x] === playerIndex) count++;
    }
  }
  return count;
}

function isAdjacent(grid, x, y, playerIndex) {
  var dirs = [[0,1],[0,-1],[1,0],[-1,0]];
  for (var i = 0; i < dirs.length; i++) {
    var nx = x + dirs[i][0];
    var ny = y + dirs[i][1];
    if (nx >= 0 && nx < GRID_SIZE && ny >= 0 && ny < GRID_SIZE) {
      if (grid[ny][nx] === playerIndex) return true;
    }
  }
  return false;
}

function getPublicState(game) {
  var players = game.players.map(function(p, i) {
    return {
      index: i,
      name: p.name,
      color: PLAYER_COLORS[i],
      tiles: countTiles(game.grid, i),
      ap: p.ap,
      connected: true
    };
  });

  return {
    game_id: game.id,
    status: game.status,
    turn: game.turn,
    max_turns: MAX_TURNS,
    grid: game.grid,
    grid_size: GRID_SIZE,
    crown: { x: CROWN_X, y: CROWN_Y },
    crown_holder: game.crownHolder,
    crown_streak: game.crownStreak,
    players: players,
    previous_bids: game.previousBids,
    winner: game.winner,
    win_reason: game.winReason
  };
}

function broadcastToGame(gameId, message) {
  var msg = JSON.stringify(message);
  wss.clients.forEach(function(client) {
    if (client.readyState === WebSocket.OPEN && client.gameId === gameId) {
      client.send(msg);
    }
  });
}

function startTurnTimer(game) {
  if (game.turnTimer) clearTimeout(game.turnTimer);
  game.turnTimer = setTimeout(function() {
    resolveTurn(game);
  }, BID_TIMEOUT_MS);
}

function resolveTurn(game) {
  if (game.status !== "in_progress") return;
  if (game.turnTimer) {
    clearTimeout(game.turnTimer);
    game.turnTimer = null;
  }

  var turnBids = {};
  // Collect all bids for this turn, keyed by "x,y"
  for (var pi = 0; pi < game.players.length; pi++) {
    var playerBids = game.players[pi].currentBids || [];
    for (var bi = 0; bi < playerBids.length; bi++) {
      var bid = playerBids[bi];
      var key = bid.x + "," + bid.y;
      if (!turnBids[key]) turnBids[key] = [];
      turnBids[key].push({ playerIndex: pi, amount: bid.amount, effectiveCost: bid.effectiveCost });
    }
  }

  // Resolve each tile
  var results = [];
  var apSpent = new Array(game.players.length).fill(0);

  var keys = Object.keys(turnBids);
  for (var ki = 0; ki < keys.length; ki++) {
    var tileKey = keys[ki];
    var parts = tileKey.split(",");
    var tx = parseInt(parts[0]);
    var ty = parseInt(parts[1]);
    var bids = turnBids[tileKey];

    // Sort by amount descending
    bids.sort(function(a, b) { return b.amount - a.amount; });

    var result = { x: tx, y: ty, bids: bids, winner: null, tied: false };

    if (bids.length === 1) {
      result.winner = bids[0].playerIndex;
    } else if (bids[0].amount > bids[1].amount) {
      result.winner = bids[0].playerIndex;
    } else {
      result.tied = true;
    }

    // Deduct AP for all bidders (effective cost)
    for (var b = 0; b < bids.length; b++) {
      apSpent[bids[b].playerIndex] += bids[b].effectiveCost;
    }

    // Update grid if there's a winner
    if (result.winner !== null) {
      game.grid[ty][tx] = result.winner;
    }

    results.push(result);
  }

  // Deduct AP
  for (var p = 0; p < game.players.length; p++) {
    game.players[p].ap -= apSpent[p];
    if (game.players[p].ap < 0) game.players[p].ap = 0;
  }

  // Store revealed bids
  var revealedBids = [];
  for (var pi2 = 0; pi2 < game.players.length; pi2++) {
    var pb = game.players[pi2].currentBids || [];
    for (var j = 0; j < pb.length; j++) {
      revealedBids.push({
        player: pi2,
        player_name: game.players[pi2].name,
        x: pb[j].x,
        y: pb[j].y,
        amount: pb[j].amount,
        effectiveCost: pb[j].effectiveCost
      });
    }
  }
  game.previousBids = revealedBids;

  // Save to history
  game.history.push({
    turn: game.turn,
    bids: revealedBids,
    results: results,
    grid: game.grid.map(function(row) { return row.slice(); })
  });

  // Clear current bids
  for (var pi3 = 0; pi3 < game.players.length; pi3++) {
    game.players[pi3].currentBids = null;
    game.players[pi3].hasBid = false;
  }

  // Check crown
  var crownOwner = game.grid[CROWN_Y][CROWN_X];
  if (crownOwner !== null && crownOwner === game.crownHolder) {
    game.crownStreak++;
  } else if (crownOwner !== null) {
    game.crownHolder = crownOwner;
    game.crownStreak = 1;
  } else {
    game.crownHolder = null;
    game.crownStreak = 0;
  }

  // Check crown victory
  if (game.crownStreak >= CROWN_WIN_STREAK && game.crownHolder !== null) {
    game.status = "finished";
    game.winner = game.crownHolder;
    game.winReason = "crown";
    finishGame(game);
    return;
  }

  // Check turn limit
  if (game.turn >= MAX_TURNS) {
    game.status = "finished";
    var maxTiles = -1;
    var maxPlayer = null;
    for (var pi4 = 0; pi4 < game.players.length; pi4++) {
      var tc = countTiles(game.grid, pi4);
      if (tc > maxTiles) {
        maxTiles = tc;
        maxPlayer = pi4;
      }
    }
    game.winner = maxPlayer;
    game.winReason = "territory";
    finishGame(game);
    return;
  }

  // Advance turn — earn AP = tiles held
  game.turn++;
  for (var pi5 = 0; pi5 < game.players.length; pi5++) {
    var earned = countTiles(game.grid, pi5);
    game.players[pi5].ap += earned;
  }

  // Broadcast turn resolved
  var state = getPublicState(game);
  broadcastToGame(game.id, {
    type: "turn_resolved",
    turn: game.turn,
    grid: game.grid,
    scores: game.players.map(function(p, i) {
      return { name: p.name, tiles: countTiles(game.grid, i), ap: p.ap };
    }),
    bids_revealed: revealedBids,
    crown_holder: game.crownHolder,
    crown_streak: game.crownStreak
  });

  startTurnTimer(game);
}

function finishGame(game) {
  if (game.turnTimer) {
    clearTimeout(game.turnTimer);
    game.turnTimer = null;
  }

  var finalScores = game.players.map(function(p, i) {
    return { name: p.name, tiles: countTiles(game.grid, i) };
  });

  broadcastToGame(game.id, {
    type: "game_over",
    winner: game.winner,
    winner_name: game.players[game.winner].name,
    reason: game.winReason,
    final_scores: finalScores
  });

  // Update leaderboard
  var lb = loadLeaderboard();
  var winnerName = game.players[game.winner].name;
  var found = false;
  for (var i = 0; i < lb.length; i++) {
    if (lb[i].name === winnerName) {
      lb[i].wins++;
      lb[i].last_win = new Date().toISOString();
      found = true;
      break;
    }
  }
  if (!found) {
    lb.push({ name: winnerName, wins: 1, last_win: new Date().toISOString() });
  }
  lb.sort(function(a, b) { return b.wins - a.wins; });
  saveLeaderboard(lb);
}

// --- REST API ---

app.post("/api/game/new", function(req, res) {
  var id = uuid();
  var game = {
    id: id,
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
  games[id] = game;
  res.json({ game_id: id });
});

app.post("/api/game/:id/join", function(req, res) {
  var game = games[req.params.id];
  if (!game) return res.status(404).json({ error: "Game not found" });
  if (game.status !== "waiting") return res.status(400).json({ error: "Game already started" });
  if (game.players.length >= MAX_PLAYERS) return res.status(400).json({ error: "Game is full" });

  var playerName = req.body.name || ("Player " + (game.players.length + 1));
  var token = uuid();
  var playerIndex = game.players.length;

  var player = {
    name: playerName,
    token: token,
    ap: STARTING_AP,
    currentBids: null,
    hasBid: false
  };

  game.players.push(player);

  // Place starting territory
  var starts = CORNER_STARTS[playerIndex];
  for (var i = 0; i < starts.length; i++) {
    game.grid[starts[i].y][starts[i].x] = playerIndex;
  }

  // If 4 players, start the game
  if (game.players.length === MAX_PLAYERS) {
    game.status = "in_progress";
    broadcastToGame(game.id, { type: "game_started", state: getPublicState(game) });
    startTurnTimer(game);
  }

  broadcastToGame(game.id, {
    type: "player_joined",
    player_index: playerIndex,
    player_name: playerName,
    player_count: game.players.length
  });

  res.json({
    player_id: playerIndex,
    token: token,
    color: PLAYER_COLORS[playerIndex],
    game_status: game.status
  });
});

app.get("/api/game/:id/state", function(req, res) {
  var game = games[req.params.id];
  if (!game) return res.status(404).json({ error: "Game not found" });
  res.json(getPublicState(game));
});

app.post("/api/game/:id/bid", function(req, res) {
  var game = games[req.params.id];
  if (!game) return res.status(404).json({ error: "Game not found" });
  if (game.status !== "in_progress") return res.status(400).json({ error: "Game not in progress" });

  var token = req.body.token;
  var bids = req.body.bids || [];

  // Find player by token
  var playerIndex = -1;
  for (var i = 0; i < game.players.length; i++) {
    if (game.players[i].token === token) {
      playerIndex = i;
      break;
    }
  }
  if (playerIndex === -1) return res.status(403).json({ error: "Invalid token" });

  var player = game.players[playerIndex];
  if (player.hasBid) return res.status(400).json({ error: "Already bid this turn" });

  // Validate bid count
  if (bids.length > MAX_BIDS_PER_TURN) {
    return res.status(400).json({ error: "Maximum " + MAX_BIDS_PER_TURN + " bids per turn" });
  }

  // Validate and compute effective costs
  var totalCost = 0;
  var processedBids = [];

  for (var b = 0; b < bids.length; b++) {
    var bid = bids[b];
    var bx = bid.x;
    var by = bid.y;
    var amount = bid.amount;

    if (bx < 0 || bx >= GRID_SIZE || by < 0 || by >= GRID_SIZE) {
      return res.status(400).json({ error: "Bid position out of bounds: " + bx + "," + by });
    }
    if (amount <= 0 || !Number.isInteger(amount)) {
      return res.status(400).json({ error: "Bid amount must be a positive integer" });
    }

    // Calculate effective cost (adjacent discount)
    var adjacent = isAdjacent(game.grid, bx, by, playerIndex);
    var effectiveCost = adjacent ? Math.ceil(amount / 2) : amount;
    totalCost += effectiveCost;

    processedBids.push({ x: bx, y: by, amount: amount, effectiveCost: effectiveCost, adjacent: adjacent });
  }

  if (totalCost > player.ap) {
    return res.status(400).json({ error: "Not enough AP. Have: " + player.ap + ", need: " + totalCost });
  }

  player.currentBids = processedBids;
  player.hasBid = true;

  // Notify others that this player has locked in
  broadcastToGame(game.id, {
    type: "player_bid_locked",
    player_index: playerIndex,
    player_name: player.name
  });

  // Check if all players have bid
  var allBid = true;
  for (var pi = 0; pi < game.players.length; pi++) {
    if (!game.players[pi].hasBid) {
      allBid = false;
      break;
    }
  }

  if (allBid) {
    resolveTurn(game);
  }

  res.json({ ok: true, effective_cost: totalCost, remaining_ap: player.ap - totalCost });
});

app.get("/api/game/:id/history", function(req, res) {
  var game = games[req.params.id];
  if (!game) return res.status(404).json({ error: "Game not found" });
  res.json({ game_id: game.id, history: game.history });
});

app.get("/api/leaderboard", function(req, res) {
  res.json(loadLeaderboard());
});

// --- WebSocket ---

server.on("upgrade", function(request, socket, head) {
  var url = request.url || "";
  var match = url.match(/\/ws\/([a-f0-9-]+)/);
  if (match) {
    wss.handleUpgrade(request, socket, head, function(ws) {
      ws.gameId = match[1];
      wss.emit("connection", ws, request);
    });
  } else {
    socket.destroy();
  }
});

wss.on("connection", function(ws) {
  var game = games[ws.gameId];
  if (game) {
    ws.send(JSON.stringify({ type: "state", state: getPublicState(game) }));
  }

  ws.on("message", function(data) {
    // Clients don't send messages in v1 — bids go through REST
  });
});

// --- Start ---

server.listen(PORT, function() {
  console.log("Crown server running on port " + PORT);
});
