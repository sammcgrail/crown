// calne's autobot — defensive territory builder, forks toward crown late
// Strategy: maximize territory early by expanding in widest direction,
// build a wall to deny opponents, then fork toward crown in final stretch
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

  // Find all adjacent cells (both empty and enemy)
  var frontier = [];
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
            // Count how many of MY tiles border this cell (defensibility)
            var myNeighbors = 0;
            for (var dd = 0; dd < dirs.length; dd++) {
              var nnx = nx+dirs[dd][0], nny = ny+dirs[dd][1];
              if (nnx>=0 && nnx<size && nny>=0 && nny<size && grid[nny][nnx] === myIdx) myNeighbors++;
            }
            // Count enemy neighbors (threat level)
            var enemyNeighbors = 0;
            for (var dd2 = 0; dd2 < dirs.length; dd2++) {
              var nnx2 = nx+dirs[dd2][0], nny2 = ny+dirs[dd2][1];
              if (nnx2>=0 && nnx2<size && nny2>=0 && nny2<size && grid[nny2][nnx2] !== null && grid[nny2][nnx2] !== myIdx) enemyNeighbors++;
            }
            frontier.push({
              x: nx, y: ny, empty: grid[ny][nx] === null,
              myNeighbors: myNeighbors, enemyNeighbors: enemyNeighbors,
              distCrown: dist(nx, ny, crownX, crownY)
            });
          }
        }
      }
    }
  }

  var bids = [];

  // Emergency crown block
  if (state.crown_streak >= 2 && state.crown_holder !== null && state.crown_holder !== myIdx) {
    var amt = Math.max(1, Math.floor(ap * 0.7));
    bids.push({ x: crownX, y: crownY, amount: amt });
    return bids;
  }

  // Late game (turn > 20): prioritize crown path
  if (state.turn > 20) {
    frontier.sort(function(a, b) {
      return a.distCrown - b.distCrown;
    });
  } else {
    // Early/mid: defensive expansion — prefer cells with many friendly neighbors
    // and cells that block enemy expansion
    frontier.sort(function(a, b) {
      var aScore = a.myNeighbors * 3 + a.enemyNeighbors * 2 + (a.empty ? 1 : 0) - a.distCrown * 0.3;
      var bScore = b.myNeighbors * 3 + b.enemyNeighbors * 2 + (b.empty ? 1 : 0) - b.distCrown * 0.3;
      return bScore - aScore;
    });
  }

  var totalCost = 0;
  for (var f = 0; f < frontier.length && bids.length < 3; f++) {
    if (ap <= 0) break;
    var cell = frontier[f];
    var amount;
    if (cell.distCrown === 0) {
      amount = Math.max(3, Math.floor(ap * 0.5)); // crown cell
    } else if (cell.enemyNeighbors > 0) {
      amount = Math.min(3, ap); // contested border
    } else {
      amount = 1; // safe expansion
    }
    var eff = Math.ceil(amount / 2);
    if (totalCost + eff > ap) { amount = 1; eff = 1; if (totalCost + eff > ap) continue; }
    bids.push({ x: cell.x, y: cell.y, amount: amount });
    totalCost += eff;
  }

  return bids;
}
