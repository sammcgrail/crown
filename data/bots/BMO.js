// BMO's autobot — opportunist expansion with emergency crown blocking
function decideBids(state) {
  var grid = state.grid;
  var size = state.grid_size;
  var me = state.players[state.my_index];
  var ap = me.ap;
  var crownX = state.crown.x, crownY = state.crown.y;
  var myIdx = state.my_index;

  function dist(x1, y1, x2, y2) { return Math.abs(x1-x2) + Math.abs(y1-y2); }
  function isAdj(x, y, pIdx) {
    var dirs = [[0,1],[0,-1],[1,0],[-1,0]];
    for (var i = 0; i < dirs.length; i++) {
      var nx = x+dirs[i][0], ny = y+dirs[i][1];
      if (nx>=0 && nx<size && ny>=0 && ny<size && grid[ny][nx] === pIdx) return true;
    }
    return false;
  }

  // Count filled cells
  var filled = 0;
  for (var y = 0; y < size; y++)
    for (var x = 0; x < size; x++)
      if (grid[y][x] !== null) filled++;
  var fillPct = filled / (size * size);

  // Get frontier (adjacent empty cells)
  var frontier = [];
  var seen = {};
  for (var y2 = 0; y2 < size; y2++) {
    for (var x2 = 0; x2 < size; x2++) {
      if (grid[y2][x2] !== myIdx) continue;
      var dirs = [[0,1],[0,-1],[1,0],[-1,0]];
      for (var d = 0; d < dirs.length; d++) {
        var nx = x2+dirs[d][0], ny = y2+dirs[d][1];
        if (nx>=0 && nx<size && ny>=0 && ny<size && grid[ny][nx] === null) {
          var k = nx+","+ny;
          if (!seen[k]) { seen[k] = true; frontier.push({ x: nx, y: ny }); }
        }
      }
    }
  }

  var bids = [];

  // EMERGENCY: block crown holder at streak 2
  if (state.crown_streak >= 2 && state.crown_holder !== null && state.crown_holder !== myIdx) {
    var amt = Math.min(ap, Math.floor(ap * 0.8));
    bids.push({ x: crownX, y: crownY, amount: Math.max(1, amt) });
    return bids;
  }

  // Late game: go for crown
  if (fillPct > 0.6 && ap >= 5 && isAdj(crownX, crownY, myIdx)) {
    var crownBid = Math.floor(ap * (state.crown_holder === myIdx ? 0.6 : 0.5));
    bids.push({ x: crownX, y: crownY, amount: Math.max(1, crownBid) });
    ap -= Math.ceil(crownBid / 2);
  } else if (fillPct > 0.6) {
    // Path toward crown
    frontier.sort(function(a, b) { return dist(a.x, a.y, crownX, crownY) - dist(b.x, b.y, crownX, crownY); });
    if (frontier.length > 0) {
      var pb = Math.min(Math.floor(ap * 0.4), 5);
      bids.push({ x: frontier[0].x, y: frontier[0].y, amount: Math.max(1, pb) });
      ap -= Math.ceil(pb / 2);
      frontier.shift();
    }
  }

  // Mid game: blend expansion + crown approach
  if (fillPct > 0.3 && fillPct <= 0.6) {
    frontier.sort(function(a, b) {
      return (dist(a.x, a.y, crownX, crownY)) - (dist(b.x, b.y, crownX, crownY));
    });
  } else {
    frontier.sort(function() { return Math.random() - 0.5; }); // early game: spread out
  }

  var remaining = 3 - bids.length;
  for (var f = 0; f < Math.min(remaining, frontier.length); f++) {
    if (ap <= 0) break;
    var cell = frontier[f];
    var contested = false;
    var cdirs = [[0,1],[0,-1],[1,0],[-1,0]];
    for (var cd = 0; cd < cdirs.length; cd++) {
      var cnx = cell.x+cdirs[cd][0], cny = cell.y+cdirs[cd][1];
      if (cnx>=0 && cnx<size && cny>=0 && cny<size && grid[cny][cnx] !== null && grid[cny][cnx] !== myIdx) {
        contested = true; break;
      }
    }
    var bidAmt = contested ? Math.min(ap, 4) : Math.max(1, Math.min(3, Math.floor(ap / (remaining - f))));
    var eff = Math.ceil(bidAmt / 2);
    if (eff > ap) continue;
    bids.push({ x: cell.x, y: cell.y, amount: bidAmt });
    ap -= eff;
  }

  return bids;
}
