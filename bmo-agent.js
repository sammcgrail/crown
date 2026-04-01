// BMO's Crown player agent
// Strategy: "Opportunist" — expand efficiently early, contest crown mid-game,
// block crown holders in emergencies, read opponent bid patterns to counter.

var GAME_URL = process.env.CROWN_URL || "https://crown.sebland.com";
var BOT_NAME = "BMO";
var WS_URL = GAME_URL.replace("https://", "wss://").replace("http://", "ws://") + "/ws";

var token = null;
var playerIndex = null;
var gameActive = false;
var turnCount = 0;
var opponentHistory = {}; // track opponent bid patterns

async function api(method, path, body) {
  var url = GAME_URL + path;
  var opts = { method: method, headers: { "Content-Type": "application/json" } };
  if (body) opts.body = JSON.stringify(body);
  var res = await fetch(url, opts);
  var data = await res.json();
  if (!res.ok) throw new Error(data.error || "API error " + res.status);
  return data;
}

async function getState() {
  return api("GET", "/api/state");
}

async function joinGame() {
  try {
    var data = await api("POST", "/api/join", { name: BOT_NAME });
    token = data.token;
    playerIndex = data.player_id;
    console.log("BMO joined as player " + playerIndex + " (color: " + data.color + ")");
    return true;
  } catch (e) {
    // Game might be in progress or full
    return false;
  }
}

async function submitBids(bids) {
  try {
    var data = await api("POST", "/api/bid", { token: token, bids: bids });
    console.log("Turn " + turnCount + " | Bid cost: " + data.effective_cost + " | AP left: " + data.remaining_ap);
    return true;
  } catch (e) {
    console.log("Bid failed: " + e.message);
    return false;
  }
}

// Strategy helpers

function getEmptyNeighbors(grid, x, y, size) {
  var dirs = [[0,1],[0,-1],[1,0],[-1,0]];
  var result = [];
  for (var i = 0; i < dirs.length; i++) {
    var nx = x + dirs[i][0], ny = y + dirs[i][1];
    if (nx >= 0 && nx < size && ny >= 0 && ny < size && grid[ny][nx] === null)
      result.push({ x: nx, y: ny });
  }
  return result;
}

function getFrontier(grid, size, pIdx) {
  var frontier = [];
  var seen = {};
  for (var y = 0; y < size; y++) {
    for (var x = 0; x < size; x++) {
      if (grid[y][x] === pIdx) {
        var neighbors = getEmptyNeighbors(grid, x, y, size);
        for (var n = 0; n < neighbors.length; n++) {
          var key = neighbors[n].x + "," + neighbors[n].y;
          if (!seen[key]) {
            seen[key] = true;
            // Score: how many empty neighbors does THIS cell have (expansion potential)
            var subNeighbors = getEmptyNeighbors(grid, neighbors[n].x, neighbors[n].y, size);
            frontier.push({ x: neighbors[n].x, y: neighbors[n].y, score: subNeighbors.length, adjacent: true });
          }
        }
      }
    }
  }
  return frontier;
}

function distTo(x1, y1, x2, y2) {
  return Math.abs(x1 - x2) + Math.abs(y1 - y2);
}

function isAdjacent(grid, x, y, pIdx, size) {
  var dirs = [[0,1],[0,-1],[1,0],[-1,0]];
  for (var i = 0; i < dirs.length; i++) {
    var nx = x + dirs[i][0], ny = y + dirs[i][1];
    if (nx >= 0 && nx < size && ny >= 0 && ny < size && grid[ny][nx] === pIdx)
      return true;
  }
  return false;
}

function recordOpponentBids(previousBids) {
  if (!previousBids) return;
  for (var i = 0; i < previousBids.length; i++) {
    var bid = previousBids[i];
    if (bid.player === playerIndex) continue;
    if (!opponentHistory[bid.player]) opponentHistory[bid.player] = [];
    opponentHistory[bid.player].push({ x: bid.x, y: bid.y, amount: bid.amount, turn: turnCount });
  }
}

function getOpponentAvgBid(pIdx) {
  var bids = opponentHistory[pIdx];
  if (!bids || bids.length === 0) return 3;
  var total = 0;
  // Weight recent bids more
  var recent = bids.slice(-6);
  for (var i = 0; i < recent.length; i++) total += recent[i].amount;
  return total / recent.length;
}

async function decideBids(state) {
  var grid = state.grid;
  var size = state.grid_size;
  var myAP = state.players[playerIndex].ap;
  var crownX = state.crown.x, crownY = state.crown.y;
  var crownHolder = state.crown_holder;
  var crownStreak = state.crown_streak;
  var fillPercent = 0;
  var totalCells = size * size;
  var filledCells = 0;

  for (var y = 0; y < size; y++)
    for (var x = 0; x < size; x++)
      if (grid[y][x] !== null) filledCells++;
  fillPercent = filledCells / totalCells;

  recordOpponentBids(state.previous_bids);

  var frontier = getFrontier(grid, size, playerIndex);
  var bids = [];

  // EMERGENCY: someone is at crown streak 2 — dump AP to block
  if (crownStreak >= 2 && crownHolder !== null && crownHolder !== playerIndex) {
    var crownAdj = isAdjacent(grid, crownX, crownY, playerIndex, size);
    var bidAmount = Math.min(myAP, Math.floor(myAP * 0.8));
    if (crownAdj) bidAmount = Math.min(myAP * 2, bidAmount); // adjacency discount means we can bid more
    bids.push({ x: crownX, y: crownY, amount: Math.max(1, bidAmount) });
    console.log("  EMERGENCY BLOCK: bidding " + bidAmount + " on crown");
    return bids;
  }

  // LATE GAME (>60% filled): go for crown
  if (fillPercent > 0.6 && myAP >= 5) {
    var crownAdj2 = isAdjacent(grid, crownX, crownY, playerIndex, size);
    if (crownAdj2 || grid[crownY][crownX] === playerIndex) {
      // We're adjacent or own it — bid to hold/take
      var crownBid = Math.floor(myAP * 0.5);
      // If we already hold crown, bid enough to defend
      if (crownHolder === playerIndex) {
        crownBid = Math.floor(myAP * 0.6);
      }
      bids.push({ x: crownX, y: crownY, amount: Math.max(1, crownBid) });
      myAP -= crownAdj2 ? Math.ceil(crownBid / 2) : crownBid;
    } else {
      // Path toward crown — bid on frontier cell closest to crown
      frontier.sort(function(a, b) {
        return distTo(a.x, a.y, crownX, crownY) - distTo(b.x, b.y, crownX, crownY);
      });
      if (frontier.length > 0) {
        var pathBid = Math.min(Math.floor(myAP * 0.4), 5);
        bids.push({ x: frontier[0].x, y: frontier[0].y, amount: Math.max(1, pathBid) });
        myAP -= Math.ceil(pathBid / 2); // adjacent discount
        frontier.shift();
      }
    }
  }

  // MID GAME (30-60%): mix expansion and crown approach
  if (fillPercent > 0.3 && fillPercent <= 0.6) {
    // Push toward center
    frontier.sort(function(a, b) {
      var aDist = distTo(a.x, a.y, crownX, crownY);
      var bDist = distTo(b.x, b.y, crownX, crownY);
      // Blend: distance to crown + expansion potential
      return (aDist - a.score * 0.5) - (bDist - b.score * 0.5);
    });
  } else {
    // EARLY GAME: pure expansion — maximize territory for AP income
    frontier.sort(function(a, b) { return b.score - a.score; });
  }

  // Fill remaining bid slots with expansion
  var remainingSlots = 3 - bids.length;
  for (var i = 0; i < Math.min(remainingSlots, frontier.length); i++) {
    if (myAP <= 0) break;
    var cell = frontier[i];
    // Bid just enough to likely win — read opponent patterns
    var bidAmt = Math.max(1, Math.min(3, Math.floor(myAP / (remainingSlots - i))));

    // If this cell might be contested (near other territories), bid higher
    var contested = false;
    var dirs = [[0,1],[0,-1],[1,0],[-1,0]];
    for (var d = 0; d < dirs.length; d++) {
      var nx = cell.x + dirs[d][0], ny = cell.y + dirs[d][1];
      if (nx >= 0 && nx < size && ny >= 0 && ny < size) {
        var owner = grid[ny][nx];
        if (owner !== null && owner !== playerIndex) { contested = true; break; }
      }
    }
    if (contested) bidAmt = Math.min(myAP, bidAmt + 2);

    var effCost = cell.adjacent ? Math.ceil(bidAmt / 2) : bidAmt;
    if (effCost > myAP) {
      bidAmt = cell.adjacent ? myAP * 2 : myAP;
      effCost = cell.adjacent ? Math.ceil(bidAmt / 2) : bidAmt;
      if (effCost > myAP) continue;
    }

    bids.push({ x: cell.x, y: cell.y, amount: Math.max(1, bidAmt) });
    myAP -= effCost;
  }

  return bids;
}

// Main loop — connect via WebSocket and respond to turns

async function main() {
  console.log("BMO Crown Agent starting...");

  // Try to join
  var joined = await joinGame();
  if (!joined) {
    console.log("Couldn't join yet — waiting for a new game...");
  }

  // Connect WebSocket
  var WebSocket;
  try {
    WebSocket = (await import("ws")).default;
  } catch (e) {
    // Node 18+ has built-in WebSocket
    WebSocket = globalThis.WebSocket;
  }

  var ws = new WebSocket(WS_URL);

  ws.on("open", function() {
    console.log("WebSocket connected");
  });

  ws.on("message", async function(data) {
    var msg;
    try { msg = JSON.parse(data.toString()); } catch (e) { return; }

    if (msg.type === "new_game") {
      console.log("\n=== New game starting! ===");
      token = null;
      playerIndex = null;
      gameActive = false;
      turnCount = 0;
      opponentHistory = {};
      // Auto-join
      setTimeout(async function() {
        var ok = await joinGame();
        if (ok) console.log("Joined new game!");
        else console.log("Failed to join new game");
      }, 1000);
    }

    if (msg.type === "game_started") {
      console.log("Game started! " + msg.state.players.length + " players");
      gameActive = true;
      turnCount = 1;
      // Submit first turn bids
      if (token) {
        var state = await getState();
        var bids = await decideBids(state);
        if (bids.length > 0) await submitBids(bids);
      }
    }

    if (msg.type === "turn_resolved") {
      turnCount = msg.turn;
      console.log("\n--- Turn " + turnCount + " ---");
      for (var i = 0; i < msg.scores.length; i++) {
        var s = msg.scores[i];
        console.log("  " + s.name + ": " + s.tiles + " tiles, " + s.ap + " AP");
      }
      if (msg.crown_holder !== null) {
        console.log("  Crown: player " + msg.crown_holder + " (streak " + msg.crown_streak + ")");
      }
      // Submit next turn bids
      if (token && gameActive) {
        var state2 = await getState();
        var bids2 = await decideBids(state2);
        if (bids2.length > 0) await submitBids(bids2);
      }
    }

    if (msg.type === "game_over") {
      console.log("\n=== GAME OVER ===");
      console.log("Winner: " + msg.winner_name + " (" + msg.reason + ")");
      gameActive = false;
    }
  });

  ws.on("close", function() {
    console.log("WebSocket closed — reconnecting in 5s...");
    setTimeout(main, 5000);
  });

  ws.on("error", function(err) {
    console.error("WebSocket error:", err.message);
  });
}

main().catch(console.error);
