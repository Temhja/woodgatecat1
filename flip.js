/* ═══════════════════════════════════════════════════════════════════
   WoodGate FlipEngine v2.0  —  flip.js
   ═══════════════════════════════════════════════════════════════════
   Features:
   • Physics-based ease with overshoot spring on landing
   • Drag-to-flip: follow finger, release with momentum
   • 3D perspective tilt tracking on pointer move
   • Progressive JPG loading: blur-up reveal
   • Fold shadow that moves with the curl angle
   • RTL Arabic page order (right-to-left reading)
   ═══════════════════════════════════════════════════════════════════ */

(function (global) {
  'use strict';

  /* ── EASING ──────────────────────────────────────────────────── */
  function easeOutCubic(t)  { return 1 - Math.pow(1 - t, 3); }
  function easeInOutQuart(t){ return t < 0.5 ? 8*t*t*t*t : 1 - Math.pow(-2*t+2,4)/2; }

  /* Spring overshoot on landing — gives the page a satisfying bounce */
  function easeOutBack(t) {
    const c1 = 1.4;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  }

  /* Blend ease based on flip speed */
  function blendEase(t, fast) {
    return fast ? easeOutCubic(t) : easeOutBack(t);
  }

  /* ── LERP ────────────────────────────────────────────────────── */
  function lerp(a, b, t) { return a + (b - a) * t; }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  /* ── IMAGE LOADER WITH PROGRESSIVE BLUR-UP ───────────────────── */
  function loadImage(el, src) {
    if (!src) return;
    el.classList.add('loading');
    el.style.backgroundImage = '';

    const img = new Image();
    img.onload = function () {
      el.style.backgroundImage = "url('" + src + "')";
      /* requestAnimationFrame ensures paint happens before class swap */
      requestAnimationFrame(function () {
        el.classList.remove('loading');
        el.classList.add('loaded');
      });
    };
    img.onerror = function () {
      /* Show a placeholder pattern if image missing */
      el.style.backgroundImage =
        'repeating-linear-gradient(45deg,' +
        'rgba(212,160,23,0.06) 0px,rgba(212,160,23,0.06) 1px,' +
        'transparent 1px,transparent 8px)';
      el.classList.remove('loading');
      el.classList.add('loaded');
    };
    img.src = src;
  }

  /* Preload without showing */
  function preloadSrc(src) {
    if (!src || preloadSrc._cache[src]) return;
    preloadSrc._cache[src] = true;
    const img = new Image();
    img.src = src;
  }
  preloadSrc._cache = {};

  /* ── FLIP ENGINE ─────────────────────────────────────────────── */
  function FlipEngine(config) {
    this.pages    = config.pages;    /* array of {src, label} */
    this.onRender = config.onRender; /* callback(index) for UI updates */

    this.cur    = 0;
    this.busy   = false;
    this.rafId  = null;

    /* DOM */
    this.$book      = document.getElementById('book');
    this.$flipper   = document.getElementById('flipper');
    this.$flipFront = document.getElementById('flip-front');
    this.$flipBack  = document.getElementById('flip-back');
    this.$pageCurr  = document.getElementById('page-curr');
    this.$pageNext  = document.getElementById('page-next');
    this.$pagePrev  = document.getElementById('page-prev');
    this.$foldShad  = document.getElementById('fold-shadow');
    this.$scene     = document.getElementById('book-scene');
    this.$stage     = document.getElementById('stage');

    /* Drag state */
    this._drag = {
      active:    false,
      startX:    0,
      startY:    0,
      lastX:     0,
      lastT:     0,
      velX:      0,
      dir:       0,     /* +1 forward, -1 back */
      threshold: 0,     /* px needed to commit flip */
    };

    /* Tilt state (3D book tilt on pointer move) */
    this._tilt = { x: 0, y: 0, targetX: 0, targetY: 0 };
    this._tiltRaf = null;

    this._bindDrag();
    this._bindTilt();
    this._preloadWindow(0);
  }

  /* ── SIZE ────────────────────────────────────────────────────── */
  FlipEngine.prototype.resize = function () {
    const stage  = this.$stage;
    const availW = stage.clientWidth  - 20;
    const availH = stage.clientHeight - 24;

    /* Each page is ONE A4 landscape image: 297×210mm = 1.414:1 ratio
       Use the exact pixel ratio of the user's images: 3309×2367 ≈ 1.398:1 */
    const PAGE_RATIO = 3309 / 2367; /* width / height ≈ 1.398 */

    let W = Math.min(availW, availH * PAGE_RATIO);
    let H = W / PAGE_RATIO;
    if (H > availH) { H = availH; W = H * PAGE_RATIO; }

    W = Math.round(W);
    H = Math.round(H);

    this.$scene.style.width  = W + 'px';
    this.$scene.style.height = H + 'px';
    this.$book.style.width   = W + 'px';
    this.$book.style.height  = H + 'px';

    this._drag.threshold = W * 0.18; /* 18% of page width to commit */
    this._W = W;
    this._H = H;
  };

  /* ── RENDER PAGE ─────────────────────────────────────────────── */
  FlipEngine.prototype.showPage = function (idx) {
    const page = this.pages[idx];
    if (!page) return;
    loadImage(this.$pageCurr, page.src);
    this.cur = idx;
    if (this.onRender) this.onRender(idx);
    this._preloadWindow(idx);
  };

  FlipEngine.prototype._preloadWindow = function (idx) {
    /* Preload 2 ahead and 1 behind */
    for (let d = -1; d <= 2; d++) {
      const p = this.pages[idx + d];
      if (p) preloadSrc(p.src);
    }
  };

  /* ── PROGRAMMATIC FLIP ───────────────────────────────────────── */
  /*
    RTL Arabic flip mechanics:
    ─────────────────────────────────────────────────────────────────
    Each page is full screen. Turning FORWARD (next page):
      The current page peels from the LEFT edge toward the RIGHT.
      Hinge = LEFT edge → transform-origin: left center
      Rotation: 0deg → +180deg  (peels rightward = RTL forward)

    Turning BACKWARD (prev page):
      The current page peels from the RIGHT edge toward the LEFT.
      Hinge = RIGHT edge → transform-origin: right center
      Rotation: 0deg → -180deg  (peels leftward)

    Front face (#flip-front) = current page (going away)
    Back  face (#flip-back)  = destination page (coming in)
    Static #page-next shows destination page underneath flipper.
  */
  FlipEngine.prototype.flip = function (dir, fromDrag, dragProgress) {
    if (this.busy) return false;
    const next = this.cur + dir;
    if (next < 0 || next >= this.pages.length) return false;

    this.busy = true;
    const self = this;
    const curPage  = this.pages[this.cur];
    const nextPage = this.pages[next];

    /* Prepare destination visible behind flipper */
    loadImage(this.$pageNext, nextPage.src);
    this.$pageNext.style.zIndex = 2;
    this.$pageCurr.style.zIndex = 3;

    /* Set flipper faces */
    this.$flipFront.style.backgroundImage = this.$pageCurr.style.backgroundImage;
    this.$flipFront.style.backgroundSize  = 'cover';
    this.$flipFront.style.backgroundPosition = 'center';
    this.$flipBack.style.backgroundImage  = '';
    loadImage(this.$flipBack, nextPage.src);

    /* Hinge side */
    const fromLeft = (dir > 0);
    this.$flipper.style.transformOrigin = fromLeft ? 'left center' : 'right center';
    this.$flipper.style.display = 'block';

    /* Fold shadow side */
    this.$foldShad.style.display = 'block';
    this.$foldShad.style[fromLeft ? 'left' : 'right'] = '0';
    this.$foldShad.style[fromLeft ? 'right' : 'left'] = 'auto';

    /* Start angle: if dragging, pick up from drag progress */
    const startDeg = fromDrag ? (fromLeft ? dragProgress * 180 : -dragProgress * 180) : 0;
    const endDeg   = fromLeft ? 180 : -180;
    const FAST     = Math.abs(startDeg) > 30; /* already started = faster ease */
    const DURATION = FAST
      ? Math.max(200, 420 * (1 - Math.abs(startDeg) / 180))
      : 480;

    let startTime = null;

    function step(ts) {
      if (!startTime) startTime = ts;
      const elapsed = ts - startTime;
      const rawT    = Math.min(elapsed / DURATION, 1);
      const easedT  = blendEase(rawT, FAST);

      const deg     = lerp(startDeg, endDeg, easedT);
      const absDeg  = Math.abs(deg);
      const progress= absDeg / 180; /* 0→1 over the flip */

      /* Brightness dips at the middle (page perpendicular to viewer) */
      const midDip  = Math.sin(progress * Math.PI);
      const bright  = 1 - midDip * 0.42;
      const cont    = 1 + midDip * 0.08;

      self.$flipper.style.transform = 'rotateY(' + deg + 'deg)';
      self.$flipper.style.filter    = 'brightness(' + bright + ') contrast(' + cont + ')';

      /* Fold shadow moves with the hinge */
      const shadOpacity = Math.sin(progress * Math.PI) * 0.9;
      self.$foldShad.style.opacity = shadOpacity;

      /* Curl highlight on leading edge */
      const hlOpacity = Math.sin(progress * Math.PI) * 0.7;
      self.$flipFront.style.setProperty('--curl-opacity', hlOpacity);
      if (self.$flipFront.firstElementChild) {
        self.$flipFront.firstElementChild.style.opacity = hlOpacity;
      }

      if (rawT < 1) {
        self.rafId = requestAnimationFrame(step);
      } else {
        self._flipDone(next, dir);
      }
    }

    this.rafId = requestAnimationFrame(step);
    return true;
  };

  FlipEngine.prototype._flipDone = function (next, dir) {
    this.$flipper.style.display  = 'none';
    this.$flipper.style.filter   = 'none';
    this.$foldShad.style.display = 'none';
    this.$pageNext.style.zIndex  = 2;

    /* Swap: next page becomes current */
    const nextBg = this.$pageNext.style.backgroundImage;
    this.$pageCurr.style.backgroundImage = nextBg;
    this.$pageCurr.classList.remove('loading');
    this.$pageCurr.classList.add('loaded');
    this.$pageNext.style.backgroundImage = '';

    this.cur  = next;
    this.busy = false;
    if (this.onRender) this.onRender(next);
    this._preloadWindow(next);
  };

  /* Abort a drag that didn't go far enough — spring back */
  FlipEngine.prototype._snapBack = function (currentDeg, fromLeft) {
    const self = this;
    const DURATION = 280;
    let startTime = null;

    function step(ts) {
      if (!startTime) startTime = ts;
      const t   = Math.min((ts - startTime) / DURATION, 1);
      const e   = easeOutCubic(t);
      const deg = lerp(currentDeg, 0, e);
      self.$flipper.style.transform = 'rotateY(' + deg + 'deg)';
      self.$foldShad.style.opacity  = (1 - t) * 0.5;
      if (t < 1) {
        self.rafId = requestAnimationFrame(step);
      } else {
        self.$flipper.style.display  = 'none';
        self.$foldShad.style.display = 'none';
        self.busy = false;
      }
    }
    requestAnimationFrame(step);
  };

  /* ── DRAG INTERACTION ────────────────────────────────────────── */
  FlipEngine.prototype._bindDrag = function () {
    const self   = this;
    const el     = this.$book;
    const d      = this._drag;

    function onStart(clientX, clientY) {
      if (self.busy) return;
      d.active  = true;
      d.startX  = clientX;
      d.startY  = clientY;
      d.lastX   = clientX;
      d.lastT   = performance.now();
      d.velX    = 0;
      d.dir     = 0;
    }

    function onMove(clientX) {
      if (!d.active || self.busy) return;
      const dx   = clientX - d.startX;
      const now  = performance.now();
      const dt   = now - d.lastT;

      /* velocity in px/ms */
      if (dt > 0) d.velX = (clientX - d.lastX) / dt;
      d.lastX = clientX;
      d.lastT = now;

      if (d.dir === 0) {
        /* Determine direction once we have 8px of movement */
        if (Math.abs(dx) < 8) return;
        /* RTL: drag RIGHT (+dx) = forward, drag LEFT (-dx) = backward */
        d.dir = dx > 0 ? 1 : -1;
        const next = self.cur + d.dir;
        if (next < 0 || next >= self.pages.length) { d.active = false; return; }

        /* Set up flipper for live drag */
        self.busy = true;
        const nextPage = self.pages[next];
        loadImage(self.$pageNext, nextPage.src);
        self.$pageNext.style.zIndex = 2;
        self.$flipFront.style.backgroundImage = self.$pageCurr.style.backgroundImage;
        self.$flipFront.style.backgroundSize  = 'cover';
        self.$flipFront.style.backgroundPosition = 'center';
        loadImage(self.$flipBack, nextPage.src);

        const fromLeft = (d.dir > 0);
        self.$flipper.style.transformOrigin = fromLeft ? 'left center' : 'right center';
        self.$flipper.style.display = 'block';
        self.$flipper.style.filter  = 'none';
        self.$foldShad.style.display = 'block';
        self.$foldShad.style[fromLeft ? 'left' : 'right'] = '0';
        self.$foldShad.style[fromLeft ? 'right' : 'left'] = 'auto';
      }

      if (d.dir === 0) return;

      /* Map drag distance → rotation (max 165deg while dragging) */
      const fromLeft  = d.dir > 0;
      const raw       = dx * d.dir; /* always positive while dragging in correct dir */
      const progress  = clamp(raw / (self._W * 0.7), 0, 0.92);
      const deg       = fromLeft ? progress * 180 : -progress * 180;

      const midDip = Math.sin(progress * Math.PI);
      self.$flipper.style.transform = 'rotateY(' + deg + 'deg)';
      self.$flipper.style.filter    =
        'brightness(' + (1 - midDip * 0.38) + ') contrast(' + (1 + midDip * 0.06) + ')';
      self.$foldShad.style.opacity  = midDip * 0.85;

      d.currentDeg = deg;
    }

    function onEnd(clientX) {
      if (!d.active) return;
      d.active = false;

      if (d.dir === 0) return; /* no real drag happened */

      const dx          = clientX - d.startX;
      const movedEnough = Math.abs(dx) > d.threshold;
      const fastEnough  = Math.abs(d.velX) > 0.3; /* px/ms */
      const progress    = Math.abs(d.currentDeg || 0) / 180;

      if (movedEnough || fastEnough) {
        /* Commit the flip */
        self.busy = false;
        self.flip(d.dir, true, progress);
      } else {
        /* Snap back */
        self._snapBack(d.currentDeg || 0, d.dir > 0);
        self.$pageNext.style.backgroundImage = '';
      }

      d.dir = 0;
      d.currentDeg = 0;
    }

    /* Touch */
    el.addEventListener('touchstart', function (e) {
      onStart(e.touches[0].clientX, e.touches[0].clientY);
    }, { passive: true });
    el.addEventListener('touchmove', function (e) {
      onMove(e.touches[0].clientX);
      /* Prevent scroll during horizontal drag */
      if (d.dir !== 0) e.preventDefault();
    }, { passive: false });
    el.addEventListener('touchend', function (e) {
      onEnd(e.changedTouches[0].clientX);
    }, { passive: true });
    el.addEventListener('touchcancel', function (e) {
      onEnd(e.changedTouches[0].clientX);
    }, { passive: true });

    /* Mouse (desktop) */
    el.addEventListener('mousedown', function (e) {
      onStart(e.clientX, e.clientY);
      e.preventDefault();
    });
    document.addEventListener('mousemove', function (e) {
      onMove(e.clientX);
    });
    document.addEventListener('mouseup', function (e) {
      onEnd(e.clientX);
    });
  };

  /* ── 3D TILT ─────────────────────────────────────────────────── */
  /*
    Subtle perspective tilt as the pointer moves across the screen.
    The book tilts toward the pointer — gives it a holographic feel.
    Only active when not flipping and on non-touch (pointer move).
  */
  FlipEngine.prototype._bindTilt = function () {
    const self  = this;
    const tilt  = this._tilt;
    const MAX   = 4; /* max degrees */

    function smoothTilt() {
      tilt.x = lerp(tilt.x, tilt.targetX, 0.08);
      tilt.y = lerp(tilt.y, tilt.targetY, 0.08);

      if (!self.busy) {
        self.$book.style.transform =
          'rotateX(' + tilt.y + 'deg) rotateY(' + tilt.x + 'deg)';
      }

      if (
        Math.abs(tilt.x - tilt.targetX) > 0.01 ||
        Math.abs(tilt.y - tilt.targetY) > 0.01
      ) {
        self._tiltRaf = requestAnimationFrame(smoothTilt);
      } else {
        self._tiltRaf = null;
      }
    }

    document.addEventListener('pointermove', function (e) {
      /* Only on non-touch to avoid interfering with swipe */
      if (e.pointerType === 'touch') return;
      if (self.busy) return;

      const cx = window.innerWidth  / 2;
      const cy = window.innerHeight / 2;
      tilt.targetX = ((e.clientX - cx) / cx) * MAX;
      tilt.targetY = -((e.clientY - cy) / cy) * MAX;

      if (!self._tiltRaf) self._tiltRaf = requestAnimationFrame(smoothTilt);
    });

    /* Reset tilt when pointer leaves */
    document.addEventListener('pointerleave', function () {
      tilt.targetX = 0;
      tilt.targetY = 0;
      if (!self._tiltRaf) self._tiltRaf = requestAnimationFrame(smoothTilt);
    });
  };

  /* ── JUMP (instant, no animation) ───────────────────────────── */
  FlipEngine.prototype.jumpTo = function (idx) {
    if (this.busy) return;
    if (idx < 0 || idx >= this.pages.length) return;
    this.showPage(idx);
  };

  /* ── EXPORT ──────────────────────────────────────────────────── */
  global.FlipEngine = FlipEngine;

}(window));


/* ═══════════════════════════════════════════════════════════════════
   APP CONTROLLER  —  initialises everything, wires up the UI
   ═══════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  /* ── PAGES ─────────────────────────────────────────────────────
     One entry per image file.
     Each image = ONE full A4 landscape page.
     Pages are shown one at a time — no two-page spreads on mobile.

     FILE NAMING:  pages/pg1.jpg  through  pages/pg40.jpg
     Add/remove lines to match your actual page count.
  ─────────────────────────────────────────────────────────────── */
  var PAGES = [
    { src: 'pages/pg1.jpg',  label: 'Cover' },
    { src: 'pages/pg2.jpg',  label: 'Page 2' },
    { src: 'pages/pg3.jpg',  label: 'Page 3' },
    /* UNCOMMENT YOUR PAGES — all 40 are ready:
    { src: 'pages/pg4.jpg',  label: 'Page 4' },
    { src: 'pages/pg5.jpg',  label: 'Page 5' },
    { src: 'pages/pg6.jpg',  label: 'Page 6' },
    { src: 'pages/pg7.jpg',  label: 'Page 7' },
    { src: 'pages/pg8.jpg',  label: 'Page 8' },
    { src: 'pages/pg9.jpg',  label: 'Page 9' },
    { src: 'pages/pg10.jpg', label: 'Page 10' },
    { src: 'pages/pg11.jpg', label: 'Page 11' },
    { src: 'pages/pg12.jpg', label: 'Page 12' },
    { src: 'pages/pg13.jpg', label: 'Page 13' },
    { src: 'pages/pg14.jpg', label: 'Page 14' },
    { src: 'pages/pg15.jpg', label: 'Page 15' },
    { src: 'pages/pg16.jpg', label: 'Page 16' },
    { src: 'pages/pg17.jpg', label: 'Page 17' },
    { src: 'pages/pg18.jpg', label: 'Page 18' },
    { src: 'pages/pg19.jpg', label: 'Page 19' },
    { src: 'pages/pg20.jpg', label: 'Page 20' },
    { src: 'pages/pg21.jpg', label: 'Page 21' },
    { src: 'pages/pg22.jpg', label: 'Page 22' },
    { src: 'pages/pg23.jpg', label: 'Page 23' },
    { src: 'pages/pg24.jpg', label: 'Page 24' },
    { src: 'pages/pg25.jpg', label: 'Page 25' },
    { src: 'pages/pg26.jpg', label: 'Page 26' },
    { src: 'pages/pg27.jpg', label: 'Page 27' },
    { src: 'pages/pg28.jpg', label: 'Page 28' },
    { src: 'pages/pg29.jpg', label: 'Page 29' },
    { src: 'pages/pg30.jpg', label: 'Page 30' },
    { src: 'pages/pg31.jpg', label: 'Page 31' },
    { src: 'pages/pg32.jpg', label: 'Page 32' },
    { src: 'pages/pg33.jpg', label: 'Page 33' },
    { src: 'pages/pg34.jpg', label: 'Page 34' },
    { src: 'pages/pg35.jpg', label: 'Page 35' },
    { src: 'pages/pg36.jpg', label: 'Page 36' },
    { src: 'pages/pg37.jpg', label: 'Page 37' },
    { src: 'pages/pg38.jpg', label: 'Page 38' },
    { src: 'pages/pg39.jpg', label: 'Page 39' },
    { src: 'pages/pg40.jpg', label: 'Back Cover' },
    */
  ];

  /* ── DOM REFS ──────────────────────────────────────────────── */
  var $counter  = document.getElementById('counter');
  var $dots     = document.getElementById('dots');
  var $btnBack  = document.getElementById('btn-back');
  var $btnFwd   = document.getElementById('btn-fwd');
  var $loader   = document.getElementById('loader');
  var $howto    = document.getElementById('howto');
  var $toast    = document.getElementById('toast');
  var $bg       = document.getElementById('bg');

  /* ── BACKGROUND ────────────────────────────────────────────── */
  /* Check if bg.jpg exists; if so, apply it */
  (function () {
    var img = new Image();
    img.onload = function () { $bg.classList.add('has-image'); };
    img.src = 'bg.jpg';
  }());

  /* ── FLIP ENGINE ───────────────────────────────────────────── */
  var engine = new FlipEngine({
    pages: PAGES,
    onRender: function (idx) {
      updateUI(idx);
    }
  });

  /* ── SIZING ────────────────────────────────────────────────── */
  engine.resize();
  window.addEventListener('resize', function () { engine.resize(); });

  /* ── UI UPDATER ────────────────────────────────────────────── */
  var MAX_DOTS = 15;
  var DOT_PX   = 13; /* dot width + gap */

  function updateUI(idx) {
    /* counter */
    var label = PAGES[idx].label || ('Page ' + (idx + 1));
    $counter.textContent = (idx + 1) + ' / ' + PAGES.length + '  ·  ' + label;

    /* buttons */
    $btnBack.disabled = (idx === 0);
    $btnFwd.disabled  = (idx === PAGES.length - 1);

    /* dots */
    var all = $dots.querySelectorAll('.dot');
    all.forEach(function (d, i) {
      d.className = 'dot' +
        (i === idx              ? ' on'   :
         Math.abs(i - idx) === 1 ? ' near' : '');
    });

    /* slide dot strip */
    if (PAGES.length > MAX_DOTS) {
      var offset = Math.max(0, Math.min(idx - Math.floor(MAX_DOTS / 2), PAGES.length - MAX_DOTS));
      $dots.style.transform = 'translateX(' + (-offset * DOT_PX) + 'px)';
    }
  }

  function buildDots() {
    $dots.innerHTML = '';
    PAGES.forEach(function (_, i) {
      var d = document.createElement('div');
      d.className = 'dot';
      d.addEventListener('click', function () { engine.jumpTo(i); });
      $dots.appendChild(d);
    });
  }

  /* ── ARROW BUTTONS ─────────────────────────────────────────── */
  /* RTL: right arrow (btn-fwd) = next page, left arrow (btn-back) = prev */
  $btnBack.addEventListener('click', function () { engine.flip(-1, false, 0); });
  $btnFwd.addEventListener('click',  function () { engine.flip(1,  false, 0); });

  /* ── KEYBOARD ──────────────────────────────────────────────── */
  /* RTL: ArrowLeft/Down = next, ArrowRight/Up = prev */
  document.addEventListener('keydown', function (e) {
    if (e.target === document.getElementById('search-input')) return;
    if (e.key === 'ArrowLeft'  || e.key === 'ArrowDown')  engine.flip(1,  false, 0);
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp')    engine.flip(-1, false, 0);
    if (e.key === 'f' || e.key === 'F') toggleFS();
  });

  /* ── SEARCH ────────────────────────────────────────────────── */
  window.goToPage = function () {
    var input = document.getElementById('search-input');
    var val   = parseInt(input.value, 10);
    input.value = '';
    input.blur();

    if (isNaN(val) || val < 1 || val > PAGES.length) {
      showToast('Enter a page number between 1 and ' + PAGES.length);
      return;
    }
    engine.jumpTo(val - 1);
  };

  /* ── TOAST ─────────────────────────────────────────────────── */
  var _toastTimer = null;
  function showToast(msg) {
    $toast.textContent = msg;
    $toast.classList.add('show');
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(function () {
      $toast.classList.remove('show');
    }, 2400);
  }
  /* expose for index.html inline use */
  window.showToast = showToast;

  /* ── FULLSCREEN ────────────────────────────────────────────── */
  window.toggleFS = function () {
    var el   = document.documentElement;
    var inFS = document.fullscreenElement || document.webkitFullscreenElement;
    if (!inFS) {
      (el.requestFullscreen || el.webkitRequestFullscreen || function () {}).call(el);
    } else {
      (document.exitFullscreen || document.webkitExitFullscreen || function () {}).call(document);
    }
  };

  ['fullscreenchange', 'webkitfullscreenchange'].forEach(function (ev) {
    document.addEventListener(ev, function () {
      var inFS = document.fullscreenElement || document.webkitFullscreenElement;
      document.getElementById('fs-label').textContent = inFS ? 'Exit' : 'Full';
    });
  });

  /* ── HOW-TO ────────────────────────────────────────────────── */
  window.closeHowTo = function () {
    $howto.classList.remove('show');
    try { localStorage.setItem('wg_seen', '1'); } catch (e) {}
  };

  /* ── INIT ──────────────────────────────────────────────────── */
  buildDots();
  engine.showPage(0);
  updateUI(0);

  /* Loader out after fonts + first image settle */
  window.addEventListener('load', function () {
    setTimeout(function () {
      $loader.classList.add('fade-out');
      setTimeout(function () {
        $loader.remove();
        try {
          if (!localStorage.getItem('wg_seen')) {
            $howto.classList.add('show');
          }
        } catch (e) {}
      }, 750);
    }, 900);
  });

}());
