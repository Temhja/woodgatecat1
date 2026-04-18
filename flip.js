/* ============================================================
   WoodGate Catalog — flip.js  v4.0
   Bezier Paper Curl Engine
   ─────────────────────────────────────────────────────────
   How it works:
   The page is drawn frame-by-frame on a <canvas> element that
   sits over the static book container. On each frame we draw:

   1. DESTINATION page (flat, underneath everything)
   2. CURRENT page — but only the flat "not yet peeled" portion,
      clipped to a polygon that shrinks as the flip progresses
   3. FOLD SHADOW — a soft gradient along the fold line
   4. CURL FACE — the turning portion of the page, drawn as a
      curved quad using quadraticCurveTo. The background image
      is painted onto it using drawImage with a saved/restored
      canvas transform so it appears to sit on the curved face.
   5. BACK-FACE — a slightly lighter tint reveals the next page
      underneath the curl, simulating paper translucency.
   6. CAST SHADOW — radial gradient shadow cast by the lifted
      page onto the destination page beneath.

   RTL Arabic: forward flip peels from the LEFT edge.
               backward flip peels from the RIGHT edge.
   ============================================================ */

/* ============================================================
   FORMAT CONFIG
   Set USE_WEBP = true once images are converted to WebP.
   ============================================================ */
var USE_WEBP = false; /* ← flip to true after converting */

/* ============================================================
   PAGES — 170 pages auto-generated
   ============================================================ */
var PAGES = (function(){
  var p = [], ext = USE_WEBP ? '.webp' : '.jpg';
  var special = {1:'Cover', 170:'Back Cover'};
  for(var i = 1; i <= 170; i++)
    p.push({ src:'pages/pg'+i+ext, label: special[i]||'Page '+i });
  return p;
}());

/* ============================================================
   EASING
   ============================================================ */
function easeInOutCubic(t){ return t<.5?4*t*t*t:1-Math.pow(-2*t+2,3)/2; }
function easeOutCubic(t)  { return 1-Math.pow(1-t,3); }
function easeOutBack(t,c) { c=c||1.6; return 1+(c+1)*Math.pow(t-1,3)+c*Math.pow(t-1,2); }
function lerp(a,b,t)      { return a+(b-a)*t; }
function clamp(v,lo,hi)   { return v<lo?lo:v>hi?hi:v; }

/* ============================================================
   IMAGE CACHE + LOADER
   ─────────────────────────────────────────────────────────
   _cache[src] = HTMLImageElement once decoded, or true if done.
   Images are loaded as HTMLImageElement objects so we can use
   ctx.drawImage() to paint them onto the canvas — this is the
   key difference from the old background-image approach.
   ============================================================ */
var _imgCache  = {}; /* src → HTMLImageElement (decoded) */
var _imgPending= {}; /* src → [callbacks] — in-flight */

function getImage(src, cb){
  /* Already decoded */
  if(_imgCache[src]){ if(cb) cb(_imgCache[src]); return; }
  /* Queue onto existing in-flight request */
  if(_imgPending[src]){ if(cb) _imgPending[src].push(cb); return; }
  /* Start new fetch */
  _imgPending[src] = cb ? [cb] : [];
  var img = new Image();
  img.decoding = 'async';
  img.onload = function(){
    /* Use decode() if available for smoother first paint */
    var finish = function(){
      _imgCache[src] = img;
      var cbs = _imgPending[src] || [];
      delete _imgPending[src];
      for(var i=0;i<cbs.length;i++) cbs[i](img);
    };
    img.decode ? img.decode().then(finish).catch(finish) : finish();
  };
  img.onerror = function(){
    /* WebP → JPG fallback */
    if(USE_WEBP && src.slice(-5)==='.webp'){
      var fb = src.slice(0,-5)+'.jpg';
      var cbs = _imgPending[src]||[];
      delete _imgPending[src];
      for(var i=0;i<cbs.length;i++) getImage(fb,cbs[i]);
      return;
    }
    delete _imgPending[src];
  };
  img.src = src;
}

/* Connection-aware preload window */
var _conn = (function(){
  var c=navigator.connection||navigator.mozConnection||navigator.webkitConnection;
  if(!c) return {ahead:7,behind:3};
  var t=(c.effectiveType||'4g').toLowerCase();
  return t==='2g'||t==='slow-2g'?{ahead:2,behind:1}:t==='3g'?{ahead:4,behind:2}:{ahead:7,behind:3};
}());

var _preloadTimer=null;
function preloadAround(idx){
  clearTimeout(_preloadTimer);
  _preloadTimer=setTimeout(function(){
    for(var d=-_conn.behind;d<=_conn.ahead;d++){
      var i=idx+d;
      if(i>=0&&i<PAGES.length) getImage(PAGES[i].src,null);
    }
  },60);
}

/* ============================================================
   SHIMMER — shown on the canvas while images load
   ============================================================ */
function _buildShimmer(el){
  if(el._shimmer) return;
  var ov=document.createElement('div');
  ov.className='shimmer-overlay';
  var block=document.createElement('div'); block.className='shimmer-block'; ov.appendChild(block);
  var lines=document.createElement('div'); lines.className='shimmer-lines';
  for(var i=0;i<3;i++){ var ln=document.createElement('div'); ln.className='shimmer-line'; lines.appendChild(ln); }
  ov.appendChild(lines);
  var brand=document.createElement('div'); brand.className='shimmer-brand';
  brand.innerHTML='<div class="shimmer-brand-inner"><div class="shimmer-brand-icon">'+
    '<svg viewBox="0 0 22 22" fill="none" width="14" height="14">'+
    '<rect x="2" y="2" width="8" height="8" rx="1" stroke="#d4a017" stroke-width="1.5"/>'+
    '<rect x="12" y="2" width="8" height="8" rx="1" stroke="#d4a017" stroke-width="1.5"/>'+
    '<rect x="2" y="12" width="8" height="8" rx="1" stroke="#d4a017" stroke-width="1.5"/>'+
    '<rect x="12" y="12" width="8" height="8" rx="1" stroke="#d4a017" stroke-width="1.5"/>'+
    '</svg></div><div class="shimmer-brand-name">WoodGate</div></div>';
  ov.appendChild(brand);
  el.appendChild(ov); el._shimmer=ov;
}
function _removeShimmer(el){
  if(!el._shimmer) return;
  var ov=el._shimmer;
  ov.style.opacity='0';
  setTimeout(function(){ if(ov.parentNode) ov.parentNode.removeChild(ov); el._shimmer=null; },380);
}

/* ============================================================
   CANVAS RENDERER
   ─────────────────────────────────────────────────────────
   All drawing happens here. Called every rAF frame during flip,
   and once statically when showing a page.

   Parameters:
   ctx        — 2d context of the canvas
   W, H       — canvas pixel dimensions (already DPR-scaled)
   imgCurr    — HTMLImageElement of the current (leaving) page
   imgNext    — HTMLImageElement of the destination page
   progress   — 0.0 (no flip) → 1.0 (flip complete)
   dir        — +1 = forward (peel from LEFT), -1 = backward (peel from RIGHT)
   ============================================================ */
function renderFrame(ctx, W, H, imgCurr, imgNext, progress, dir){
  ctx.clearRect(0,0,W,H);

  var p    = progress;
  var fromLeft = (dir > 0);

  /* ── 1. DESTINATION page (flat, full) ─────────────────── */
  if(imgNext){
    ctx.drawImage(imgNext, 0, 0, W, H);
  } else {
    ctx.fillStyle='#111'; ctx.fillRect(0,0,W,H);
  }

  if(p <= 0){
    /* No flip — just draw current page on top */
    if(imgCurr) ctx.drawImage(imgCurr,0,0,W,H);
    return;
  }

  /* ── Fold geometry ────────────────────────────────────── */
  /*
    The fold line is a vertical line that moves across the page.
    fromLeft=true:  fold starts at x=W (right edge) at p=0
                    and moves to x=0  (left edge)  at p=1
    fromLeft=false: fold starts at x=0 and moves to x=W

    The "curl amount" is how much the page bends — peaks at p=0.5
    and is 0 at p=0 and p=1.

    foldX  = x position of the fold line
    curlW  = width of the curved portion (how far the curl extends)
    curlBow= how much the bezier curve bows outward
  */
  var foldX, curvedEdgeX;
  if(fromLeft){
    foldX        = W * (1 - p);
    curvedEdgeX  = foldX - W * 0.18 * Math.sin(p * Math.PI);
  } else {
    foldX        = W * p;
    curvedEdgeX  = foldX + W * 0.18 * Math.sin(p * Math.PI);
  }

  var bowAmount = H * 0.04 * Math.sin(p * Math.PI); /* vertical bow in the fold line */

  /* ── 2. FLAT portion of current page ─────────────────── */
  /*
    Clip to the polygon of the page that hasn't yet peeled.
    This is everything on the "not yet turned" side of the fold line.
  */
  ctx.save();
  ctx.beginPath();
  if(fromLeft){
    /* Flat portion = left side: 0..foldX */
    ctx.moveTo(0,         0);
    ctx.lineTo(foldX,     bowAmount);          /* fold line top (with bow) */
    ctx.lineTo(foldX,     H - bowAmount);       /* fold line bottom */
    ctx.lineTo(0,         H);
    ctx.closePath();
  } else {
    /* Flat portion = right side: foldX..W */
    ctx.moveTo(foldX,     bowAmount);
    ctx.lineTo(W,         0);
    ctx.lineTo(W,         H);
    ctx.lineTo(foldX,     H - bowAmount);
    ctx.closePath();
  }
  ctx.clip();
  if(imgCurr) ctx.drawImage(imgCurr, 0, 0, W, H);
  else { ctx.fillStyle='#111'; ctx.fillRect(0,0,W,H); }
  ctx.restore();

  /* ── 3. CAST SHADOW from lifted page ─────────────────── */
  /*
    Shadow is a linear gradient emanating from the fold line
    into the destination page area. Peaks at p=0.5.
  */
  var shadowDepth = 0.55 * Math.sin(p * Math.PI);
  ctx.save();
  var sg;
  if(fromLeft){
    sg = ctx.createLinearGradient(foldX, 0, foldX + W*0.18, 0);
  } else {
    sg = ctx.createLinearGradient(foldX, 0, foldX - W*0.18, 0);
  }
  sg.addColorStop(0,   'rgba(0,0,0,'+shadowDepth.toFixed(2)+')');
  sg.addColorStop(0.5, 'rgba(0,0,0,'+(shadowDepth*0.35).toFixed(2)+')');
  sg.addColorStop(1,   'rgba(0,0,0,0)');
  ctx.fillStyle = sg;
  if(fromLeft){
    ctx.fillRect(foldX, 0, W*0.22, H);
  } else {
    ctx.fillRect(Math.max(0, foldX - W*0.22), 0, W*0.22, H);
  }
  ctx.restore();

  /* ── 4. CURL FACE (turning portion of the page) ────────── */
  /*
    We draw the curl as a quadrilateral with one curved edge.
    The four corners of the turning page region:

    fromLeft=true (page peels from left hinge):
      Top-left    = (foldX, bowAmount)          — fold line top
      Bottom-left = (foldX, H-bowAmount)        — fold line bottom
      Bottom-right= (curvedEdgeX, H)            — far edge bottom
      Top-right   = (curvedEdgeX, 0)            — far edge top

    The left edge (fold line) is straight.
    The right edge (curl edge) curves using quadraticCurveTo.

    We paint the current-page image onto this shape by:
    1. Saving ctx state
    2. Setting up a clip path in the curl shape
    3. Using ctx.transform to map the image coords to this shape
    4. drawImage
    5. Restoring

    For the back face (> 90°) we flip to the next page image.
  */

  /* Which image appears on the curl face? */
  var curlImg;
  if(p < 0.5){
    /* Front face — current page */
    curlImg = imgCurr;
  } else {
    /* Back face — next page (mirrored) */
    curlImg = imgNext;
  }

  ctx.save();

  /* Build clip path for the curl region */
  ctx.beginPath();
  if(fromLeft){
    /* Fold line on the left, curl edge on the right */
    var topFold    = {x: foldX,        y: bowAmount   };
    var botFold    = {x: foldX,        y: H-bowAmount  };
    var botCurl    = {x: curvedEdgeX,  y: H           };
    var topCurl    = {x: curvedEdgeX,  y: 0           };

    ctx.moveTo(topFold.x, topFold.y);
    ctx.lineTo(botFold.x, botFold.y);
    /* Curved bottom edge */
    var midBotX = lerp(foldX, curvedEdgeX, 0.5);
    var midBotY = H + bowAmount * 1.5 * (p<.5?1:-1);
    ctx.quadraticCurveTo(midBotX, midBotY, botCurl.x, botCurl.y);
    /* Right (curl) edge */
    ctx.lineTo(topCurl.x, topCurl.y);
    /* Curved top edge */
    var midTopX = lerp(foldX, curvedEdgeX, 0.5);
    var midTopY = 0 - bowAmount * 1.5 * (p<.5?1:-1);
    ctx.quadraticCurveTo(midTopX, midTopY, topFold.x, topFold.y);
  } else {
    var topFold2   = {x: foldX,       y: bowAmount   };
    var botFold2   = {x: foldX,       y: H-bowAmount  };
    var botCurl2   = {x: curvedEdgeX, y: H           };
    var topCurl2   = {x: curvedEdgeX, y: 0           };

    ctx.moveTo(topFold2.x, topFold2.y);
    var midTopX2 = lerp(foldX, curvedEdgeX, 0.5);
    var midTopY2 = 0 - bowAmount * 1.5 * (p<.5?1:-1);
    ctx.quadraticCurveTo(midTopX2, midTopY2, topCurl2.x, topCurl2.y);
    ctx.lineTo(botCurl2.x, botCurl2.y);
    var midBotX2 = lerp(foldX, curvedEdgeX, 0.5);
    var midBotY2 = H + bowAmount * 1.5 * (p<.5?1:-1);
    ctx.quadraticCurveTo(midBotX2, midBotY2, botFold2.x, botFold2.y);
    ctx.closePath();
  }
  ctx.clip();

  /*
    Paint the image onto the curl face.
    For the back face (p > 0.5) we horizontally mirror the image
    so the content reads correctly on the reverse side.
  */
  if(curlImg){
    if(p > 0.5 && fromLeft){
      /* Mirror horizontally for back face */
      ctx.save();
      ctx.translate(W, 0);
      ctx.scale(-1, 1);
      ctx.drawImage(curlImg, 0, 0, W, H);
      ctx.restore();
    } else if(p > 0.5 && !fromLeft){
      ctx.save();
      ctx.translate(W, 0);
      ctx.scale(-1, 1);
      ctx.drawImage(curlImg, 0, 0, W, H);
      ctx.restore();
    } else {
      ctx.drawImage(curlImg, 0, 0, W, H);
    }
  }

  /* ── Curl shading ────────────────────────────────────── */
  /*
    Brightness drops toward the fold line (page curls away from viewer).
    A gradient from the fold line to the curl edge simulates this.
    Darker at fold line, lighter at the far edge.
  */
  var curlShadeDepth = 0.42 * Math.sin(p * Math.PI); /* peaks at p=0.5 */
  var csg;
  if(fromLeft){
    csg = ctx.createLinearGradient(foldX, 0, curvedEdgeX || foldX+1, 0);
    csg.addColorStop(0,   'rgba(0,0,0,'+curlShadeDepth.toFixed(2)+')');
    csg.addColorStop(0.35,'rgba(0,0,0,'+(curlShadeDepth*0.15).toFixed(2)+')');
    csg.addColorStop(1,   'rgba(0,0,0,0)');
  } else {
    csg = ctx.createLinearGradient(foldX, 0, curvedEdgeX || foldX-1, 0);
    csg.addColorStop(0,   'rgba(0,0,0,'+curlShadeDepth.toFixed(2)+')');
    csg.addColorStop(0.35,'rgba(0,0,0,'+(curlShadeDepth*0.15).toFixed(2)+')');
    csg.addColorStop(1,   'rgba(0,0,0,0)');
  }
  ctx.fillStyle = csg;
  ctx.fillRect(0, 0, W, H);

  /* Gloss highlight on curl edge — thin bright line */
  var glossOpacity = 0.10 * Math.sin(p * Math.PI);
  ctx.strokeStyle = 'rgba(255,255,255,'+glossOpacity.toFixed(2)+')';
  ctx.lineWidth   = Math.max(1, W * 0.003);
  ctx.beginPath();
  if(fromLeft){
    ctx.moveTo(curvedEdgeX, 0);
    ctx.quadraticCurveTo(
      lerp(foldX, curvedEdgeX, 0.5),
      H * 0.5,
      curvedEdgeX, H
    );
  } else {
    ctx.moveTo(curvedEdgeX, 0);
    ctx.quadraticCurveTo(
      lerp(foldX, curvedEdgeX, 0.5),
      H * 0.5,
      curvedEdgeX, H
    );
  }
  ctx.stroke();

  ctx.restore();

  /* ── 5. FOLD SHADOW (dark crease at fold line) ──────── */
  var foldShadowW = Math.max(2, W * 0.012);
  var fsOpacity   = 0.65 * Math.sin(p * Math.PI);
  ctx.save();
  if(fromLeft){
    var fsg = ctx.createLinearGradient(foldX - foldShadowW*2, 0, foldX + foldShadowW, 0);
    fsg.addColorStop(0,   'rgba(0,0,0,0)');
    fsg.addColorStop(0.5, 'rgba(0,0,0,'+fsOpacity.toFixed(2)+')');
    fsg.addColorStop(1,   'rgba(0,0,0,'+(fsOpacity*0.3).toFixed(2)+')');
    ctx.fillStyle = fsg;
    ctx.fillRect(foldX - foldShadowW*2, 0, foldShadowW*3, H);
  } else {
    var fsg2 = ctx.createLinearGradient(foldX - foldShadowW, 0, foldX + foldShadowW*2, 0);
    fsg2.addColorStop(0,   'rgba(0,0,0,'+(fsOpacity*0.3).toFixed(2)+')');
    fsg2.addColorStop(0.5, 'rgba(0,0,0,'+fsOpacity.toFixed(2)+')');
    fsg2.addColorStop(1,   'rgba(0,0,0,0)');
    ctx.fillStyle = fsg2;
    ctx.fillRect(foldX - foldShadowW, 0, foldShadowW*3, H);
  }
  ctx.restore();
}

/* ============================================================
   FLIP ENGINE
   ============================================================ */
var Flip = (function(){

  /* ── State ─────────────────────────────────────────────── */
  var cur     = 0;
  var busy    = false;
  var rafId   = null;
  var FLIP_MS = 820; /* cinematic */

  /* ── DOM ───────────────────────────────────────────────── */
  var $stage    = document.getElementById('stage');
  var $scene    = document.getElementById('book-scene');
  var $book     = document.getElementById('book');
  var $btnBack  = document.getElementById('btn-back');
  var $btnFwd   = document.getElementById('btn-fwd');
  var $counter  = document.getElementById('counter');
  var $dots     = document.getElementById('dots-track');

  /* ── Canvas setup ──────────────────────────────────────── */
  /*
    We replace the old pg-layer divs with a single <canvas>.
    The canvas is the same size as the book and receives all drawing.
  */
  var $canvas = null;
  var $ctx    = null;
  var _W = 0, _H = 0, _DPR = 1;

  function _initCanvas(){
    /* Remove old page layers if they exist */
    ['pg-under','pg-curr'].forEach(function(id){
      var el=document.getElementById(id); if(el) el.remove();
    });
    /* Remove old flipper */
    var fl=document.getElementById('flipper'); if(fl) fl.remove();

    $canvas = document.createElement('canvas');
    $canvas.id = 'flip-canvas';
    $canvas.style.cssText =
      'position:absolute;inset:0;width:100%;height:100%;border-radius:3px;display:block;cursor:grab;touch-action:none;';
    $book.appendChild($canvas);
    $ctx = $canvas.getContext('2d', {alpha:false});
  }

  function _resizeCanvas(){
    _DPR = Math.min(window.devicePixelRatio || 1, 2); /* cap at 2× for perf */
    var rect = $book.getBoundingClientRect();
    _W = Math.round(rect.width  * _DPR);
    _H = Math.round(rect.height * _DPR);
    $canvas.width  = _W;
    $canvas.height = _H;
    /* Redraw current frame after resize */
    if(!busy) _drawStatic();
  }

  /* ── Book sizing ───────────────────────────────────────── */
  var PAGE_RATIO = 3309 / 2367;

  function resize(){
    var sw = $stage.clientWidth  - 20;
    var sh = $stage.clientHeight - 20;
    var W  = Math.min(sw, sh * PAGE_RATIO);
    var H  = W / PAGE_RATIO;
    if(H > sh){ H = sh; W = H * PAGE_RATIO; }
    W = Math.round(W); H = Math.round(H);
    $scene.style.width  = W + 'px';
    $scene.style.height = H + 'px';
    $book.style.width   = W + 'px';
    $book.style.height  = H + 'px';
    _resizeCanvas();
  }

  /* ── Draw static (no flip) ─────────────────────────────── */
  function _drawStatic(){
    var img = _imgCache[PAGES[cur].src] || null;
    renderFrame($ctx, _W, _H, img, null, 0, 1);
    /* If image not loaded yet — show shimmer */
    if(!img){
      _buildShimmer($book);
      getImage(PAGES[cur].src, function(loaded){
        _removeShimmer($book);
        renderFrame($ctx, _W, _H, loaded, null, 0, 1);
      });
    } else {
      _removeShimmer($book);
    }
  }

  /* ── Show page (instant) ───────────────────────────────── */
  function showPage(idx){
    cur = clamp(idx, 0, PAGES.length-1);
    _drawStatic();
    updateUI(cur);
    preloadAround(cur);
  }

  /* ── UI ────────────────────────────────────────────────── */
  var MAX_DOTS=17, DOT_PX=12;

  function updateUI(idx){
    var p=PAGES[idx];
    $counter.textContent=(idx+1)+' / '+PAGES.length+'  ·  '+p.label;
    $btnBack.disabled=(idx===0);
    $btnFwd.disabled=(idx===PAGES.length-1);
    var all=$dots.querySelectorAll('.dot');
    all.forEach(function(d,i){
      d.className='dot'+(i===idx?' active':Math.abs(i-idx)<3?' near':'');
    });
    if(PAGES.length>MAX_DOTS){
      var off=clamp(idx-Math.floor(MAX_DOTS/2),0,PAGES.length-MAX_DOTS);
      $dots.style.transform='translateX('+(-off*DOT_PX)+'px)';
    }
  }

  /* ── FLIP ───────────────────────────────────────────────── */
  /*
    Loads both images, then animates renderFrame() each rAF.
    If images aren't ready, waits for them (rare if preload works).
    fromDrag + dragProgress: continue from mid-drag position.
  */
  function flip(dir, fromDrag, dragProgress){
    if(busy) return false;
    var next = cur + dir;
    if(next<0||next>=PAGES.length) return false;
    busy = true;
    if(rafId) cancelAnimationFrame(rafId);

    var curSrc  = PAGES[cur].src;
    var nextSrc = PAGES[next].src;
    var startP  = fromDrag ? clamp(dragProgress, 0, 0.85) : 0;
    var remaining = 1 - startP;
    var duration  = Math.max(FLIP_MS * remaining, 180);

    /* Ensure both images loaded before animating */
    var imgC = _imgCache[curSrc]  || null;
    var imgN = _imgCache[nextSrc] || null;

    function startAnim(){
      imgC = _imgCache[curSrc]  || null;
      imgN = _imgCache[nextSrc] || null;
      var startTime = null;

      function step(ts){
        if(!startTime) startTime = ts;
        var rawT = clamp((ts-startTime)/duration, 0, 1);
        /* Cinematic: easeInOutCubic for smooth departure and landing */
        var eased = easeInOutCubic(rawT);
        var progress = lerp(startP, 1.0, eased);
        renderFrame($ctx, _W, _H, imgC, imgN, progress, dir);
        if(rawT < 1){
          rafId = requestAnimationFrame(step);
        } else {
          _flipDone(next, imgN);
        }
      }
      rafId = requestAnimationFrame(step);
    }

    /* If either image missing, load first (shimmer shows) */
    if(!imgC || !imgN){
      _buildShimmer($book);
      var loaded = 0;
      var needed = (!imgC?1:0) + (!imgN?1:0);
      function onLoad(){
        loaded++;
        if(loaded >= needed){ _removeShimmer($book); startAnim(); }
      }
      if(!imgC) getImage(curSrc,  function(img){ imgC=img; onLoad(); });
      else onLoad(); /* count it immediately */
      if(!imgN) getImage(nextSrc, function(img){ imgN=img; onLoad(); });
      else onLoad();
    } else {
      startAnim();
    }
    return true;
  }

  function _flipDone(next, imgN){
    cur  = next;
    busy = false;
    /* Draw final static state */
    renderFrame($ctx, _W, _H, imgN, null, 0, 1);
    updateUI(cur);
    preloadAround(cur);
  }

  /* ── Snap back ─────────────────────────────────────────── */
  function _snapBack(dragP, dir){
    if(busy) return;
    busy = true;
    var imgC = _imgCache[PAGES[cur].src] || null;
    var imgN = _imgCache[PAGES[cur+dir] ? PAGES[cur+dir].src : ''] || null;
    var SNAP = 280, startT = null;
    var startP = dragP;
    function step(ts){
      if(!startT) startT=ts;
      var t = clamp((ts-startT)/SNAP,0,1);
      var p = startP * (1 - easeOutCubic(t));
      renderFrame($ctx,_W,_H,imgC,imgN,p,dir);
      if(t<1){ rafId=requestAnimationFrame(step); }
      else { renderFrame($ctx,_W,_H,imgC,null,0,1); busy=false; }
    }
    rafId=requestAnimationFrame(step);
  }

  /* ── DRAG ───────────────────────────────────────────────── */
  /*
    Drag maps finger position → flip progress (0→1).
    RTL: drag RIGHT = forward (+1), drag LEFT = backward (-1).
    We render live frames on every touchmove/mousemove.
  */
  var _d={active:false,dir:0,sx:0,lx:0,lt:0,vx:0,p:0,ready:false};

  function _dragStart(cx){
    if(busy) return;
    _d.active=true; _d.dir=0; _d.sx=cx; _d.lx=cx;
    _d.lt=performance.now(); _d.vx=0; _d.p=0; _d.ready=false;
  }

  function _dragMove(cx){
    if(!_d.active||busy) return;
    var now=performance.now(), dt=now-_d.lt;
    if(dt>0) _d.vx=(cx-_d.lx)/dt;
    _d.lx=cx; _d.lt=now;
    var dx=cx-_d.sx;

    if(_d.dir===0){
      if(Math.abs(dx)<12) return;
      _d.dir=dx>0?1:-1;
      var nxt=cur+_d.dir;
      if(nxt<0||nxt>=PAGES.length){ _d.active=false; return; }
      /* Preload destination immediately */
      getImage(PAGES[nxt].src, null);
      _d.ready=true;
    }
    if(!_d.ready) return;

    var raw = dx * _d.dir;
    /* Map drag distance to progress. Full width drag = full flip. */
    var bW  = $book.clientWidth;
    _d.p    = clamp(raw / (bW * 0.75), 0, 0.92);

    var imgC = _imgCache[PAGES[cur].src] || null;
    var nxt  = cur + _d.dir;
    var imgN = _imgCache[PAGES[nxt]?PAGES[nxt].src:''] || null;
    if(imgC) renderFrame($ctx,_W,_H,imgC,imgN,_d.p,_d.dir);
  }

  function _dragEnd(cx){
    if(!_d.active) return;
    _d.active=false;
    if(!_d.ready||_d.dir===0) return;
    var moved = _d.p > 0.18;
    var fast  = Math.abs(_d.vx) > 0.22;
    if(moved||(fast&&_d.p>0.08)){
      busy=false;
      flip(_d.dir, true, _d.p);
    } else {
      _snapBack(_d.p, _d.dir);
    }
    _d.dir=0;
  }

  /* ── Tilt (desktop 3D) ─────────────────────────────────── */
  var _tilt={x:0,y:0,tx:0,ty:0,raf:null};
  var MAX_T=3.5;
  function _tiltLoop(){
    _tilt.x=lerp(_tilt.x,_tilt.tx,0.07);
    _tilt.y=lerp(_tilt.y,_tilt.ty,0.07);
    if(!busy) $book.style.transform=
      'perspective(1800px) rotateX('+_tilt.y+'deg) rotateY('+_tilt.x+'deg)';
    var m=Math.abs(_tilt.x-_tilt.tx)>0.01||Math.abs(_tilt.y-_tilt.ty)>0.01;
    _tilt.raf=m?requestAnimationFrame(_tiltLoop):null;
  }

  /* ── Init ──────────────────────────────────────────────── */
  function init(){
    _initCanvas();
    resize();
    window.addEventListener('resize', resize);

    /* Build dots */
    $dots.innerHTML='';
    PAGES.forEach(function(_,i){
      var d=document.createElement('div');
      d.className='dot';
      d.addEventListener('click',function(){ Flip.jumpTo(i); });
      $dots.appendChild(d);
    });

    /* Eagerly preload first 10 */
    for(var i=0;i<Math.min(10,PAGES.length);i++) getImage(PAGES[i].src,null);

    showPage(0);

    /* Touch */
    $canvas.addEventListener('touchstart',function(e){ _dragStart(e.touches[0].clientX); },{passive:true});
    $canvas.addEventListener('touchmove',function(e){
      _dragMove(e.touches[0].clientX);
      if(_d.dir!==0) e.preventDefault();
    },{passive:false});
    $canvas.addEventListener('touchend',function(e){ _dragEnd(e.changedTouches[0].clientX); },{passive:true});
    $canvas.addEventListener('touchcancel',function(e){ _dragEnd(e.changedTouches[0].clientX); },{passive:true});

    /* Mouse */
    $canvas.addEventListener('mousedown',function(e){ _dragStart(e.clientX); e.preventDefault(); });
    document.addEventListener('mousemove',function(e){ _dragMove(e.clientX); });
    document.addEventListener('mouseup',function(e){ _dragEnd(e.clientX); });

    /* Cursor */
    $canvas.addEventListener('mousedown',function(){ $canvas.style.cursor='grabbing'; });
    document.addEventListener('mouseup',function(){ $canvas.style.cursor='grab'; });

    /* Tilt */
    document.addEventListener('pointermove',function(e){
      if(e.pointerType==='touch'||busy) return;
      var cx=window.innerWidth/2,cy=window.innerHeight/2;
      _tilt.tx=((e.clientX-cx)/cx)*MAX_T;
      _tilt.ty=-((e.clientY-cy)/cy)*MAX_T;
      if(!_tilt.raf) _tilt.raf=requestAnimationFrame(_tiltLoop);
    });
    document.addEventListener('mouseleave',function(){
      _tilt.tx=0;_tilt.ty=0;
      if(!_tilt.raf) _tilt.raf=requestAnimationFrame(_tiltLoop);
    });

    /* Buttons */
    document.getElementById('btn-back').addEventListener('click',function(){ flip(-1,false,0); });
    document.getElementById('btn-fwd') .addEventListener('click',function(){ flip( 1,false,0); });

    /* Keyboard */
    document.addEventListener('keydown',function(e){
      if(document.activeElement===document.getElementById('search-input')) return;
      if(e.key==='ArrowLeft' ||e.key==='ArrowDown')  flip( 1,false,0);
      if(e.key==='ArrowRight'||e.key==='ArrowUp')    flip(-1,false,0);
      if(e.key==='f'||e.key==='F') WG.toggleFS();
    });
  }

  return {
    init:   init,
    flip:   flip,
    resize: resize,
    jumpTo: function(idx){ if(!busy) showPage(clamp(idx,0,PAGES.length-1)); },
    get cur(){ return cur; }
  };

}());

/* ============================================================
   APP CONTROLLER
   ============================================================ */
var WG=(function(){

  function goToPage(){
    var inp=document.getElementById('search-input');
    var v=parseInt(inp.value,10);
    inp.value=''; inp.blur();
    if(isNaN(v)||v<1||v>PAGES.length){ showToast('Enter a number between 1 and '+PAGES.length); return; }
    Flip.jumpTo(v-1);
  }

  var _tt=null;
  function showToast(msg){
    var t=document.getElementById('toast');
    t.textContent=msg; t.classList.add('show');
    clearTimeout(_tt); _tt=setTimeout(function(){ t.classList.remove('show'); },2600);
  }

  function toggleFS(){
    var el=document.documentElement;
    var fs=document.fullscreenElement||document.webkitFullscreenElement;
    if(!fs)(el.requestFullscreen||el.webkitRequestFullscreen||function(){}).call(el);
    else   (document.exitFullscreen||document.webkitExitFullscreen||function(){}).call(document);
  }
  ['fullscreenchange','webkitfullscreenchange'].forEach(function(ev){
    document.addEventListener(ev,function(){
      var fs=document.fullscreenElement||document.webkitFullscreenElement;
      document.getElementById('fs-label').textContent=fs?'Exit':'Full';
    });
  });

  function closeHowTo(){
    document.getElementById('howto').classList.remove('show');
    try{ localStorage.setItem('wg_catalog_seen','1'); }catch(e){}
  }

  function detectBg(){
    var img=new Image();
    img.onload=function(){ document.getElementById('bg-layer').classList.add('with-image'); };
    img.src='bg.jpg';
  }

  document.addEventListener('DOMContentLoaded',function(){
    detectBg();
    Flip.init();

    document.getElementById('search-go').addEventListener('click',goToPage);
    document.getElementById('search-input').addEventListener('keydown',function(e){
      if(e.key==='Enter') goToPage();
    });
    document.getElementById('hw-close').addEventListener('click',closeHowTo);

    window.addEventListener('load',function(){
      setTimeout(function(){
        var l=document.getElementById('loader');
        l.classList.add('out');
        setTimeout(function(){
          l.remove();
          try{
            if(!localStorage.getItem('wg_catalog_seen'))
              document.getElementById('howto').classList.add('show');
          }catch(e){}
        },850);
      },900);
    });
  });

  return { toggleFS:toggleFS, closeHowTo:closeHowTo, goToPage:goToPage, showToast:showToast };

}());
