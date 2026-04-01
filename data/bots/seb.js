// seb's autobot — crown-focused with adjacency optimization
function decideBids(state) {
  var grid = state.grid;
  var size = state.grid_size;
  var me = state.players[state.my_index];
  var ap = me.ap;
  var crownX = state.crown.x, crownY = state.crown.y;

  function dist(x1, y1, x2, y2) { return Math.abs(x1-x2) + Math.abs(y1-y2); }
  function isAdj(x, y) {
    var dirs = [[0,1],[0,-1],[1,0],[-1,0]];
    for (var i = 0; i < dirs.length; i++) {
      var nx = x+dirs[i][0], ny = y+dirs[i][1];
      if (nx>=0 && nx<size && ny>=0 && ny<size && grid[ny][nx] === state.my_index) return true;
    }
    return false;
  }

  var candidates = [];
  for (var y = 0; y < size; y++) {
    for (var x = 0; x < size; x++) {
      if (grid[y][x] === state.my_index) continue;
      if (!isAdj(x, y)) continue;
      var d = dist(x, y, crownX, crownY);
      var isCrown = (x === crownX && y === crownY);
      var score = 100 - d * 5;
      if (isCrown) score += 200;
      if (grid[y][x] === null) score += 10;
      if (isCrown && state.crown_holder === state.my_index) score += 300;
      candidates.push({ x: x, y: y, score: score, isCrown: isCrown, dist: d });
    }
  }
  candidates.sort(function(a, b) { return b.score - a.score; });

  var bids = [], totalCost = 0;
  for (var c = 0; c < candidates.length && bids.length < 3; c++) {
    var cand = candidates[c];
    var amount;
    if (cand.isCrown) amount = Math.min(Math.max(3, Math.ceil(ap * 0.4)), ap);
    else if (cand.dist <= 2) amount = Math.min(2, ap);
    else amount = 1;
    var eff = Math.ceil(amount / 2); // adjacent discount
    if (totalCost + eff > ap) { amount = 1; eff = 1; if (totalCost + eff > ap) continue; }
    bids.push({ x: cand.x, y: cand.y, amount: amount });
    totalCost += eff;
  }
  return bids;
}
