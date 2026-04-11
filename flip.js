/* ============================================================
   WoodGate Catalog — flip.js
   Hard Flip Engine · Cinematic · Drag + Auto · 170 Pages
   ============================================================ */

/* ============================================================
   PAGES — 170 entries, one per image file.
   Files live in:  pages/pg1.jpg … pages/pg170.jpg

   To activate all pages: the array is fully written below.
   Just make sure your images are in the pages/ folder.
   ============================================================ */
var PAGES = (function(){
  var p = [];
  var labels = {
    1:   'Cover',
    170: 'Back Cover'
  };
  for(var i = 1; i <= 170; i++){
    p.push({
      src:   'pages/pg' + i + '.jpg',
      label: labels[i] || 'Page ' + i
    });
  }
  return p;
}());

/* ============================================================
   EASING
   ============================================================ */
function easeOutBack(t, c) {
  /* c controls overshoot strength. Hard flip uses c=2.0 for
     a crisp snap that settles decisively. */
  c = c || 2.0;
  var c3 = c + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2);
}

function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

function easeInCubic(t) {
  return t * t * t;
}

/* Cinematic hard flip uses a two-phase ease:
   Phase 1 (0→0.5): fast departure — easeInCubic accelerates quickly
   Phase 2 (0.5→1): easeOutBack with overshoot — snaps past 180° then settles
   This gives the "slap" of a hard flip with a premium landing. */
function cinematicHard(t) {
  if(t < 0.5) {
    return easeInCubic(t * 2) * 0.5;
  } else {
    var t2 = (t - 0.5) * 2; /* 0→1 for second phase */
    return 0.5 + easeOutBack(t2, 1.8) * 0.5;
  }
}

function lerp(a, b, t) { return a + (b - a) * t; }
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

/* ============================================================
   PROGRESSIVE IMAGE LOADER
   Blur-up: image starts blurred and sharpens on load.
   Returns a cancel function.
   ============================================================ */
var _loadCache = {};

function loadImg(el, src, onDone) {
  if(!src || !el) return;

  /* Already loaded into this element with same src */
  if(el.dataset.loadedSrc === src) {
    if(onDone) onDone();
    return;
  }

  /* Apply blur-up state */
  el.classList.remove('img-ready');
  el.classList.add('img-loading');

  /* If already in browser cache just apply it */
  if(_loadCache[src]) {
    el.style.backgroundImage = "url('" + src + "')";
    el.dataset.loadedSrc = src;
    requestAnimationFrame(function(){
      el.classList.remove('img-loading');
      el.classList.add('img-ready');
      if(onDone) onDone();
    });
    return;
  }

  var img = new Image();
  img.onload = function() {
    _loadCache[src] = true;
    /* Only apply if element still wants this src
       (user may have navigated away during load) */
    if(el.dataset.wantSrc === src) {
      el.style.backgroundImage = "url('" + src + "')";
      el.dataset.loadedSrc = src;
      requestAnimationFrame(function(){
        el.classList.remove('img-loading');
        el.classList.add('img-ready');
        if(onDone) onDone();
      });
    }
  };
  img.onerror = function() {
    /* Placeholder pattern for missing pages */
    el.style.backgroundImage =
      'repeating-linear-gradient(45deg,' +
      'rgba(212,160,23,0.04) 0px,rgba(212,160,23,0.04) 1px,' +
      'transparent 1px,transparent 10px),' +
      'linear-gradient(#0f0f0f,#0f0f0f)';
    el.classList.remove('img-loading');
    el.classList.add('img-ready');
  };

  el.dataset.wantSrc = src;
  img.src = src;
}

/* Silent background preload */
function preload(src) {
  if(!src || _loadCache[src]) return;
  var img = new Image();
  img.onload = function(){ _loadCache[src] = true; };
  img.src = src;
}

/* Preload a window around current index */
function preloadWindow(idx) {
  /* 3 ahead, 2 behind */
  for(var d = -2; d <= 3; d++) {
    var i = idx + d;
    if(i >= 0 && i < PAGES.length) preload(PAGES[i].src);
  }
}

/* ============================================================
   FLIP ENGINE
   ============================================================ */
var Flip = (function(){

  /* ── State ───────────────────────────────────────────────── */
  var cur    = 0;
  var busy   = false;
  var rafId  = null;

  /* Cinematic duration: slow and dramatic */
  var FLIP_MS = 780;

  /* ── DOM ─────────────────────────────────────────────────── */
  var $book     = document.getElementById('book');
  var $scene    = document.getElementById('book-scene');
  var $stage    = document.getElementById('stage');
  var $under    = document.getElementById('pg-under');
  var $curr     = document.getElementById('pg-curr');
  var $flipper  = document.getElementById('flipper');
  var $ffront   = document.getElementById('flip-front');
  var $fback    = document.getElementById('flip-back');
  var $btnBack  = document.getElementById('btn-back');
  var $btnFwd   = document.getElementById('btn-fwd');
  var $counter  = document.getElementById('counter');
  var $dots     = document.getElementById('dots-track');

  /* ── Sizing ──────────────────────────────────────────────── */
  /* Each page is A4 landscape: 297×210mm ≈ 1.414:1
     User's actual images: 3309×2367 ≈ 1.398:1          */
  var PAGE_W_H = 3309 / 2367;

  function resize() {
    var sw = $stage.clientWidth  - 20;
    var sh = $stage.clientHeight - 20;
    var W  = Math.min(sw, sh * PAGE_W_H);
    var H  = W / PAGE_W_H;
    if(H > sh){ H = sh; W = H * PAGE_W_H; }
    W = Math.round(W); H = Math.round(H);
    $scene.style.width  = W + 'px';
    $scene.style.height = H + 'px';
    $book.style.width   = W + 'px';
    $book.style.height  = H + 'px';
    _W = W; _H = H;
  }

  var _W = 0, _H = 0;

  /* ── UI Updater ──────────────────────────────────────────── */
  var MAX_DOTS = 17;
  var DOT_PX   = 12; /* dot + gap */

  function updateUI(idx) {
    var p = PAGES[idx];
    $counter.textContent = (idx + 1) + ' / ' + PAGES.length + '  ·  ' + p.label;
    $btnBack.disabled = (idx === 0);
    $btnFwd.disabled  = (idx === PAGES.length - 1);

    /* Dots */
    var all = $dots.querySelectorAll('.dot');
    all.forEach(function(d, i){
      d.className = 'dot' +
        (i === idx              ? ' active' :
         Math.abs(i - idx) < 3 ? ' near'   : '');
    });

    /* Slide dot strip */
    if(PAGES.length > MAX_DOTS) {
      var half   = Math.floor(MAX_DOTS / 2);
      var offset = clamp(idx - half, 0, PAGES.length - MAX_DOTS);
      $dots.style.transform = 'translateX(' + (-offset * DOT_PX) + 'px)';
    }
  }

  /* ── Show page (no animation) ────────────────────────────── */
  function showPage(idx) {
    cur = clamp(idx, 0, PAGES.length - 1);
    loadImg($curr, PAGES[cur].src);
    $under.style.backgroundImage = '';
    $under.dataset.loadedSrc = '';
    updateUI(cur);
    preloadWindow(cur);
  }

  /* ── Hard Flip ───────────────────────────────────────────── */
  /*
    RTL Arabic hard flip:
    FORWARD (dir +1): page turns from LEFT hinge toward the RIGHT
      — this is "forward" in an Arabic book
      transform-origin: left center
      rotateY: 0 → +180 (peels right)

    BACKWARD (dir -1): page turns from RIGHT hinge toward the LEFT
      transform-origin: right center
      rotateY: 0 → -180 (peels left)

    The "hard" character:
    - Card stays FLAT (no curl, no perspective distortion on faces)
    - Sharp gloss stripe sweeps across at ~50% rotation
    - easeOutBack overshoot: card snaps 5–8° past vertical then settles
    - Scale micro-lift: book very subtly scales up 1.5% at start,
      settling back as the flip lands — gives a "picked up" feel
    - fromDrag: if we're continuing from a drag, start at dragAngle
  */
  function flip(dir, fromDrag, dragAngle) {
    if(busy) return false;
    var next = cur + dir;
    if(next < 0 || next >= PAGES.length) return false;

    busy = true;
    if(rafId) cancelAnimationFrame(rafId);

    var fromLeft   = (dir > 0);
    var startAngle = fromDrag ? dragAngle : 0;
    var endAngle   = fromLeft ? 180 : -180;
    var progress0  = Math.abs(startAngle) / 180; /* 0–1 already completed */

    /* Prepare under-page (destination) */
    loadImg($under, PAGES[next].src);

    /* Prepare flipper faces */
    $ffront.style.backgroundImage = $curr.style.backgroundImage || '';
    $ffront.dataset.loadedSrc     = PAGES[cur].src;
    $ffront.classList.remove('img-loading');
    $ffront.classList.add('img-ready');

    $fback.style.backgroundImage  = '';
    $fback.dataset.loadedSrc      = '';
    loadImg($fback, PAGES[next].src);

    /* Hinge */
    $flipper.style.transformOrigin = fromLeft ? 'left center' : 'right center';
    $flipper.style.display = 'block';
    $flipper.style.transform = 'rotateY(' + startAngle + 'deg)';

    /* How long is the remaining animation? Shorten if drag already covered ground */
    var remaining = 1 - progress0;
    var duration  = FLIP_MS * remaining;
    /* Minimum 220ms so it never feels instant */
    duration = Math.max(duration, 220);

    /* Hide curr so only flipper shows during animation */
    $curr.style.opacity = '0';

    var startTime = null;

    function step(ts) {
      if(!startTime) startTime = ts;
      var elapsed = ts - startTime;
      var rawT    = clamp(elapsed / duration, 0, 1);

      /* Ease: cinematic hard — fast out, snap landing */
      var easedT  = cinematicHard(rawT);
      var angle   = lerp(startAngle, endAngle, easedT);

      $flipper.style.transform = 'rotateY(' + angle + 'deg)';

      /* Gloss sweep: peaks exactly at 90° (halfway) */
      var absAngle   = Math.abs(angle);
      var flipFrac   = absAngle / 180; /* 0→1 */
      var glossPeak  = 1 - Math.abs(flipFrac - 0.5) * 4; /* 0→1→0 centred at 50% */
      glossPeak      = clamp(glossPeak, 0, 1);

      /* Gloss on front face (0→90°) */
      if(absAngle <= 90) {
        var pos = (flipFrac * 2) * 100; /* 0→100% as it goes to 90° */
        _setGloss($ffront, glossPeak * 0.7, pos);
        _setEdgeShadow($ffront, flipFrac * 2, fromLeft);
        _setGloss($fback, 0, 0);
      } else {
        /* Back face visible (90→180°) */
        var backFrac = (flipFrac - 0.5) * 2; /* 0→1 as it goes 90→180° */
        var backPos  = backFrac * 100;
        _setGloss($fback,  glossPeak * 0.5, backPos);
        _setEdgeShadow($fback, (1 - backFrac) * 0.8, !fromLeft);
        _setGloss($ffront, 0, 0);
      }

      /* Micro-lift scale: 1.0 → 1.015 at 20% → 1.0 */
      var liftT  = clamp(flipFrac / 0.2, 0, 1);
      var dropT  = clamp((flipFrac - 0.8) / 0.2, 0, 1);
      var lift   = fromLeft
        ? (liftT < 1 ? liftT : 1 - dropT) * 0.015
        : (liftT < 1 ? liftT : 1 - dropT) * 0.015;
      $book.style.transform = 'scale(' + (1 + lift) + ')';

      if(rawT < 1) {
        rafId = requestAnimationFrame(step);
      } else {
        _flipDone(next);
      }
    }

    rafId = requestAnimationFrame(step);
    return true;
  }

  function _setGloss(face, opacity, posPercent) {
    face.style.setProperty('--gloss-opacity', opacity);
    /* We animate via direct style for performance */
    if(face._glossEl) {
      face._glossEl.style.opacity         = opacity;
      face._glossEl.style.backgroundPosition = posPercent + '% 0';
    }
  }

  function _setEdgeShadow(face, opacity, onLeft) {
    if(face._edgeEl) {
      face._edgeEl.style.opacity = opacity;
    }
  }

  function _flipDone(next) {
    /* Transfer back face image to curr */
    $curr.style.backgroundImage = $fback.style.backgroundImage;
    $curr.dataset.loadedSrc     = PAGES[next].src;
    $curr.classList.remove('img-loading');
    $curr.classList.add('img-ready');
    $curr.style.opacity = '1';

    /* Reset */
    $flipper.style.display    = 'none';
    $flipper.style.transform  = 'rotateY(0deg)';
    $book.style.transform     = 'scale(1)';
    _clearGloss($ffront);
    _clearGloss($fback);

    $under.style.backgroundImage = '';
    $under.dataset.loadedSrc     = '';

    cur  = next;
    busy = false;
    updateUI(cur);
    preloadWindow(cur);
  }

  function _clearGloss(face) {
    if(face._glossEl) face._glossEl.style.opacity = 0;
    if(face._edgeEl)  face._edgeEl.style.opacity  = 0;
  }

  /* ── Snap Back (drag released without enough momentum) ────── */
  function snapBack(currentAngle, dir) {
    var SNAP_MS = 320;
    var start   = null;
    busy = true;

    function step(ts) {
      if(!start) start = ts;
      var t   = clamp((ts - start) / SNAP_MS, 0, 1);
      var e   = easeOutCubic(t);
      var deg = currentAngle * (1 - e);
      $flipper.style.transform = 'rotateY(' + deg + 'deg)';
      _setGloss($ffront, 0, 0);
      _setGloss($fback,  0, 0);
      if(t < 1) {
        rafId = requestAnimationFrame(step);
      } else {
        $flipper.style.display   = 'none';
        $flipper.style.transform = 'rotateY(0deg)';
        $curr.style.opacity      = '1';
        $book.style.transform    = 'scale(1)';
        $under.style.backgroundImage = '';
        busy = false;
      }
    }
    rafId = requestAnimationFrame(step);
  }

  /* ── Drag ────────────────────────────────────────────────── */
  var _drag = {
    active:     false,
    dir:        0,
    startX:     0,
    lastX:      0,
    lastT:      0,
    velX:       0,
    angle:      0,
    threshold:  0,
    ready:      false   /* flipper set up */
  };

  function _dragStart(clientX) {
    if(busy) return;
    _drag.active  = true;
    _drag.startX  = clientX;
    _drag.lastX   = clientX;
    _drag.lastT   = performance.now();
    _drag.velX    = 0;
    _drag.dir     = 0;
    _drag.angle   = 0;
    _drag.ready   = false;
  }

  function _dragMove(clientX) {
    if(!_drag.active || busy) return;
    var now = performance.now();
    var dt  = now - _drag.lastT;
    if(dt > 0) _drag.velX = (clientX - _drag.lastX) / dt; /* px/ms */
    _drag.lastX = clientX;
    _drag.lastT = now;

    var dx = clientX - _drag.startX;

    /* Determine direction on first 10px of movement */
    if(_drag.dir === 0) {
      if(Math.abs(dx) < 10) return;
      /* RTL: drag RIGHT (+dx) = forward (next page)
              drag LEFT  (-dx) = backward (prev page) */
      _drag.dir = dx > 0 ? 1 : -1;
      var next = cur + _drag.dir;
      if(next < 0 || next >= PAGES.length) {
        _drag.active = false;
        return;
      }

      /* Set up flipper for live drag */
      var fromLeft = (_drag.dir > 0);
      loadImg($under, PAGES[next].src);
      $ffront.style.backgroundImage = $curr.style.backgroundImage || '';
      $ffront.dataset.loadedSrc     = PAGES[cur].src;
      $ffront.classList.add('img-ready');
      loadImg($fback, PAGES[next].src);
      $flipper.style.transformOrigin = fromLeft ? 'left center' : 'right center';
      $flipper.style.display = 'block';
      $curr.style.opacity = '0';
      _drag.ready = true;
      _drag.threshold = _W * 0.20;
    }

    if(!_drag.ready) return;

    /* Map drag distance to angle (max 165° while dragging) */
    var fromLeft2 = _drag.dir > 0;
    var raw       = dx * _drag.dir; /* always positive in drag direction */
    var frac      = clamp(raw / (_W * 0.65), 0, 0.92);
    var angle     = fromLeft2 ? frac * 180 : -frac * 180;
    _drag.angle   = angle;

    $flipper.style.transform = 'rotateY(' + angle + 'deg)';

    /* Gloss during drag */
    var flipFrac = Math.abs(angle) / 180;
    var glossPeak = 1 - Math.abs(flipFrac - 0.5) * 4;
    glossPeak = clamp(glossPeak, 0, 1);
    if(flipFrac <= 0.5) {
      _setGloss($ffront, glossPeak * 0.6, flipFrac * 200);
    } else {
      _setGloss($fback,  glossPeak * 0.5, (flipFrac - 0.5) * 200);
      _setGloss($ffront, 0, 0);
    }
  }

  function _dragEnd(clientX) {
    if(!_drag.active) return;
    _drag.active = false;

    if(!_drag.ready || _drag.dir === 0) return;

    var dx        = clientX - _drag.startX;
    var moved     = Math.abs(dx) > _drag.threshold;
    var fast      = Math.abs(_drag.velX) > 0.28; /* px/ms */
    var progress  = Math.abs(_drag.angle) / 180;

    if(moved || (fast && progress > 0.10)) {
      /* Commit — continue animation from current drag angle */
      busy = false;
      flip(_drag.dir, true, _drag.angle);
    } else {
      /* Snap back */
      snapBack(_drag.angle, _drag.dir);
      _clearGloss($ffront);
      _clearGloss($fback);
    }
    _drag.dir = 0;
  }

  /* ── Jump (instant, no animation) ───────────────────────── */
  function jumpTo(idx) {
    if(busy) return;
    idx = clamp(idx, 0, PAGES.length - 1);
    showPage(idx);
  }

  /* ── Bind gloss/edge overlay elements ────────────────────── */
  /* We inject dedicated overlay divs into each face so we can
     animate them without touching background-image or filter */
  function _buildOverlays() {
    [$ffront, $fback].forEach(function(face){
      var gloss = document.createElement('div');
      gloss.style.cssText =
        'position:absolute;inset:0;pointer-events:none;z-index:3;' +
        'background:linear-gradient(105deg,' +
        'transparent 25%,rgba(255,255,255,0.06) 44%,' +
        'rgba(255,255,255,0.11) 50%,rgba(255,255,255,0.06) 56%,transparent 75%);' +
        'background-size:200% 100%;opacity:0;' +
        'border-radius:3px;';
      face._glossEl = gloss;
      face.appendChild(gloss);

      var edge = document.createElement('div');
      edge.style.cssText =
        'position:absolute;top:0;width:36px;height:100%;' +
        'pointer-events:none;z-index:2;opacity:0;border-radius:3px;';
      face._edgeEl = edge;
      face.appendChild(edge);
    });

    /* front: shadow on right edge; back: shadow on left edge */
    $ffront._edgeEl.style.right = '0';
    $ffront._edgeEl.style.background =
      'linear-gradient(to left,rgba(0,0,0,0.45),transparent)';
    $fback._edgeEl.style.left = '0';
    $fback._edgeEl.style.background =
      'linear-gradient(to right,rgba(0,0,0,0.4),transparent)';
  }

  /* ── Tilt (3D hover tilt on desktop) ─────────────────────── */
  var _tilt = {x:0, y:0, tx:0, ty:0, raf:null};
  var MAX_TILT = 3.5;

  function _tiltFrame() {
    _tilt.x = lerp(_tilt.x, _tilt.tx, 0.07);
    _tilt.y = lerp(_tilt.y, _tilt.ty, 0.07);
    if(!busy) {
      $book.style.transform =
        'perspective(1800px) rotateX(' + _tilt.y + 'deg) rotateY(' + _tilt.x + 'deg)';
    }
    var moving = Math.abs(_tilt.x-_tilt.tx)>0.01 || Math.abs(_tilt.y-_tilt.ty)>0.01;
    _tilt.raf = moving ? requestAnimationFrame(_tiltFrame) : null;
  }

  /* ── Public API ──────────────────────────────────────────── */
  return {
    init: function() {
      _buildOverlays();
      resize();
      showPage(0);
      window.addEventListener('resize', resize);

      /* Build dots */
      var track = $dots;
      track.innerHTML = '';
      PAGES.forEach(function(_, i){
        var d = document.createElement('div');
        d.className = 'dot';
        d.addEventListener('click', function(){ jumpTo(i); });
        track.appendChild(d);
      });
      updateUI(0);

      /* Bind drag — touch */
      $book.addEventListener('touchstart', function(e){
        _dragStart(e.touches[0].clientX);
      }, {passive:true});
      $book.addEventListener('touchmove', function(e){
        _dragMove(e.touches[0].clientX);
        if(_drag.dir !== 0) e.preventDefault();
      }, {passive:false});
      $book.addEventListener('touchend', function(e){
        _dragEnd(e.changedTouches[0].clientX);
      }, {passive:true});
      $book.addEventListener('touchcancel', function(e){
        _dragEnd(e.changedTouches[0].clientX);
      }, {passive:true});

      /* Bind drag — mouse */
      $book.addEventListener('mousedown', function(e){
        _dragStart(e.clientX);
        e.preventDefault();
      });
      document.addEventListener('mousemove', function(e){
        _dragMove(e.clientX);
      });
      document.addEventListener('mouseup', function(e){
        _dragEnd(e.clientX);
      });

      /* Tilt — pointer move (desktop only) */
      document.addEventListener('pointermove', function(e){
        if(e.pointerType === 'touch' || busy) return;
        var cx = window.innerWidth  / 2;
        var cy = window.innerHeight / 2;
        _tilt.tx = ((e.clientX - cx) / cx) * MAX_TILT;
        _tilt.ty = -((e.clientY - cy) / cy) * MAX_TILT;
        if(!_tilt.raf) _tilt.raf = requestAnimationFrame(_tiltFrame);
      });
      document.addEventListener('mouseleave', function(){
        _tilt.tx = 0; _tilt.ty = 0;
        if(!_tilt.raf) _tilt.raf = requestAnimationFrame(_tiltFrame);
      });

      /* Arrow buttons */
      document.getElementById('btn-back').addEventListener('click', function(){
        flip(-1, false, 0);
      });
      document.getElementById('btn-fwd').addEventListener('click', function(){
        flip(1, false, 0);
      });

      /* Keyboard */
      document.addEventListener('keydown', function(e){
        var si = document.getElementById('search-input');
        if(document.activeElement === si) return;
        if(e.key==='ArrowLeft'  || e.key==='ArrowDown')  flip(1,  false, 0);
        if(e.key==='ArrowRight' || e.key==='ArrowUp')    flip(-1, false, 0);
        if(e.key==='f' || e.key==='F') WG.toggleFS();
      });
    },

    flip:   flip,
    jumpTo: jumpTo,
    get cur(){ return cur; }
  };

}());

/* ============================================================
   APP CONTROLLER
   ============================================================ */
var WG = (function(){

  /* ── Search ────────────────────────────────────────────── */
  function goToPage() {
    var input = document.getElementById('search-input');
    var val   = parseInt(input.value, 10);
    input.value = '';
    input.blur();
    if(isNaN(val) || val < 1 || val > PAGES.length) {
      showToast('Enter a number between 1 and ' + PAGES.length);
      return;
    }
    Flip.jumpTo(val - 1);
  }

  /* ── Toast ──────────────────────────────────────────────── */
  var _tt = null;
  function showToast(msg) {
    var t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(_tt);
    _tt = setTimeout(function(){ t.classList.remove('show'); }, 2600);
  }

  /* ── Fullscreen ─────────────────────────────────────────── */
  function toggleFS() {
    var el = document.documentElement;
    var inFS = document.fullscreenElement || document.webkitFullscreenElement;
    if(!inFS) {
      (el.requestFullscreen || el.webkitRequestFullscreen || function(){}). call(el);
    } else {
      (document.exitFullscreen || document.webkitExitFullscreen || function(){}).call(document);
    }
  }
  ['fullscreenchange','webkitfullscreenchange'].forEach(function(ev){
    document.addEventListener(ev, function(){
      var inFS = document.fullscreenElement || document.webkitFullscreenElement;
      document.getElementById('fs-label').textContent = inFS ? 'Exit' : 'Full';
    });
  });

  /* ── How-to ─────────────────────────────────────────────── */
  function closeHowTo() {
    document.getElementById('howto').classList.remove('show');
    try{ localStorage.setItem('wg_catalog_seen','1'); }catch(e){}
  }

  /* ── Background image detect ────────────────────────────── */
  function detectBg() {
    var img = new Image();
    img.onload = function(){
      document.getElementById('bg-layer').classList.add('with-image');
    };
    img.src = 'bg.jpg';
  }

  /* ── Loader out ─────────────────────────────────────────── */
  function initLoader() {
    window.addEventListener('load', function(){
      setTimeout(function(){
        var l = document.getElementById('loader');
        l.classList.add('out');
        setTimeout(function(){
          l.remove();
          try{
            if(!localStorage.getItem('wg_catalog_seen')){
              document.getElementById('howto').classList.add('show');
            }
          }catch(e){}
        }, 850);
      }, 1000);
    });
  }

  /* ── Init ───────────────────────────────────────────────── */
  document.addEventListener('DOMContentLoaded', function(){
    detectBg();
    Flip.init();
    initLoader();

    /* Wire search */
    document.getElementById('search-go').addEventListener('click', goToPage);
    document.getElementById('search-input').addEventListener('keydown', function(e){
      if(e.key === 'Enter') goToPage();
    });

    /* Wire how-to close */
    document.getElementById('hw-close').addEventListener('click', closeHowTo);
  });

  return {
    toggleFS:   toggleFS,
    closeHowTo: closeHowTo,
    goToPage:   goToPage,
    showToast:  showToast
  };

}());
