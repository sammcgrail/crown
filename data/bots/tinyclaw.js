// tinyclaw's autobot — aggressive raider, steals enemy tiles and rushes crown
// Strategy: prioritize taking enemy tiles over empty ones (denies their AP income),
// bid high on contested cells, rush crown from turn 15 onward
function decideBids(state) {
  var grid = state.grid;
  var size = state.grid_size;
  var myIdx = state.my_index;
  var me = state.players[myIdx];
  var ap = me.ap;
  var crownX = state.crown.x, crownY = state.crown.y;

  function dist(x1, y1, x2, y2) { return Math.abs(x1-x2) + Math.abs(y1-y2); }
  function isAdj(x, y, pIdx) {
    var dirs = [[0,1],[0,-1],[1,0],[-1,0]];
    for (var i = 0; i < dirs.length; i++) {
      var nx = x+dirs[i][0], ny = y+dirs[i][1];
      if (nx>=0 && nx<size && ny>=0 && ny<size && grid[ny][nx] === pIdx) return true;
    }
    return false;
  }

  // Find strongest opponent (most tiles)
  var strongestIdx = -1, strongestTiles = 0;
  for (var p = 0; p < state.players.length; p++) {
    if (p === myIdx) continue;
    if (state.players[p].tiles > strongestTiles) {
      strongestTiles = state.players[p].tiles;
      strongestIdx = p;
    }
  }

  // Get all adjacent cells
  var targets = [];
  var seen = {};
  for (var y = 0; y < size; y++) {
    for (var x = 0; x < size; x++) {
      if (grid[y][x] !== myIdx) continue;
      var dirs = [[0,1],[0,-1],[1,0],[-1,0]];
      for (var d = 0; d < dirs.length; d++) {
        var nx = x+dirs[d][0], ny = y+dirs[d][1];
        if (nx>=0 && nx<size && ny>=0 && ny<size && grid[ny][nx] !== myIdx) {
          var k = nx+","+ny;
          if (!seen[k]) {
            seen[k] = true;
            var isEnemy = grid[ny][nx] !== null;
            var isStrongest = grid[ny][nx] === strongestIdx;
            var isCrown = (nx === crownX && ny === crownY);
            var score = 0;
            score += isEnemy ? 30 : 5; // prefer stealing enemy tiles
            score += isStrongest ? 20 : 0; // target the leader
            score += isCrown ? 100 : 0;
            score -= dist(nx, ny, crownX, crownY) * 2; // bias toward crown
            if (state.turn >= 15) score += (10 - dist(nx, ny, crownX, crownY)) * 5; // rush crown
            targets.push({ x: nx, y: ny, score: score, isEnemy: isEnemy, isCrown: isCrown });
          }
        }
      }
    }
  }

  targets.sort(function(a, b) { return b.score - a.score; });

  var bids = [];

  // Emergency block
  if (state.crown_streak >= 2 && state.crown_holder !== null && state.crown_holder !== myIdx) {
    bids.push({ x: crownX, y: crownY, amount: Math.max(1, Math.floor(ap * 0.85)) });
    return bids;
  }

  var totalCost = 0;
  for (var t = 0; t < targets.length && bids.length < 3; t++) {
    if (ap <= 0) break;
    var tgt = targets[t];
    var amount;
    if (tgt.isCrown) {
      amount = Math.max(4, Math.floor(ap * 0.5));
    } else if (tgt.isEnemy) {
      amount = Math.min(4, Math.max(2, Math.floor(ap * 0.25))); // bid high to steal
    } else {
      amount = 1;
    }
    var eff = Math.ceil(amount / 2);
    if (totalCost + eff > ap) { amount = 1; eff = 1; if (totalCost + eff > ap) continue; }
    bids.push({ x: tgt.x, y: tgt.y, amount: amount });
    totalCost += eff;
  }

  return bids;
}
