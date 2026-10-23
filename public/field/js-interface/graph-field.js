/**
 * A(DAI) — graph-field (30k view: graph nodes bound to Shape of Time)
 *
 * The brand sketch (sketch-brand.js) renders the Shape of Time and exposes
 * window.__adaiDotRegistry — the canonical (x, y, radius) of every dot it
 * draws, in brand logical coords (window.__adaiBrandSize = { w, h }).
 *
 * Field-flow layout (the artist's structured 30k view — the latent-island
 * macro-layout that briefly replaced it was reverted after feedback; the
 * server still computes islands at /api/islands but nothing here reads it):
 *   1. Read the Shape-of-Time dot registry, preserving the field's draw order.
 *   2. Place graph nodes in repeated type-runs along that order, so the
 *      coloured hover overlay rides the field as bands instead of reading as
 *      scattered confetti. Runs are scheduled at even fractions of the flow,
 *      so minor types stay woven through the whole composition. Within the
 *      artwork runs, nodes flow chronologically (V&A 1960s–70s opens the
 *      field, SuperRare 2018, fxhash 2021; year-less work closes it) — the
 *      Shape of Time read literally. Other types order by intention then name.
 *
 * Result: bundle.sim[i].(bx,by) coincides exactly with a Shape-of-Time dot.
 *
 * Focus is a single in-place reveal: clicking a node anchors the focus to its
 * field dot (or screen-centre for an edge node), draws curved threads to its
 * neighbours on nearby dots, and dims the rest. (The old 10k/5k rose/bucket
 * "zoom layer" was removed once every node became reachable in the field.)
 */
(() => {
  // ---- config ----
  const CFG = {
    // 30k snapshot binds every graph node to a Shape-of-Time dot in field-flow
    // order; focused views use the graph to reveal actual neighbours.
    DOT_HEX: '#FFFFFF',
    BASE_ALPHA: 0.92,
    NEUTRAL_ALPHA: 0.55,
    DOT_RADIUS_MIN: 2.4,
    DOT_RADIUS_MAX: 3.6,
    HALO_RADIUS_MULT: 2.6,
    HALO_ALPHA: 0.26,
    HOVER_HALO_ALPHA: 0.55,
    SELECTED_HALO_ALPHA: 0.85,
    DRIFT: 0,
    BG_BLEND: 'screen',
    BRAND_OPACITY_WHEN_ACTIVE: '1',
    BRAND_OPACITY_AT_ZOOM: '0.55',   // keep the field present while zoomed in

    CLICK_TOLERANCE: 16,

    // Brand-registry polling — sketch-brand.js fills __adaiDotRegistry on
    // first draw; we wait for it before doing layout.
    REGISTRY_POLL_MS: 80,
    REGISTRY_TIMEOUT_MS: 4000,

    FIELD_FLOW_RUN_MIN: 3,
    FIELD_FLOW_RUN_MAX: 34,
    FIELD_FLOW_RUN_SCALE: 36,
    FIELD_PATTERN_COLORING: true,
    FIELD_PATTERN_RUN: 96,
    FIELD_PATTERN_RUN_MIN: 10,
    FIELD_PATTERN_RUN_MAX: 300,
    FIELD_PATTERN_COLORS: [
      '#D9A33B',
      '#7EB8DA',
      '#9BA67A',
      '#2A7672',
      '#C77A4A',
      '#C9A227',
    ],
    FIELD_COLOR_SETUPS: [
      {
        name: 'archive signal',
        colors: ['#D9A33B', '#7EB8DA', '#9BA67A', '#2A7672', '#C77A4A', '#C9A227'],
      },
      {
        name: 'mineral field',
        colors: ['#AFC7C3', '#D0A94B', '#8E9D6B', '#4F92A3', '#B85C3D', '#D9D2BE'],
      },
      {
        name: 'thermal archive',
        colors: ['#E0B04E', '#A83A1E', '#7EB8DA', '#2F7B74', '#B88A1B', '#D7D0C3'],
      },
      {
        name: 'cobalt index',
        colors: ['#4169B0', '#D9A33B', '#93A06C', '#D93B2D', '#62A9B0', '#E8E6E1'],
      },
    ],
    HOVER_COLOR_REVEAL_RADIUS: 150,
    HOVER_COLOR_REVEAL_SOFTNESS: 170,
    HOVER_COLOR_CORE_ALPHA: 0.78,
    HOVER_COLOR_HALO_ALPHA: 0.32,

    // Type-driven palette so the snapped constellation reads as semantic
    // clusters. Brand-accent set, complementary to the white spiral.
    TYPE_COLORS: {
      practitioner:           '#7EB8DA',  // pale cobalt — the spine of the canon
      artwork:                '#D9A33B',  // amber-gold — works as the warm cluster
      concept:                '#9BA67A',  // muted olive — semantic field
      institution:            '#3E8B85',  // jade-teal — structural actor
      scene:                  '#C77A4A',  // rust — gatherings
      collective:             '#B8542F',  // deeper rust — collective bodies
      platform:               '#2A7672',  // jade — distribution layer
      publication:            '#B88A1B',  // ochre — print/text
      classification_regime:  '#C9A227',  // gold — the lens itself
      project:                '#8F8A78',
      event:                  '#7B6F8F',
      related:                '#5A5A5C',
    },
    TYPE_COLOR_FALLBACK: '#E8E6E1',

    // The single `concept` type holds two very different things: the ~8
    // wikidata-anchored base concepts — the real art-historical *fields*
    // (generative art, computer art, …) — and the ~100 fxhash artist-tag
    // concepts (folksonomy: gif, bw, circle, …, marked by metadata.tag_origin).
    // Fields keep the vivid `concept` olive above; tag-concepts render in this
    // muted grey-olive so they read as background noise. See colorForNode().
    CONCEPT_TAG_COLOR: '#6B6F5C',

    // Edge types we don't render at zoom views.
    // CLASSIFIED_BY is hidden because there's only one regime today (the
    // seed canon) — every node points to it, so the petal/wedge is noise.
    // When more regimes exist (or when we rename to LENS), revisit.
    // Pending: Gio to expose signal provenance, then we add RECEIVED_VIA
    // as a new edge type. See vault: boards/notes-for-gio.md.
    HIDDEN_EDGE_TYPES: ['CLASSIFIED_BY'],

    // ---- Step 3a: 10k zoom ----
    ZOOM_TRANSITION_MS: 950,
    REPLAY_DWELL_MS: 1200,        // pause at each node during URL/bookmark replay
    ZOOM_FOCUS_RADIUS: 6.5,
    ZOOM_NEIGHBOR_RADIUS: 3.2,
    ZOOM_NEIGHBOR_RING_R: 0.34,      // fraction of min(w, h)
    ZOOM_NEIGHBOR_RING_R2: 0.46,     // outer ring if too many for one
    ZOOM_RING_THRESHOLD: 18,         // > this neighbors → split into two rings
    ZOOM_OFFSCREEN_ALPHA: 0.28,      // 30k practitioners stay as a faint constellation when zoomed
    EDGE_THREAD_ALPHA: 0.45,
    FIELD_FOCUS_BACKGROUND_ALPHA: 0.08,
    FIELD_REVEAL_MS: 900,
    FIELD_REVEAL_TO_FOCUS_MS: 620,
    FIELD_REVEAL_STAGGER_MS: 0,
    FIELD_REVEAL_MAX_NODES: 42,
    // Max neighbours a focus shows. A hub has hundreds — show up to this many,
    // chosen most-connected with a partial random spread (see
    // buildInPlaceNeighbors). Nodes under this show every neighbour.
    MAX_INPLACE_NEIGHBORS: 100,
    FIELD_FOCUS_GLOW_ALPHA: 0.42,
    FIELD_FOCUS_GLOW_RADIUS: 7.2,
    IN_PLACE_ANCHOR_MARGIN: 48,
    IN_PLACE_FOCUS_CLEARANCE: 28,
    IN_PLACE_LAYOUT_SCALE: 0.82,
    // Minimum screen distance (px) between two chosen neighbour anchors.
    // The anchor assignment snaps each neighbour to a real registry dot;
    // without a spacing constraint two neighbours could land on nearly
    // coincident dots and their dots + labels stacked unreadably (see the
    // protocol-art review screenshot). Soft constraint: when no spaced
    // candidate remains, a too-close one is still used rather than dropping
    // the neighbour entirely.
    IN_PLACE_ANCHOR_MIN_SEP: 34,
    // Desired anchor targets are clamped this many px inside the viewport,
    // so the widened elliptical layouts scatter UP TO the screen edges but
    // never beyond them (room for a dot + the start of its label). Top and
    // bottom are deeper than the sides: the top band carries the breadcrumb
    // (54px) + bookmarks strip (88px), the bottom the archivist bar — review
    // note 14 asked that graph content stop drifting under them.
    IN_PLACE_TARGET_INSET: 76,
    IN_PLACE_TARGET_INSET_TOP: 132,
    IN_PLACE_TARGET_INSET_BOTTOM: 96,
    // Anchor stickiness (px of score slack). Anchors re-assign on every
    // camera step; without hysteresis the greedy pick swapped between
    // near-equivalent dots frame to frame and the threads flicked during
    // zoom transitions. A neighbour keeps its previous dot unless a new
    // candidate beats it by more than this slack.
    IN_PLACE_ANCHOR_STICKINESS: 90,
    // Time constant (ms) for easing a neighbour's rendered position toward
    // its (re)assigned anchor dot — anchor swaps glide instead of teleport.
    // ~95% settled in 3× this value.
    IN_PLACE_ANCHOR_EASE_MS: 140,
    // Hovered neighbour magnification (review note 17: dense focus views —
    // e.g. a platform with dozens of artworks — render thumbs too small to
    // tell apart). The hovered item's dot/thumb/ring scale up by this factor
    // (eased per frame) and its label wins placement priority.
    IN_PLACE_HOVER_MAGNIFY: 2.1,
    IN_PLACE_CURVE_NEAR_RADIUS: 76,
    IN_PLACE_CURVE_CONTROL_SCALE: 0.34,
    IN_PLACE_CURVE_MIN_BEND: 18,
    EDGE_THREAD_WIDTH_BY_CONFIDENCE: {
      high:       2.2,
      medium:     1.4,
      low:        0.8,
      unverified: 0.5,
    },
    EDGE_THREAD_WIDTH_DEFAULT: 1.2,
    EDGE_THREAD_STYLE_BY_TYPE: {
      CREATED_BY:        { dash: [], width: 1.16, alpha: 1.16 },
      COLLABORATES_WITH: { dash: [10, 5], width: 1.05, alpha: 1.0 },
      BELONGS_TO:        { dash: [14, 7], width: 0.94, alpha: 0.92 },
      EXHIBITED_AT:      { dash: [2, 5], width: 0.9, alpha: 0.82 },
      HELD_BY:           { dash: [], width: 0.95, alpha: 0.86 },
      EMBODIES:          { dash: [7, 4], width: 0.98, alpha: 0.94 },
      PRACTICES:         { dash: [9, 4, 2, 4], width: 0.96, alpha: 0.9 },
      STYLE_KIN:         { dash: [3, 7], width: 0.82, alpha: 0.72 },
      VISUALLY_AFFINE:   { dash: [1, 5], width: 0.78, alpha: 0.68 },
      STYLE_PROXIMITY:   { dash: [8, 5, 1, 5], width: 0.84, alpha: 0.74 },
      SUGGESTS_CREATED_BY: { dash: [12, 4, 2, 4], width: 1.0, alpha: 0.9 },
      CLOSEST_ARTWORK:   { dash: [5, 5], width: 0.8, alpha: 0.7 },
      EMBEDDING_NEAR:    { dash: [4, 6], width: 0.8, alpha: 0.68 },
    },
    NAME_TEXT_ALPHA: 1.0,            // text needs to read clearly over the brand
    NAME_TEXT_SIZE: 11,
    LABEL_MAX_WIDTH: 178,
    LABEL_MARGIN: 8,
    LABEL_PAD_X: 4,
    LABEL_PAD_Y: 3,
    LABEL_GAP: 4,
    LABEL_DOT_CLEARANCE: 8,
    LABEL_BG_ALPHA: 0.86,
    LABEL_STROKE_ALPHA: 0.3,
    LABEL_MAX_VISIBLE: 24,
    LABEL_DENSE_MAX_VISIBLE: 16,

    // Label legibility model. The dots are always all drawn (density is
    // signal); only NAMES are managed, since per-frame text is what floods
    // the GPU and the eye.
    //   - LABEL_MAX_SHOWN doubles as the few-vs-many switch AND the per-frame
    //     cap. If a focused node has <= this many neighbours, every name shows
    //     always (sparse nodes read like a plain labelled graph). Above it,
    //     names reveal only near the cursor (the "reading lens") so you sweep
    //     to read a dense node without a thousand-label flood.
    //   - LABEL_LENS_RADIUS: reveal radius around the cursor in many-mode.
    //   - Collision avoidance + a dark backing pill keep names readable even
    //     where the layout packs dots tightly (the real legibility problem).
    LABEL_MAX_SHOWN: 60,
    LABEL_LENS_RADIUS: 170,
    LABEL_BACKING_ALPHA: 0.55,       // dark pill behind each name for contrast

    // Editorial: practitioners stay as halos/dots (the constellation); only
    // artworks render with their image. Some practitioners carry portrait
    // URLs in the API — we ignore them on purpose. See memory:
    // feedback_images_artworks_only.md.
    THUMB_TYPES: ['artwork'],
    THUMB_PETAL_RADIUS_MAX: 16,      // px — circle clip radius at low artwork-density
    THUMB_PETAL_RADIUS_MIN: 7,       // px — floor; below this it stops being readable
    THUMB_PETAL_DENSITY_KNEE: 6,     // up to this many artworks per petal stay at MAX
    THUMB_PETAL_DENSITY_SLOPE: 0.42, // px shrink per extra artwork past the knee
    THUMB_HERO_RADIUS: 58,           // px — hero thumbnail radius when an artwork is the focus
    THUMB_RING_WIDTH: 1,             // subtle white ring around thumbnails for legibility
  };

  // ---- Narrow-viewport tuning — BANDAID -----------------------------------
  // Gate is width-only: window.innerWidth in CSS px (the viewport meta gives
  // device-width, so a DPR-3 phone reports ~390). Deliberately NOT device /
  // orientation / pointer detection — the cramping is a function of available
  // width, not of "being a phone". So this fires on a phone in PORTRAIT and on
  // a narrow desktop window alike; a phone in LANDSCAPE reports a wide width
  // and intentionally keeps the desktop layout (it has the horizontal room).
  //
  // The in-place focus view (the "zoom-in" phase) was tuned for desktop: up
  // to 100 neighbours fanned across a wide ellipse with 178px-wide labels.
  // Under ~430px that stacks dots on top of one another and collides nearly
  // every label out — the "cramped nodes and text" the floor reported. Until a
  // proper mobile layout pass, scale the densest knobs to the live viewport.
  // Reversible: the render-time knobs (label width, text size, side inset,
  // anchor separation) are read every frame so re-tuning on resize takes
  // effect immediately; the neighbour COUNT is read when a node is focused, so
  // it applies from the next focus (and from first load, since
  // applyViewportTuning() runs once at init before any focus). The top/bottom
  // insets are left untouched — they clear the chrome bands (breadcrumb /
  // bookmarks / archivist), which still exist at any width.
  const CFG_DESKTOP = {
    MAX_INPLACE_NEIGHBORS: CFG.MAX_INPLACE_NEIGHBORS,
    LABEL_MAX_WIDTH: CFG.LABEL_MAX_WIDTH,
    NAME_TEXT_SIZE: CFG.NAME_TEXT_SIZE,
    IN_PLACE_TARGET_INSET: CFG.IN_PLACE_TARGET_INSET,
    IN_PLACE_ANCHOR_MIN_SEP: CFG.IN_PLACE_ANCHOR_MIN_SEP,
  };
  function applyViewportTuning() {
    const w = window.innerWidth || 0;
    if (w > 0 && w <= 560) {
      // Narrow width. Show far fewer neighbours so each dot+label gets
      // room; cap labels to ~46% of the screen (two can't fully overlap) at a
      // slightly smaller size; reclaim horizontal room with a shallower side
      // inset; widen the min anchor separation so the smaller set genuinely
      // spreads instead of stacking. Numbers are eyeball-tunable on-device.
      CFG.MAX_INPLACE_NEIGHBORS = w <= 430 ? 28 : 40;
      CFG.LABEL_MAX_WIDTH = Math.max(104, Math.round(w * 0.46));
      CFG.NAME_TEXT_SIZE = 10;
      CFG.IN_PLACE_TARGET_INSET = 30;
      CFG.IN_PLACE_ANCHOR_MIN_SEP = 42;
    } else {
      CFG.MAX_INPLACE_NEIGHBORS = CFG_DESKTOP.MAX_INPLACE_NEIGHBORS;
      CFG.LABEL_MAX_WIDTH = CFG_DESKTOP.LABEL_MAX_WIDTH;
      CFG.NAME_TEXT_SIZE = CFG_DESKTOP.NAME_TEXT_SIZE;
      CFG.IN_PLACE_TARGET_INSET = CFG_DESKTOP.IN_PLACE_TARGET_INSET;
      CFG.IN_PLACE_ANCHOR_MIN_SEP = CFG_DESKTOP.IN_PLACE_ANCHOR_MIN_SEP;
    }
  }
  applyViewportTuning();

  let fieldRevealTimer = null;

  // Density-aware thumbnail radius. Practitioners like Robert Hodgin have 29
  // artworks on a single CREATED_BY petal — at fixed 16px they overlap badly.
  // Shrink linearly past a knee, clamp to a legible floor.
  function thumbPetalRadiusFor(artworkCountInGroup) {
    const knee = CFG.THUMB_PETAL_DENSITY_KNEE;
    const max = CFG.THUMB_PETAL_RADIUS_MAX;
    const min = CFG.THUMB_PETAL_RADIUS_MIN;
    if (artworkCountInGroup <= knee) return max;
    return Math.max(min, max - (artworkCountInGroup - knee) * CFG.THUMB_PETAL_DENSITY_SLOPE);
  }

  // ---- Image helpers (artwork thumbnails) ----------------------------------
  // Backend returns `cdn_image_url` (R2 hot CDN, preferred) and `image_url`
  // on nodes. ~393/1491 carry one. Some `cdn_image_url`s are .html mirrors
  // (Rhizome wiki etc.) — those return 200 with text/html and won't render.
  // Trust any http(s) URL — the R2 cdn is content-addressed + guaranteed image/*
  // at upload, and gatherer image_urls are real images. No extension allowlist
  // (it silently rejected avif/webp/heic and any future format).
  function isRenderableImageUrl(url) {
    return typeof url === 'string' && /^https?:\/\//i.test(url);
  }
  function pickImageUrl(node) {
    if (!node) return null;
    if (isRenderableImageUrl(node.cdn_image_url)) return node.cdn_image_url;
    if (isRenderableImageUrl(node.image_url)) return node.image_url;
    return null;
  }
  // Cache by URL. R2 sends `Access-Control-Allow-Origin: *`, so crossOrigin
  // works and we can drawImage onto canvas without tainting it.
  const __imgCache = new Map();
  function getImageFor(node) {
    if (!node || !CFG.THUMB_TYPES.includes(node.type)) return null;
    const url = pickImageUrl(node);
    if (!url) return null;
    let entry = __imgCache.get(url);
    if (!entry) {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      entry = { img, status: 'loading' };
      img.addEventListener('load', () => { entry.status = 'ready'; });
      img.addEventListener('error', () => { entry.status = 'error'; });
      img.src = url;
      __imgCache.set(url, entry);
    }
    return entry.status === 'ready' ? entry.img : null;
  }
  // Batched dot draw. Drawing N dots as N separate beginPath/arc/fill calls
  // (with a fillStyle + globalAlpha change each) is the dominant per-frame
  // cost at 8k+ nodes — it saturates the main thread and makes mousemove lag.
  // Here we bucket dots by (colour, quantised alpha) and emit ONE path + ONE
  // fill per bucket, so ~17k fill() calls collapse to a few dozen. The
  // moveTo before each arc prevents the subpaths joining with stray lines.
  // `dots` is an array of {x, y, r, color, alpha}; alpha < 0.005 is skipped.
  function drawDotsBatched(ctx, dots) {
    const TWO_PI = Math.PI * 2;
    const buckets = new Map();
    for (let i = 0; i < dots.length; i++) {
      const d = dots[i];
      if (d.alpha < 0.005) continue;
      const aQ = Math.round(d.alpha * 40) / 40; // 0.025 alpha buckets
      const key = d.color + '|' + aQ;
      let b = buckets.get(key);
      if (!b) { b = { color: d.color, alpha: aQ, pts: [] }; buckets.set(key, b); }
      b.pts.push(d.x, d.y, d.r);
    }
    for (const b of buckets.values()) {
      ctx.fillStyle = b.color;
      ctx.globalAlpha = b.alpha;
      ctx.beginPath();
      const p = b.pts;
      for (let i = 0; i < p.length; i += 3) {
        const x = p[i], y = p[i + 1], r = p[i + 2];
        ctx.moveTo(x + r, y);
        ctx.arc(x, y, r, 0, TWO_PI);
      }
      ctx.fill();
    }
  }

  // Pre-rendered circular thumbnail sprites. The clip + cover-fit + ring is
  // expensive (ctx.clip() especially) and was being paid PER thumbnail PER
  // frame — the dominant cost once artworks render as images. We do it ONCE
  // per (image, radius) into an offscreen canvas and then just blit that
  // sprite each frame (a single drawImage, no clip/save/restore). Built at
  // devicePixelRatio resolution so it stays crisp on retina.
  const _thumbSpriteCache = new Map();
  const _THUMB_CACHE_MAX = 600;
  function getThumbSprite(img, r) {
    const iw = img.naturalWidth || img.width;
    const ih = img.naturalHeight || img.height;
    if (!iw || !ih) return null;
    const rr = Math.round(r);
    const key = (img.currentSrc || img.src || '') + '|' + rr;
    let sprite = _thumbSpriteCache.get(key);
    if (sprite) return sprite;

    const dpr = Math.min(window.devicePixelRatio || 1, 2); // cap: sprite memory + phone fill
    const sizePx = Math.max(2, Math.ceil(2 * rr * dpr));
    const off = document.createElement('canvas');
    off.width = sizePx;
    off.height = sizePx;
    const octx = off.getContext('2d');
    octx.scale(dpr, dpr);
    const c = rr; // logical centre
    // cover-fit
    const scale = (2 * rr) / Math.min(iw, ih);
    const dw = iw * scale, dh = ih * scale;
    octx.beginPath();
    octx.arc(c, c, rr, 0, Math.PI * 2);
    octx.closePath();
    octx.clip();
    octx.drawImage(img, c - dw / 2, c - dh / 2, dw, dh);
    // ring (drawn inside the clip so it never bleeds past the circle edge)
    octx.lineWidth = CFG.THUMB_RING_WIDTH * 2; // half is clipped away → hairline
    octx.strokeStyle = 'rgba(255,255,255,0.85)';
    octx.beginPath();
    octx.arc(c, c, rr, 0, Math.PI * 2);
    octx.stroke();

    if (_thumbSpriteCache.size >= _THUMB_CACHE_MAX) {
      // simple FIFO evict — keeps memory bounded under lots of radii/images
      _thumbSpriteCache.delete(_thumbSpriteCache.keys().next().value);
    }
    sprite = { canvas: off, r: rr };
    _thumbSpriteCache.set(key, sprite);
    return sprite;
  }

  // Blit a circular thumbnail sprite. ctx.globalAlpha is honoured (caller sets
  // it). Falls back to a direct clipped draw only if the sprite can't build.
  function drawCircleImage(ctx, img, cx, cy, r) {
    const sprite = getThumbSprite(img, r);
    if (sprite) {
      const rr = sprite.r;
      ctx.drawImage(sprite.canvas, cx - rr, cy - rr, 2 * rr, 2 * rr);
      return;
    }
    const iw = img.naturalWidth || img.width;
    const ih = img.naturalHeight || img.height;
    if (!iw || !ih) return;
    const scale = (2 * r) / Math.min(iw, ih);
    const dw = iw * scale, dh = ih * scale;
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(img, cx - dw / 2, cy - dh / 2, dw, dh);
    ctx.restore();
  }

  // ---- DOM setup ----
  function ensureCanvas() {
    let canvas = document.getElementById('graph-canvas');
    if (canvas) return canvas;
    canvas = document.createElement('canvas');
    canvas.id = 'graph-canvas';
    Object.assign(canvas.style, {
      position: 'fixed',
      inset: '0',
      width: '100%',
      height: '100%',
      // Option B: the constellation is the browsable base view, so the overlay
      // is visible + interactive from creation (hover + click on dots). CSS
      // dims #mopey and lifts the glow/threads during reveal/focus.
      pointerEvents: 'auto',
      zIndex: '4',
      mixBlendMode: CFG.BG_BLEND,
    });
    document.body.appendChild(canvas);
    return canvas;
  }

  function sizeCanvas(canvas) {
    // Cap at 2×: this full-screen overlay composites every frame on top of the
    // Shape-of-Time field, so a dpr-3 phone would otherwise pay 9× the fill for
    // no perceptible gain. (iPad/retina dpr-2 is unchanged — already the cap.)
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = window.innerWidth;
    const h = window.innerHeight;
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w, h };
  }

  // ---- read Shape of Time positions (restored) -------------------------
  function readBrandPositions() {
    const reg = window.__adaiDotRegistry;
    if (!Array.isArray(reg) || reg.length === 0) return null;
    const size = window.__adaiBrandSize || { w: 1600, h: 900 };
    return { positions: reg.slice(), brandW: size.w, brandH: size.h };
  }

  function waitForRegistry() {
    return new Promise((resolve) => {
      const tStart = Date.now();
      (function poll() {
        const r = readBrandPositions();
        if (r) return resolve(r);
        if (Date.now() - tStart > CFG.REGISTRY_TIMEOUT_MS) return resolve(null);
        setTimeout(poll, CFG.REGISTRY_POLL_MS);
      })();
    });
  }

  // Stride-pick visually distinct brand positions (dedup by coarse grid,
  // then evenly subsample to `want`). The registry has tens of thousands
  // of dots; dedup spreads picks across the full composition.
  function pickDistinctPositions(brand, want) {
    // De-dupe brand dots onto a grid so two nodes don't sit on the exact same
    // spot. A coarse grid (14px) only yields ~2690 distinct slots — far fewer
    // than the ~4700 nodes — which left ~2000 nodes unplaced (off-field). Try
    // progressively finer grids until we have at least `want` slots, so EVERY
    // node gets a field position; then sample evenly down to `want`.
    const dedupe = (GRID) => {
      const seen = new Map();
      for (let i = 0; i < brand.positions.length; i++) {
        const p = brand.positions[i];
        const key = `${(p.x / GRID) | 0},${(p.y / GRID) | 0}`;
        if (!seen.has(key)) seen.set(key, { ...p, fieldIndex: i });
      }
      return Array.from(seen.values());
    };
    let distinct = [];
    for (const GRID of [14, 10, 8, 6, 4, 3, 2, 1]) {
      distinct = dedupe(GRID);
      if (distinct.length >= want) break;
    }
    if (distinct.length <= want) return distinct;
    const stride = distinct.length / want;
    const picked = new Array(want);
    for (let i = 0; i < want; i++) picked[i] = distinct[(i * stride) | 0];
    return picked;
  }

  // Z-priority: smaller = drawn first (= behind). Practitioners + artworks
  // paint on top so they stay readable in dense snapped clusters.
  const Z_BY_TYPE = {
    classification_regime: 0, project: 1, related: 1, event: 1,
    publication: 2, platform: 2, collective: 2,
    concept: 3, scene: 3, institution: 3,
    artwork: 4, practitioner: 5,
  };
  function zForType(t) { return Z_BY_TYPE[t] != null ? Z_BY_TYPE[t] : 3; }

  // Look up the brand-accent colour for a node type. Used by frame() to
  // give the 30k constellation a readable type structure.
  function colorForType(type) {
    return CFG.TYPE_COLORS[type] || CFG.TYPE_COLOR_FALLBACK;
  }

  // Like colorForType, but splits the `concept` type in two: a folksonomy
  // tag-concept (carries tag_origin, projected onto /api/graph/stream) gets the
  // muted CONCEPT_TAG_COLOR; a real field (no tag_origin) keeps the vivid
  // concept olive. Accepts a sim or a raw node — both carry .type/.tag_origin.
  // Falls back to the plain type colour for everything else (and when missing).
  function colorForNode(n) {
    if (n && n.type === 'concept') {
      return n.tag_origin
        ? CFG.CONCEPT_TAG_COLOR
        : (CFG.TYPE_COLORS.concept || CFG.TYPE_COLOR_FALLBACK);
    }
    return colorForType(n && n.type);
  }

  let activeFieldColorSetup = null;

  function hashStringToUint(value) {
    let h = 2166136261 >>> 0;
    const str = String(value || '');
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function fieldColorSeed() {
    const params = new URLSearchParams(window.location.search);
    return params.get('seed') ||
      window.ADAI_FIELD_SEED ||
      window.BrandBackgroundGenerator?.getSeed?.() ||
      'adai-field-color';
  }

  function runForFieldColorSetup(seed, setupName) {
    const minRun = Math.max(1, Math.floor(CFG.FIELD_PATTERN_RUN_MIN || 10));
    const maxRun = Math.max(minRun, Math.floor(CFG.FIELD_PATTERN_RUN_MAX || 300));
    const range = maxRun - minRun + 1;
    const runHash = hashStringToUint(`${seed}:${setupName || 'field-color'}:run`);
    return minRun + (runHash % range);
  }

  function fieldColorSetup() {
    if (activeFieldColorSetup) return activeFieldColorSetup;

    const seed = fieldColorSeed();
    const setups = CFG.FIELD_COLOR_SETUPS || [];
    if (!setups.length) {
      activeFieldColorSetup = {
        name: 'fallback',
        run: runForFieldColorSetup(seed, 'fallback'),
        colors: CFG.FIELD_PATTERN_COLORS,
        offset: 0,
      };
      return activeFieldColorSetup;
    }

    const params = new URLSearchParams(window.location.search);
    const requested = (params.get('fieldColor') || '').trim().toLowerCase();
    const requestedSetup = requested
      ? setups.find((setup) => setup.name.toLowerCase().replace(/\s+/g, '-') === requested)
      : null;
    const seedHash = hashStringToUint(seed);
    const setup = requestedSetup || setups[seedHash % setups.length];
    const colors = setup.colors && setup.colors.length ? setup.colors : CFG.FIELD_PATTERN_COLORS;
    const run = runForFieldColorSetup(seed, setup.name);
    activeFieldColorSetup = {
      ...setup,
      colors,
      run,
      offset: colors.length ? seedHash % colors.length : 0,
    };
    window.ADAI_FIELD_COLOR_SETUP = {
      name: activeFieldColorSetup.name,
      run: activeFieldColorSetup.run,
      runRange: [CFG.FIELD_PATTERN_RUN_MIN, CFG.FIELD_PATTERN_RUN_MAX],
      offset: activeFieldColorSetup.offset,
      colors: [...activeFieldColorSetup.colors],
    };
    document.documentElement.dataset.fieldColorSetup = activeFieldColorSetup.name;
    document.documentElement.dataset.fieldColorRun = String(activeFieldColorSetup.run);
    return activeFieldColorSetup;
  }

  function colorForFieldFlow(slot) {
    const setup = fieldColorSetup();
    const palette = setup.colors;
    if (!palette || !palette.length) return CFG.TYPE_COLOR_FALLBACK;
    const run = Math.max(1, setup.run || CFG.FIELD_PATTERN_RUN);
    const band = Math.floor(Math.max(0, slot) / run) + (setup.offset || 0);
    return palette[band % palette.length];
  }

  function colorForBaseDot(sim) {
    if (CFG.FIELD_PATTERN_COLORING && sim?.fieldColor) return sim.fieldColor;
    return colorForType(sim?.type);
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function smoothstep(edge0, edge1, value) {
    const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
    return t * t * (3 - 2 * t);
  }

  function colorRevealAt(px, py, cursorX, cursorY) {
    if (cursorX == null || cursorY == null) return 0;
    const d = Math.hypot(px - cursorX, py - cursorY);
    const falloff = 1 - smoothstep(
      CFG.HOVER_COLOR_REVEAL_RADIUS,
      CFG.HOVER_COLOR_REVEAL_RADIUS + CFG.HOVER_COLOR_REVEAL_SOFTNESS,
      d
    );
    return clamp(falloff, 0, 1);
  }

  const FIELD_FLOW_TYPE_ORDER = [
    'artwork',
    'practitioner',
    'concept',
    'institution',
    'platform',
    'collective',
    'scene',
    'publication',
    'classification_regime',
    'project',
    'event',
    'related',
  ];
  const FIELD_FLOW_TYPE_RANK = new Map(FIELD_FLOW_TYPE_ORDER.map((type, idx) => [type, idx]));

  function fieldFlowTypeRank(type) {
    return FIELD_FLOW_TYPE_RANK.has(type) ? FIELD_FLOW_TYPE_RANK.get(type) : FIELD_FLOW_TYPE_ORDER.length;
  }

  // First 4-digit year in the streamed display string ("c. 1965" → 1965,
  // "1967 - 1968" → 1967, "2021" → 2021). Year-less artworks (Art Blocks
  // tokens carry no date in their metadata yet — a producer gap, not a UI
  // one) sort to the END of the flow, which is roughly honest: they're
  // 2020–24 work.
  function artworkYearKey(node) {
    const m = /\d{4}/.exec(String(node.year || ''));
    return m ? parseInt(m[0], 10) : Infinity;
  }

  // Within a type's runs: artworks flow chronologically (the Shape of Time
  // read literally — walking the draw order walks art history); everything
  // else orders by relational richness (intention) then name.
  function sortNodesWithinFieldRun(graph, type) {
    if (type === 'artwork') {
      return (a, b) => {
        const ya = artworkYearKey(a);
        const yb = artworkYearKey(b);
        if (ya !== yb) return ya - yb;
        return (a.name || a.id).localeCompare(b.name || b.id);
      };
    }
    return (a, b) => {
      const ia = graph.intentionOf(a.id);
      const ib = graph.intentionOf(b.id);
      if (ib !== ia) return ib - ia;
      return (a.name || a.id).localeCompare(b.name || b.id);
    };
  }

  function fieldFlowRunLength(type, count, total) {
    const share = total ? count / total : 0;
    return clamp(
      Math.round(CFG.FIELD_FLOW_RUN_MIN + share * CFG.FIELD_FLOW_RUN_SCALE),
      CFG.FIELD_FLOW_RUN_MIN,
      CFG.FIELD_FLOW_RUN_MAX
    );
  }

  function orderNodesByFieldFlow(graph, nodes) {
    const groups = new Map();
    const add = (node) => {
      let group = groups.get(node.type);
      if (!group) { group = []; groups.set(node.type, group); }
      group.push(node);
    };
    for (const node of nodes) add(node);

    for (const [type, group] of groups) group.sort(sortNodesWithinFieldRun(graph, type));

    const types = Array.from(groups.keys())
      .sort((a, b) => fieldFlowTypeRank(a) - fieldFlowTypeRank(b) || a.localeCompare(b));
    const total = nodes.length;

    // Chop each type into runs and schedule run j of r at the even fraction
    // (j + 0.5) / r of the whole flow. The old greedy round-robin exhausted
    // minor types in its first passes — all the concepts/institutions/
    // platforms sat in the opening third of the draw order and the back of
    // the composition was pure artwork. Even scheduling keeps every type
    // woven through the full field, and (since artworks are chronological
    // within their type) spreads the artwork time axis across the whole
    // composition. Deterministic, and still emits exactly `total` nodes.
    const runs = [];
    for (const type of types) {
      const group = groups.get(type);
      const runLen = fieldFlowRunLength(type, group.length, total);
      const nRuns = Math.max(1, Math.ceil(group.length / runLen));
      for (let j = 0; j < nRuns; j++) {
        runs.push({
          at: (j + 0.5) / nRuns,
          rank: fieldFlowTypeRank(type),
          items: group.slice(j * runLen, (j + 1) * runLen),
        });
      }
    }
    runs.sort((a, b) => a.at - b.at || a.rank - b.rank);

    const ordered = [];
    for (const run of runs) {
      for (const node of run.items) ordered.push(node);
    }
    return ordered;
  }

  function assignFieldFlowPositions(graph, available, nodes) {
    const positions = available
      .slice()
      .sort((a, b) => {
        const ai = a.fieldIndex ?? 0;
        const bi = b.fieldIndex ?? 0;
        if (ai !== bi) return ai - bi;
        if (a.y !== b.y) return a.y - b.y;
        return a.x - b.x;
      });
    const ordered = orderNodesByFieldFlow(graph, nodes);
    const sim = [];
    for (let i = 0; i < ordered.length && i < positions.length; i++) {
      const n = ordered[i];
      const p = positions[i];
      p.used = true;
      sim.push({
        id: n.id, name: n.name, type: n.type,
        // Carried so colorForNode() can split concept→field vs concept→tag at
        // focus/hover/select time without a graph.byId lookup.
        tag_origin: n.tag_origin || null,
        bx: p.x, by: p.y, bRad: p.radius,
        x: 0, y: 0,
        _z: zForType(n.type),
        fieldIndex: p.fieldIndex,
        flowIndex: i,
        fieldColor: colorForFieldFlow(i),
      });
    }
    return sim;
  }

  // ---- field-flow layout -----------------------------------------------
  // Bind every graph node to a Shape-of-Time dot in field-flow order — the
  // artist's structured layout. bundle.sim[i].(bx,by) lands on a real field
  // dot. (A latent-islands macro-layout briefly grouped nodes into k-means
  // territories here; reverted June 2026 after feedback. /api/islands still
  // serves the clustering if a future surface wants it.)
  function pairNodesToPositions(graph, brand) {
    // Pool of available brand dots (one slot per graph node).
    const wanted = graph.nodes.length;
    const pool = pickDistinctPositions(brand, wanted);
    const available = pool.map(p => ({
      x: p.x, y: p.y, radius: p.radius, used: false,
    }));

    const sim = assignFieldFlowPositions(graph, available, graph.nodes);
    sim.sort((a, b) => a._z - b._z || (a.flowIndex ?? 0) - (b.flowIndex ?? 0));
    return {
      sim, brandW: brand.brandW, brandH: brand.brandH,
      snapshotType: 'field-flow', snapshotSize: sim.length,
      totalGraph: graph.nodes.length, distinctCount: pool.length,
    };
  }

  // Project brand-space (0..brandW, 0..brandH) into the screen rect occupied
  // by the brand canvas. This is what aligns our dots with the visible
  // Shape of Time.
  function reproject(simBundle) {
    const { sim, brandW, brandH } = simBundle;
    // Keep the id index in sync if the sim grew (nodes stream in progressively),
    // so in-place focus can anchor freshly-arrived nodes instead of falling back.
    if (simBundle.simById && simBundle.simById.size !== sim.length) {
      simBundle.simById = new Map(sim.map(s => [s.id, s]));
    }
    const myCanvas = document.getElementById('myCanvas') || document.querySelector('#mopey canvas');
    let rect;
    if (myCanvas) {
      rect = myCanvas.getBoundingClientRect();
    } else {
      rect = { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
    }
    const sx = rect.width / brandW;
    const sy = rect.height / brandH;
    const minScale = Math.min(sx, sy);
    const atRest = !simBundle.viewLevel || simBundle.viewLevel === '30k';
    for (const s of sim) {
      // baseX/baseY/baseR = 30k "home" position. Stable across resize.
      s.baseX = rect.left + s.bx * sx;
      s.baseY = rect.top + s.by * sy;
      s.baseR = Math.max(CFG.DOT_RADIUS_MIN, Math.min(CFG.DOT_RADIUS_MAX, s.bRad * minScale * 0.45));
      // x/y/r = current animated position. Snap to base only when at 30k rest.
      if (atRest) {
        s.x = s.baseX;
        s.y = s.baseY;
        s.r = s.baseR;
      }
    }
    simBundle.canvasRect = rect;
  }

  // ---- entity panel (interim Step 3 preview) ----
  // Click a practitioner -> a side panel surfaces their real graph data
  // (name, id, edge count, intention, sample edges). Not the full zoom yet —
  // just proof that what you see is bound to what's in /api/graph.
  function createEntityPanel() {
    const el = document.createElement('div');
    el.id = 'entity-panel';
    Object.assign(el.style, {
      position: 'fixed',
      top: '50%',
      right: '24px',
      transform: 'translateY(-50%)',
      width: '320px',
      maxHeight: '78vh',
      overflowY: 'auto',
      background: 'rgba(12,12,14,0.92)',
      border: '1px solid #2a2a30',
      borderRadius: '4px',
      padding: '16px 18px',
      color: '#E8E6E1',
      fontFamily: "'SF Mono', 'Menlo', 'Consolas', monospace",
      fontSize: '11px',
      lineHeight: '1.55',
      zIndex: '50',
      display: 'none',
      backdropFilter: 'blur(6px)',
      webkitBackdropFilter: 'blur(6px)',
    });
    document.body.appendChild(el);
    return el;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, ch => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
  }

  function showEntityPanel(panelEl, graph, sim) {
    const node = graph.byId.get(sim.id);
    if (!node) return;
    // Human-attested edges only: once the derived layer has merged into the
    // live index (embeddings mode / legacy fallback), edgesFor() and
    // edgeTypeCount include STYLE_KIN etc. — recount from the filtered list
    // so "STYLE_KIN 8" never shows in this panel's relation counts.
    const allEdges = graph.edgesFor(sim.id).filter(e => !isDerivedEdge(e));
    const sampleEdges = allEdges.slice(0, 10);
    const typeCounts = new Map();
    for (const e of allEdges) typeCounts.set(e.type, (typeCounts.get(e.type) || 0) + 1);
    const typesHtml = typeCounts.size
      ? Array.from(typeCounts).sort((a, b) => b[1] - a[1])
          .map(([t, n]) => `<span style="color:#7eb8da">${escapeHtml(t)}</span>&nbsp;${n}`).join('&nbsp;·&nbsp;')
      : '<span style="color:#666">none</span>';
    const edgesHtml = sampleEdges.map(e => {
      const dir = e.source === sim.id ? '→' : '←';
      const otherId = e.source === sim.id ? e.target : e.source;
      const other = graph.byId.get(otherId);
      const otherName = other ? other.name : (otherId.split(':')[1] || otherId);
      const conf = e.confidence || 'unknown';
      return `<div style="padding:3px 0;color:#c8c8c8"><span style="color:#666">${dir}</span> ${escapeHtml(otherName)} <span style="color:#555;float:right;font-size:10px">${escapeHtml(e.type)}&nbsp;·&nbsp;${escapeHtml(conf)}</span></div>`;
    }).join('');
    const moreCount = allEdges.length - sampleEdges.length;
    const moreHtml = moreCount > 0
      ? `<div style="color:#555;padding-top:6px;font-size:10px">+ ${moreCount} more · agent skill will surface them at zoom</div>`
      : '';
    panelEl.innerHTML = `
      <button class="adai-close" aria-label="close" style="float:right;background:none;border:none;color:#666;cursor:pointer;font-size:16px;line-height:1;padding:0;margin-left:8px">×</button>
      <div style="color:#666;font-size:9px;letter-spacing:0.12em;text-transform:uppercase;margin-bottom:6px">${escapeHtml(node.type)}${node.year ? ` · ${escapeHtml(node.year)}` : ''}</div>
      <div style="font-size:15px;color:#fff;margin-bottom:4px;line-height:1.25">${escapeHtml(node.name)}</div>
      <div style="color:#555;font-size:10px;margin-bottom:14px;word-break:break-all">${escapeHtml(node.id)}</div>
      <div style="border-top:1px solid #2a2a30;padding-top:12px">
        <div style="color:#888;margin-bottom:4px">edges <span style="color:#fff">${allEdges.length}</span> &nbsp;·&nbsp; types <span style="color:#fff">${typeCounts.size}</span></div>
        <div style="font-size:10px;margin-bottom:14px">${typesHtml}</div>
        <div style="color:#888;margin-bottom:6px">connections</div>
        ${edgesHtml}
        ${moreHtml}
      </div>
    `;
    panelEl.querySelector('.adai-close').addEventListener('click', () => {
      panelEl.style.display = 'none';
    }, { once: true });
    panelEl.style.display = 'block';
  }

  function nearestSim(bundle, x, y, tolerance) {
    let best = null;
    let bestD2 = tolerance * tolerance;
    for (const s of bundle.sim) {
      const dx = s.x - x;
      const dy = s.y - y;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD2) { bestD2 = d2; best = s; }
    }
    return best;
  }

  // ---- Step 3: zoom (10k practitioner view) ----
  // View state lives on bundle so it's reachable from the render loop.
  // Levels: '30k' (Shape of Time + practitioner snapshot)
  //         '10k' (one practitioner centred + 1-hop neighbours around)
  //         '5k'  (Step 3b: scene at centre, members around)
  function easeInOutCubic(t) {
    // Smoother quartic ease: gentler ramp-in and decel-out than cubic.
    // Name kept for call-site stability; behavior is now in/out quart.
    return t < 0.5 ? 8 * t * t * t * t : 1 - Math.pow(-2 * t + 2, 4) / 2;
  }

  // Embedding-derived edges (STYLE_KIN / VISUALLY_AFFINE / inferred EMBODIES)
  // are stamped with this created_by by the derive pipeline. They belong to
  // the embeddings ('e') layer ONLY — the solid coloured layer, its chips and
  // its palette are human-attested edges. Type alone can't identify them
  // (Tier-2 inferred EMBODIES shares its type with curated rows), so filter
  // by provenance. Curated stream edges omit created_by entirely; the derived
  // payloads (/api/graph/derived and the legacy /api/graph fallback) ship it.
  const DERIVED_CREATED_BY = 'embedding-multimodal-v1';
  function isDerivedEdge(e) {
    return !!e && e.created_by === DERIVED_CREATED_BY;
  }
  function derivedVisible(bundle) {
    return bundle && bundle.fieldMode === 'embeddings';
  }

  // Pull the per-edge accent color from edge-type-colors.js.
  function colorForEdge(type) {
    const lib = window.ADAI_EDGE_COLORS;
    if (!lib) return '#888';
    return (lib.colorFor(type) || lib.NEUTRAL).hex;
  }

  function edgeTypeForEmbeddingSection(key) {
    switch (key) {
      case 'style_kin': return 'STYLE_KIN';
      case 'visually_affine': return 'VISUALLY_AFFINE';
      case 'style_proximity': return 'STYLE_PROXIMITY';
      case 'closest_artworks': return 'CLOSEST_ARTWORK';
      case 'ai_attributions': return 'SUGGESTS_CREATED_BY';
      default: return 'EMBEDDING_NEAR';
    }
  }

  function confidenceForSimilarity(similarity) {
    if (typeof similarity !== 'number') return 'medium';
    if (similarity >= 0.9) return 'high';
    if (similarity >= 0.82) return 'medium';
    if (similarity >= 0.74) return 'low';
    return 'unverified';
  }

  function hashString(value) {
    let h = 2166136261;
    const text = String(value || '');
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function edgeThreadStyle(item) {
    return CFG.EDGE_THREAD_STYLE_BY_TYPE[item?.edgeType] ||
      (item?.source === 'embedding'
        ? CFG.EDGE_THREAD_STYLE_BY_TYPE.EMBEDDING_NEAR
        : { dash: [], width: 1, alpha: 1 });
  }

  // Gravity from agreement: a relation several independent sources state
  // (edge.src — distinct evidence origins, not contributors) draws heavier.
  function sourceWeight(item) {
    const n = (item && item.edge && item.edge.src) || 1;
    return n > 1 ? Math.min(2.2, 1 + 0.7 * Math.log2(n)) : 1;
  }

  // Relations the subject contests (docs/CLAIM-SPEC.md §5): drawn dashed in
  // the contest colour for everyone, until a curator decides. Loaded from
  // /api/contested on start — not part of the cached graph stream.
  const CONTESTED_COLOR = '#d4a574';
  let contestedTriples = new Set();
  function isContested(e) {
    return !!e && contestedTriples.size > 0 &&
      contestedTriples.has(`${e.source}\u0000${e.type}\u0000${e.target}`);
  }

  function applyEdgeThreadStyle(ctx, item, baseAlpha, baseWidth) {
    const style = edgeThreadStyle(item);
    const alpha = clamp(baseAlpha * (style.alpha || 1), 0, 1);
    const width = Math.max(0.45, baseWidth * (style.width || 1) * sourceWeight(item));
    const contested = isContested(item && item.edge);
    const dash = contested ? [3, 4] : (style.dash || []);
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = contested ? CONTESTED_COLOR : (item.edgeColor || '#888');
    ctx.lineWidth = width;
    ctx.setLineDash(dash);
    ctx.lineDashOffset = dash.length ? -(hashString(item.id + item.edgeType) % 18) : 0;
    return { alpha, width, dash };
  }

  function resetEdgeThreadStyle(ctx) {
    ctx.setLineDash([]);
    ctx.lineDashOffset = 0;
  }

  // ---- Layouts (case 17 rose + case 20 bucketed wedges) ----
  // Both produce the same shape: { cx, cy, neighbors: [...] }
  // where each neighbor has { id, name, type, edgeType, edgeConfidence,
  // edgeColor, x, y, r, startX, startY, startR, alpha }.

  // Group edges by type, dedup by other-node-id, return:
  //   [{ edgeType, items: [{ id, name, type, edgeType, edgeConfidence, edgeColor, edge }] }, ...]
  // sorted by edge type name so the visual ordering is stable.
  function gatherNeighborsByType(graph, focusedId, includeDerived) {
    const edges = graph.edgesFor(focusedId);
    const seen = new Set();
    const byType = new Map();
    const hiddenTypes = new Set(CFG.HIDDEN_EDGE_TYPES || []);
    for (const e of edges) {
      if (hiddenTypes.has(e.type)) continue;
      // Derived edges only exist for the embeddings layer — in curatorial
      // mode they must not shape the layout, the chips, or the palette.
      if (!includeDerived && isDerivedEdge(e)) continue;
      const otherId = e.source === focusedId ? e.target : e.source;
      if (seen.has(otherId)) continue;
      seen.add(otherId);
      const node = graph.byId.get(otherId);
      if (!node) continue;
      const item = {
        id: otherId,
        name: node.name,
        type: node.type,
        edgeType: e.type,
        edgeConfidence: e.confidence,
        edgeColor: colorForEdge(e.type),
        edge: e,
      };
      if (!byType.has(e.type)) byType.set(e.type, []);
      byType.get(e.type).push(item);
    }
    // Sort each group's items alphabetically by name for stability
    for (const arr of byType.values()) {
      arr.sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
    }
    // Sort groups by edge-type name (stable across visits)
    const ordered = Array.from(byType.entries()).sort((a, b) => a[0].localeCompare(b[0]));
    return ordered.map(([edgeType, items]) => ({ edgeType, items }));
  }

  // Rose / petal layout (case 17 in sketch-brand.js).
  // k petals = number of distinct edge types. Each petal carries the
  // neighbours of one edge type along the rose curve r = R·cos(k·θ).
  // The shape itself encodes the focused node's intention (edge-type
  // diversity): a high-intention node blooms with many petals.
  function computeRoseLayout(graph, focusedId, w, h, includeDerived) {
    const cx = w / 2, cy = h / 2;
    // Elliptical radii: scale each axis by ITS viewport dimension instead of
    // the old R = min(w,h) — on a wide window the circular layout left the
    // horizontal space unused and everything read as bunched around the
    // focus. Vertically this matches the old 0.42·min on landscape screens.
    const Rx = w * 0.40;
    const Ry = h * 0.42;
    const groups = gatherNeighborsByType(graph, focusedId, includeDerived);
    const k = groups.length;
    if (k === 0) return { cx, cy, neighbors: [], layout: 'rose', petalCount: 0, Rx, Ry };

    const out = [];
    groups.forEach((group, gi) => {
      // petal center direction; first petal points up so layout reads top-first
      const petalCenter = (gi / k) * Math.PI * 2 - Math.PI / 2;
      const N = group.items.length;
      // Count artworks in this petal so the renderer can shrink thumbs when
      // the petal is dense (e.g., a practitioner's CREATED_BY edges).
      const artworkCount = group.items.filter(it => {
        const node = graph.byId.get(it.id);
        return node && CFG.THUMB_TYPES.includes(node.type);
      }).length;
      group.items.forEach((it, n) => {
        // u in [0.18, 0.82] avoids collapsing at petal base (r=0)
        const u = N === 1 ? 0.5 : 0.18 + (n / (N - 1)) * 0.64;
        const thetaRel = (u - 0.5) * Math.PI / k;
        // rN = cos(k · θ)  — the rose math, normalised; each axis then
        // stretches by its own viewport-proportional radius.
        const rN = Math.cos(k * thetaRel);
        const thetaAbs = petalCenter + thetaRel;
        out.push({
          ...it,
          x: cx + rN * Math.cos(thetaAbs) * Rx,
          y: cy + rN * Math.sin(thetaAbs) * Ry,
          r: CFG.ZOOM_NEIGHBOR_RADIUS,
          groupArtworkCount: artworkCount,
          startX: cx, startY: cy, startR: 0,
          alpha: 0,
        });
      });
    });
    return { cx, cy, neighbors: out, layout: 'rose', petalCount: k, Rx, Ry };
  }

  // Bucketed-wedges layout (case 20 in sketch-brand.js, generalised).
  // Each edge type gets one angular wedge of equal width (2π/k). Inside
  // each wedge, neighbours pack in a small grid (rows × cols) so dense
  // edge types stay legible.
  function computeBucketedLayout(graph, focusedId, w, h, includeDerived) {
    const cx = w / 2, cy = h / 2;
    // Elliptical radii — same rationale as computeRoseLayout: use the
    // horizontal space a wide viewport actually has.
    const Rx = w * 0.42;
    const Ry = h * 0.44;
    const groups = gatherNeighborsByType(graph, focusedId, includeDerived);
    const k = groups.length;
    if (k === 0) return { cx, cy, neighbors: [], layout: 'bucketed', wedgeCount: 0, Rx, Ry };

    const out = [];
    const wedgeWidth = (Math.PI * 2) / k;
    groups.forEach((group, gi) => {
      const wedgeCenter = (gi / k) * Math.PI * 2 - Math.PI / 2;
      const items = group.items;
      const N = items.length;
      const artworkCount = items.filter(it => {
        const node = graph.byId.get(it.id);
        return node && CFG.THUMB_TYPES.includes(node.type);
      }).length;
      // Grid the wedge: rowsCount rows of dots, dotsPerRow per row
      const rowsCount = Math.max(1, Math.ceil(Math.sqrt(N * 0.7)));
      const dotsPerRow = Math.max(1, Math.ceil(N / rowsCount));
      items.forEach((it, idx) => {
        const row = Math.floor(idx / dotsPerRow);
        const col = idx % dotsPerRow;
        const inThisRow = Math.min(dotsPerRow, N - row * dotsPerRow);
        const rNorm = rowsCount === 1 ? 0.5 : row / (rowsCount - 1);
        // Normalised ring position in [0.32 .. 1], stretched per-axis below.
        const rr = 0.32 + rNorm * 0.68;
        const angSpread = wedgeWidth * 0.78;
        const angOffset = inThisRow === 1
          ? 0
          : (col - (inThisRow - 1) / 2) / (inThisRow - 1) * angSpread;
        const ang = wedgeCenter + angOffset;
        out.push({
          ...it,
          x: cx + Math.cos(ang) * rr * Rx,
          y: cy + Math.sin(ang) * rr * Ry,
          r: CFG.ZOOM_NEIGHBOR_RADIUS,
          groupArtworkCount: artworkCount,
          startX: cx, startY: cy, startR: 0,
          alpha: 0,
        });
      });
    });
    return { cx, cy, neighbors: out, layout: 'bucketed', wedgeCount: k, Rx, Ry };
  }

  // Pick rose for practitioner+scene (their bloom IS who they are).
  // Pick bucketed wedges for everything else (concepts, artworks,
  // institutions, regimes — high-degree, denser packing needed).
  function computeLayoutFor(graph, focusedId, w, h, includeDerived) {
    const node = graph.byId.get(focusedId);
    const t = node ? node.type : null;
    if (t === 'practitioner' || t === 'scene') return computeRoseLayout(graph, focusedId, w, h, includeDerived);
    return computeBucketedLayout(graph, focusedId, w, h, includeDerived);
  }

  // Generic position tween. Mutates targets each frame, calls onDone at end.
  function runTween(durationMs, onTick, onDone) {
    const start = performance.now();
    function step(now) {
      const t = Math.min(1, (now - start) / durationMs);
      const e = easeInOutCubic(t);
      onTick(e);
      if (t < 1) requestAnimationFrame(step);
      else if (onDone) onDone();
    }
    requestAnimationFrame(step);
  }

  // Field-mode default filters. Both zoom-to handlers wipe activeFilters
  // (intentionally — a fresh zoom shouldn't inherit hand-toggled chips
  // from the previous focus), and setMode also calls this so the
  // curatorial/embeddings split has one source of truth. Keeping it
  // module-scoped so zoomToNode (top-level) and bundle.setMode (inside
  // the IIFE init) can both reach it.
  function applyDefaultFiltersForMode(bundle) {
    if (bundle.fieldMode === 'embeddings') {
      bundle.activeFilters = new Set(['STYLE_KIN', 'VISUALLY_AFFINE']);
    } else {
      bundle.activeFilters = new Set();
    }
  }

  // Dim the brand viz while we're zoomed in (focus the graph layer).
  function setBrandOpacityForZoom(zoomedIn) {
    const targets = [
      document.getElementById('mopey'),
      document.getElementById('myCanvas'),
      document.querySelector('#mopey canvas'),
    ].filter(Boolean);
    const target = zoomedIn ? CFG.BRAND_OPACITY_AT_ZOOM : CFG.BRAND_OPACITY_WHEN_ACTIVE;
    for (const el of targets) {
      el.style.transition = `opacity ${CFG.ZOOM_TRANSITION_MS}ms ease`;
      el.style.opacity = target;
    }
  }

  // ---- Breadcrumb chrome ----
  // field › Vera Molnár ›PRACTICES› algorithmic art ›EMBODIES› [artwork]
  // Each segment is clickable. The edge-type word between segments is in
  // the edge type's accent colour.
  function createBreadcrumb() {
    let el = document.getElementById('adai-breadcrumb');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'adai-breadcrumb';
    Object.assign(el.style, {
      position: 'fixed',
      top: '54px',          // sits below the logotype
      left: '24px',
      zIndex: '40',
      fontFamily: "'SF Mono', 'Menlo', 'Consolas', monospace",
      fontSize: '11px',
      lineHeight: '1.4',
      color: '#aaa',
      maxWidth: 'calc(100vw - 240px)',
      pointerEvents: 'auto',
      userSelect: 'none',
      letterSpacing: '0.02em',
      // single line + horizontal scroll for long paths.
      // Mask fades out the left edge so older segments hint at more history.
      whiteSpace: 'nowrap',
      overflowX: 'auto',
      overflowY: 'hidden',
      scrollbarWidth: 'thin',
      paddingBottom: '4px',
      maskImage: 'linear-gradient(to right, transparent 0, black 24px, black 100%)',
      webkitMaskImage: 'linear-gradient(to right, transparent 0, black 24px, black 100%)',
    });
    document.body.appendChild(el);
    return el;
  }

  function findEdgeBetween(graph, idA, idB) {
    if (!idA || !idB) return null;
    const edges = graph.edgesFor(idA);
    // Prefer the human-attested edge: after the derived layer merges, a pair
    // can be linked by both (e.g. CREATED_BY + STYLE_KIN) and the breadcrumb
    // hop label should read the curated relation, not the embedding one.
    let derived = null;
    for (const e of edges) {
      if ((e.source === idA && e.target === idB) ||
          (e.target === idA && e.source === idB)) {
        if (!isDerivedEdge(e)) return e;
        if (!derived) derived = e;
      }
    }
    return derived;
  }

  function escapeForBreadcrumb(s) {
    return String(s).replace(/[&<>"']/g, ch => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
  }

  function renderBreadcrumb(bundle, graph) {
    const el = createBreadcrumb();
    if (bundle.viewLevel === 'field-reveal') {
      el.innerHTML = '';
      return;
    }
    const history = bundle.history || [];
    // Build path: regenerate control, then each historical focus, then current focus.
    const path = [{ id: null, label: 'regenerate', action: 'regenerate' }];
    for (const h of history) {
      if (h.focusedId) path.push({ id: h.focusedId });
    }
    if (bundle.focusedId) path.push({ id: bundle.focusedId });

    let html = '';
    for (let i = 0; i < path.length; i++) {
      const seg = path[i];
      if (i > 0) {
        // field -> first-node has no edge in the graph; just a separator chevron.
        if (!path[i - 1].id || !seg.id) {
          html += `&nbsp;<span style="color:#444;font-weight:500">›</span>&nbsp;`;
        } else {
          const edge = findEdgeBetween(graph, path[i - 1].id, seg.id);
          const hidden = edge && (CFG.HIDDEN_EDGE_TYPES || []).indexOf(edge.type) >= 0;
          if (!edge || hidden) {
            html += `&nbsp;<span style="color:#444;font-weight:500">›</span>&nbsp;`;
          } else {
            const lib = window.ADAI_EDGE_COLORS;
            const edgeColor = (lib && lib.colorFor(edge.type).hex) || '#444';
            html += `&nbsp;<span style="color:${edgeColor};font-size:9px;letter-spacing:0.08em;font-weight:500">›&nbsp;${escapeForBreadcrumb(edge.type)}&nbsp;›</span>&nbsp;`;
          }
        }
      }
      if (seg.action === 'regenerate') {
        html += `<button type="button" class="adai-bcrumb-seg adai-regenerate-btn" data-idx="${i}" data-action="regenerate" title="Regenerate field"><span class="adai-regenerate-icon" aria-hidden="true">↻</span><span>regenerate</span></button>`;
        continue;
      }

      const node = seg.id ? graph.byId.get(seg.id) : null;
      const name = node ? node.name : seg.label;
      const type = node ? node.type : null;
      const isCurrent = i === path.length - 1;
      const segColor = isCurrent ? '#fff' : '#aaa';
      const cursor = isCurrent ? 'default' : 'pointer';
      const decoration = isCurrent ? 'none' : 'none';
      const typeTag = type ? `<span style="color:#555;font-size:9px;margin-right:3px">${escapeForBreadcrumb(type)}/</span>` : '';
      html += `<span class="adai-bcrumb-seg" data-idx="${i}" data-id="${escapeForBreadcrumb(seg.id || '')}" style="color:${segColor};cursor:${cursor};text-decoration:${decoration}">${typeTag}${escapeForBreadcrumb(name)}</span>`;
    }
    // Action buttons at the end of the breadcrumb (only when there's
    // actually a path beyond field). ★ saves a bookmark, ↗ copies a
    // shareable URL with the path encoded in ?reading=.
    if (path.length > 1) {
      html += '&nbsp;&nbsp;<span class="adai-bcrumb-actions" style="display:inline-flex;gap:4px;align-items:center">';
      html += `<button class="adai-profile-btn" title="Open full profile (i)" style="background:transparent;border:1px solid #2a2a30;color:#888;cursor:pointer;font-size:11px;line-height:1;padding:2px 8px;border-radius:2px;font-family:inherit">profile ⓘ</button>`;
      html += `<button class="adai-bookmark-btn" title="Save this reading" style="background:transparent;border:1px solid #2a2a30;color:#888;cursor:pointer;font-size:11px;line-height:1;padding:2px 6px;border-radius:2px;font-family:inherit">★</button>`;
      html += `<button class="adai-share-btn" title="Copy shareable URL" style="background:transparent;border:1px solid #2a2a30;color:#888;cursor:pointer;font-size:11px;line-height:1;padding:2px 6px;border-radius:2px;font-family:inherit">↗</button>`;
      html += '</span>';
    }
    el.innerHTML = html;
    const profileBtn = el.querySelector('.adai-profile-btn');
    const bookmarkBtn = el.querySelector('.adai-bookmark-btn');
    const shareBtn = el.querySelector('.adai-share-btn');
    if (profileBtn) {
      profileBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (bundle.focusedId && window.ADAI_ENTITY_VIEW) {
          window.ADAI_ENTITY_VIEW.open(bundle.focusedId);
        }
      });
    }
    if (bookmarkBtn) {
      bookmarkBtn.addEventListener('click', () => {
        const saved = saveBookmark(bundle, graph);
        if (saved) flashChromeFeedback(bookmarkBtn, '✓');
        else flashChromeFeedback(bookmarkBtn, 'dup');
        renderBookmarksStrip(bundle, graph);
      }, { once: true });
    }
    if (shareBtn) {
      shareBtn.addEventListener('click', async () => {
        const path2 = pathFromBundle(bundle);
        if (path2.length === 0) return;
        const url = buildShareUrl(path2);
        try {
          await navigator.clipboard.writeText(url);
          flashChromeFeedback(shareBtn, 'copied');
        } catch (err) {
          // Clipboard API may be blocked — fall back to prompt
          window.prompt('Copy this URL', url);
        }
      }, { once: true });
    }

    const regenerateBtn = el.querySelector('.adai-regenerate-btn');
    if (regenerateBtn) {
      regenerateBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        regenerateField();
      }, { once: true });
    }

    // Auto-scroll the breadcrumb so the latest (current) segment is always
    // visible at the right edge. Older segments scroll off-screen left,
    // softened by the mask gradient. Use rAF so layout has finished.
    requestAnimationFrame(() => {
      el.scrollLeft = el.scrollWidth;
    });

    // Wire click teleport-back per segment. stopPropagation matters: the
    // teleport re-renders this breadcrumb synchronously, detaching the
    // clicked span — a still-bubbling event with a detached target slips
    // past the camera layer's isUiClick filter and hijacks the navigation.
    el.querySelectorAll('.adai-bcrumb-seg').forEach(seg => {
      if (seg.dataset.action === 'regenerate') return;
      const idx = parseInt(seg.dataset.idx, 10);
      if (idx === path.length - 1) return;  // current segment is not clickable
      seg.addEventListener('click', (ev) => {
        ev.stopPropagation();
        bcrumbTeleport(bundle, graph, idx, path);
      }, { once: true });
    });
  }

  function regenerateField() {
    const next = new URL(window.location.href);
    next.searchParams.delete('seed');
    next.searchParams.delete('node');
    next.searchParams.delete('reading');
    // A clean /field/<type>/<slug> names a node too: regenerate unfocused.
    next.pathname = '/field';
    next.searchParams.set('regen', String(Date.now()));
    window.location.assign(next.toString());
  }

  // Teleport-back: pop history entries beyond targetIdx, then navigate.
  // Path indices: 0 = field; 1..N = history.focusedId; N+1 = current.
  function bcrumbTeleport(bundle, graph, targetIdx, path) {
    if (bundle.transitioning) return;
    const w = window.innerWidth;
    const h = window.innerHeight;
    if (targetIdx === 0) {
      // Click "field" -> back to 30k. Wipe history, run 30k restore.
      window.ADAI_FIELD_STUDY?.reset?.({ syncGraph: false });
      bundle.history = [];
      // Re-use zoomBack's 30k logic by faking it: directly call internal path
      // by pushing a dummy and popping. Simpler: just call zoomBack repeatedly
      // by setting history to one [30k] item and letting zoomBack pop it.
      bundle.history = [{ level: '30k', focusedId: null }];
      zoomBack(graph, bundle, w, h);
      return;
    }
    // Otherwise: target a historical state. Trim history so that after the
    // navigation, history.length === targetIdx (path index 1 corresponds to
    // history[0], so history length after should be targetIdx — minus the
    // one we'll re-push by zoomToNode? No: we use noPush.).
    // Path[0]=field=history-pre[start]. Path[1] = history[0]. Path[i] = history[i-1].
    // After teleport to path[k], history should have entries [0..k-2] (those
    // older than k), so history.length = k - 1.
    const targetId = path[targetIdx].id;
    bundle.history = bundle.history.slice(0, targetIdx - 1);
    zoomToNode(graph, bundle, targetId, w, h, { noPush: true });
  }

  // ---- Tier 1+2: bookmarks (localStorage) + shareable URL ----
  // A "reading" is the path through the graph: an ordered list of node IDs.
  // Tier 1: save paths to localStorage, list them, click to replay.
  // Tier 2: encode path in URL (?reading=id1,id2,...), copy to clipboard,
  //         auto-replay on load if the param is present.
  // Auth (Tier 3+) is deferred; only readers with a skill key can mutate
  // the graph. For now the public "save" is private-to-device.

  const BOOKMARK_STORAGE_KEY = 'adai.bookmarks.v1';
  const INTRO_SEEN_KEY = 'adai.intro.seen.v1';

  // Onboarding overlay shown to first-time visitors. Fades on first user
  // click anywhere, on ESC, or after a timeout. Hidden on subsequent
  // visits via a localStorage flag.
  function renderIntro() {
    if (localStorage.getItem(INTRO_SEEN_KEY)) return;
    const el = document.createElement('div');
    el.id = 'adai-intro';
    Object.assign(el.style, {
      position: 'fixed',
      left: '50%',
      bottom: '120px',
      transform: 'translateX(-50%)',
      zIndex: '60',
      fontFamily: "'SF Mono', 'Menlo', monospace",
      color: '#E8E6E1',
      background: 'rgba(12,12,14,0.85)',
      border: '1px solid #2a2a30',
      borderRadius: '4px',
      padding: '16px 22px 14px',
      maxWidth: '440px',
      textAlign: 'center',
      pointerEvents: 'auto',           // accept the close-button click
      backdropFilter: 'blur(6px)',
      webkitBackdropFilter: 'blur(6px)',
      transition: 'opacity 800ms ease',
      opacity: '0',
    });
    el.innerHTML = `
      <button class="adai-intro-close" aria-label="dismiss" style="position:absolute;top:6px;right:8px;background:transparent;border:none;color:#666;cursor:pointer;font-size:14px;line-height:1;padding:2px 6px;font-family:inherit">×</button>
      <div style="font-size:9px;letter-spacing:0.18em;text-transform:uppercase;color:#7eb8da;margin-bottom:8px">how to read</div>
      <div style="font-size:13px;color:#fff;margin-bottom:10px">click any bright dot to enter</div>
      <div style="font-size:10px;color:#aaa;line-height:1.7">
        click a neighbour to walk the graph<br>
        <span style="color:#888">esc</span> or click empty to step back<br>
        <span style="color:#888">★</span> save your reading &nbsp;·&nbsp; <span style="color:#888">↗</span> share it
      </div>
    `;
    document.body.appendChild(el);
    requestAnimationFrame(() => { el.style.opacity = '1'; });

    let dismissed = false;
    function dismiss() {
      if (dismissed) return;
      dismissed = true;
      localStorage.setItem(INTRO_SEEN_KEY, '1');
      el.style.opacity = '0';
      setTimeout(() => el.remove(), 900);
      document.removeEventListener('keydown', escDismiss, true);
    }
    function escDismiss(e) { if (e.key === 'Escape') dismiss(); }
    el.querySelector('.adai-intro-close').addEventListener('click', dismiss);
    document.addEventListener('keydown', escDismiss, true);
    // Auto-dismiss after a longer beat — the viewer needs time to read.
    setTimeout(dismiss, 14000);
  }

  function pathFromBundle(bundle) {
    const ids = [];
    for (const h of (bundle.history || [])) {
      if (h.focusedId) ids.push(h.focusedId);
    }
    if (bundle.focusedId) ids.push(bundle.focusedId);
    return ids;
  }

  function readBookmarks() {
    try { return JSON.parse(localStorage.getItem(BOOKMARK_STORAGE_KEY) || '[]'); }
    catch { return []; }
  }

  function writeBookmarks(list) {
    try { localStorage.setItem(BOOKMARK_STORAGE_KEY, JSON.stringify(list)); }
    catch (err) { console.warn('[adai] bookmark write failed:', err.message); }
  }

  function saveBookmark(bundle, graph) {
    const path = pathFromBundle(bundle);
    if (path.length === 0) return null;
    const lastId = path[path.length - 1];
    const lastNode = graph.byId.get(lastId);
    const list = readBookmarks();
    // Dedup: if a bookmark with the exact same path exists, do nothing.
    const key = path.join('|');
    if (list.some(b => b.path.join('|') === key)) return null;
    const entry = {
      id: 'b' + Date.now().toString(36),
      path,
      label: lastNode ? lastNode.name : lastId,
      type: lastNode ? lastNode.type : null,
      savedAt: Date.now(),
    };
    list.push(entry);
    writeBookmarks(list);
    return entry;
  }

  function deleteBookmark(bookmarkId) {
    const list = readBookmarks().filter(b => b.id !== bookmarkId);
    writeBookmarks(list);
  }

  function buildShareUrl(path) {
    // searchParams.set already URL-encodes the value, so just join — don't
    // pre-encode (would produce %25-doubled escaping).
    const url = new URL(window.location.href);
    url.searchParams.set('reading', path.join(','));
    return url.href;
  }

  function readingFromUrl() {
    try {
      const v = new URL(window.location.href).searchParams.get('reading');
      if (!v) return null;
      // searchParams.get already decodes; just split.
      return v.split(',').filter(Boolean);
    } catch { return null; }
  }

  // Replay a path: walk node-by-node with zoomToNode + a tiny pause between
  // hops so each transition can finish. Snapshot mode skips the chain and
  // just jumps to the endpoint.
  // A replay is one navigation among others: starting one, Back/Forward, or
  // any focus change that is not the replay's own hop supersedes it. Each
  // replay holds a generation and stops as soon as it is no longer current.
  function cancelReplay(bundle, opts = {}) {
    bundle.replayGen = (bundle.replayGen || 0) + 1;
    // Any navigation but a replay starting is the visitor's (or Back's): it
    // supersedes the page's initial navigation, and the address must stop
    // waiting for it.
    if (!opts.replayStart) supersedeInitial(bundle);
    // Detach the superseded replay's address batch now, not in its finally a
    // dwell later: the navigation that interrupted it is a step of its own.
    if (bundle.replayBatch) {
      bundle.address?.dropBatch(bundle.replayBatch);
      bundle.replayBatch = null;
    }
    return bundle.replayGen;
  }

  /**
   * The page's initial navigation (a deep link, a reload's restoration, a
   * shared reading, "open on yourself") is pending while bundle.initialNav is
   * set. Superseded — by a focus, Back, anything but its own moves — it is
   * dropped, and so is what the address was told to expect of it (the
   * awaited URL, the replace-instead-of-push allowance): the navigation that
   * superseded it gets its own address and history step at once.
   */
  function supersedeInitial(bundle) {
    if (!bundle.initialNav) return;
    bundle.initialNav = false;
    bundle.address?.cancelLanding();
  }

  /** The initial navigation, after `ms`, unless superseded. `keep`: it stays
   *  initial past the timer (a reading: until its replay ends). */
  function initialNavigation(bundle, fn, ms, opts = {}) {
    bundle.initialNav = true;
    return unlessNavigated(bundle, () => {
      if (!opts.keep) bundle.initialNav = false; // its own moves below do not supersede it
      fn();
    }, ms);
  }

  /** Run `fn` after `ms` unless the field navigated meanwhile (any focus
   *  change, Back/Forward, a replay): scheduled first moves never jump in
   *  on top of what the visitor did since. */
  function unlessNavigated(bundle, fn, ms) {
    const gen = bundle.replayGen || 0;
    return setTimeout(() => { if ((bundle.replayGen || 0) === gen) fn(); }, ms);
  }

  async function replayPath(graph, bundle, path, opts = {}) {
    if (!Array.isArray(path) || path.length === 0) return;
    const w = window.innerWidth;
    const h = window.innerHeight;
    const gen = cancelReplay(bundle, { replayStart: true });
    const current = () => bundle.replayGen === gen;
    if (opts.snapshot) {
      // Build history with everything up to last; jump to last.
      const target = path[path.length - 1];
      bundle.history = path.slice(0, -1).map(id => ({ level: 'node', focusedId: id }));
      // First entry should be the 30k root
      bundle.history.unshift({ level: '30k', focusedId: null });
      zoomToNode(graph, bundle, target, w, h, { noPush: true, fromReplay: true });
      return;
    }
    // Replay: step-by-step. Transition each hop, then dwell so the viewer
    // can read where they've landed before the next move. Skip the dwell
    // on the very last hop — they've arrived. The address follows each hop
    // in place: a replayed reading is one history step (issue #85).
    const batch = bundle.address?.beginBatch();
    bundle.replayBatch = batch || null;
    try {
      for (let i = 0; i < path.length; i++) {
        const id = path[i];
        const isLast = i === path.length - 1;
        while (bundle.transitioning) {
          await new Promise(r => setTimeout(r, 60));
          if (!current()) return;
        }
        if (!current()) return;
        zoomToNode(graph, bundle, id, w, h, { fromReplay: true });
        // wait the transition itself
        await new Promise(r => setTimeout(r, CFG.ZOOM_TRANSITION_MS + 60));
        if (!current()) return;
        // then a longer dwell so the viewer can read this node
        if (!isLast) await new Promise(r => setTimeout(r, CFG.REPLAY_DWELL_MS));
      }
    } finally {
      // Only this replay's own batch (a popstate or an interruption already dropped it).
      if (bundle.replayBatch === batch) bundle.replayBatch = null;
      bundle.address?.endBatch(batch);
      // a reading that was the page's initial navigation is done with it
      if (current() && bundle.initialNav) { bundle.initialNav = false; bundle.address?.cancelLanding(); }
    }
  }

  function flashChromeFeedback(el, text) {
    const orig = el.innerHTML;
    el.innerHTML = `<span style="color:#7eb8da">${text}</span>`;
    setTimeout(() => { el.innerHTML = orig; }, 1100);
  }

  function renderBookmarksStrip(bundle, graph) {
    let el = document.getElementById('adai-bookmarks');
    if (!el) {
      el = document.createElement('div');
      el.id = 'adai-bookmarks';
      Object.assign(el.style, {
        position: 'fixed',
        top: '88px',
        left: '24px',
        zIndex: '40',
        fontFamily: "'SF Mono', 'Menlo', monospace",
        fontSize: '10px',
        color: '#888',
        pointerEvents: 'auto',
        userSelect: 'none',
        display: 'flex',
        flexWrap: 'nowrap',
        gap: '6px',
        maxWidth: 'calc(100vw - 48px)',
        whiteSpace: 'nowrap',
        overflowX: 'auto',
        overflowY: 'hidden',
        scrollbarWidth: 'thin',
        paddingBottom: '4px',
      });
      document.body.appendChild(el);
    }
    const list = readBookmarks();
    if (list.length === 0) { el.innerHTML = ''; return; }
    const recent = list.slice().reverse().slice(0, 8);
    el.innerHTML = '<span style="color:#555;font-size:9px;letter-spacing:0.1em;text-transform:uppercase;align-self:center;margin-right:4px">readings</span>' +
      recent.map(b => {
        const len = b.path.length;
        return `<span class="adai-bookmark-chip" data-id="${b.id}" title="${escapeForBreadcrumb(b.label)} · ${len} hop${len === 1 ? '' : 's'} · click to replay, shift+click to snapshot" style="background:transparent;border:1px solid #2a2a30;color:#aaa;padding:2px 4px 2px 8px;border-radius:2px;cursor:pointer;font-size:9px;letter-spacing:0.04em;display:inline-flex;align-items:center;gap:4px">${b.type ? `<span style="color:#555">${escapeForBreadcrumb(b.type)}/</span>` : ''}${escapeForBreadcrumb(b.label)}<span style="color:#555">·${len}</span><span class="adai-bookmark-del" data-id="${b.id}" title="delete" style="color:#444;cursor:pointer;padding:0 2px;font-size:11px;line-height:1;margin-left:2px">×</span></span>`;
      }).join('');
    el.querySelectorAll('.adai-bookmark-chip').forEach(chip => {
      chip.addEventListener('click', (ev) => {
        ev.stopPropagation();  // replay/delete re-renders strips → chip detaches mid-dispatch
        // × delete sub-element: delete bookmark and stop here.
        if (ev.target && ev.target.classList && ev.target.classList.contains('adai-bookmark-del')) {
          deleteBookmark(ev.target.dataset.id);
          renderBookmarksStrip(bundle, graph);
          return;
        }
        const id = chip.dataset.id;
        const list2 = readBookmarks();
        const b = list2.find(x => x.id === id);
        if (!b) return;
        replayPath(graph, bundle, b.path, { snapshot: ev.shiftKey });
      }, { once: true });
    });
  }

  // ---- Edge-type filter chrome ----
  // Chips showing the edge types in the current view. Click to toggle —
  // active chip = only that type's neighbours are foregrounded, others
  // fade to a faint alpha. Multi-select OR (multiple active chips show
  // their union). Filters reset on every zoom-to.
  function createEdgeFilter() {
    let el = document.getElementById('adai-edge-filter');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'adai-edge-filter';
    Object.assign(el.style, {
      position: 'fixed',
      top: '54px',
      right: '24px',
      zIndex: '40',
      fontFamily: "'SF Mono', 'Menlo', monospace",
      fontSize: '10px',
      color: '#aaa',
      pointerEvents: 'auto',
      userSelect: 'none',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'flex-end',
      gap: '4px',
      maxWidth: '240px',
    });
    document.body.appendChild(el);
    return el;
  }

  function renderEdgeFilter(bundle, graph) {
    const el = createEdgeFilter();
    const ns = bundle.zoomNeighbors || [];
    if (!bundle.viewLevel || bundle.viewLevel === '30k' || bundle.viewLevel === 'field-reveal' || ns.length === 0) {
      el.innerHTML = '';
      return;
    }
    const counts = new Map();
    for (const n of ns) counts.set(n.edgeType, (counts.get(n.edgeType) || 0) + 1);
    bundle.activeFilters = bundle.activeFilters || new Set();
    const sorted = Array.from(counts.entries()).sort((a, b) => a[0].localeCompare(b[0]));
    let html = '';
    for (const [type, count] of sorted) {
      const lib = window.ADAI_EDGE_COLORS;
      const color = (lib && lib.colorFor(type).hex) || '#666';
      const active = bundle.activeFilters.has(type);
      const bg = active ? color : 'transparent';
      const fg = active ? '#fff' : color;
      html += `<span class="adai-filter-chip" data-type="${escapeForBreadcrumb(type)}" style="background:${bg};border:1px solid ${color};color:${fg};padding:2px 8px;border-radius:2px;cursor:pointer;font-size:9px;letter-spacing:0.06em;font-weight:500;transition:background 200ms,color 200ms">${escapeForBreadcrumb(type)}&nbsp;<span style="opacity:0.7">${count}</span></span>`;
    }
    el.innerHTML = html;
    el.querySelectorAll('.adai-filter-chip').forEach(chip => {
      chip.addEventListener('click', (ev) => {
        ev.stopPropagation();  // re-render below detaches the chip mid-dispatch
        const t = chip.dataset.type;
        if (bundle.activeFilters.has(t)) bundle.activeFilters.delete(t);
        else bundle.activeFilters.add(t);
        renderEdgeFilter(bundle, graph);
      }, { once: true });
    });
    const embed = document.getElementById('adai-embed-strip');
    if (embed) requestAnimationFrame(() => positionEmbedStrip(embed));
  }

  // ---- Embedding-neighbours strip (Step 3 zoom companion) ----
  // Compact list of cosine neighbours sourced from /api/neighbours/:type/:slug:
  //   - practitioner / collective  → style kin + AI-suggested attributions
  //   - artwork                    → visually affine + style proximity
  //   - concept / scene            → closest artworks
  // Renders below the edge-filter chip cluster; each row is a clickable chip
  // that delegates to bundle.zoomTo so the strip becomes a navigation surface.
  // Fetched per zoom-to and cached in bundle._embedCache keyed by node id so
  // re-visits don't re-hit the network.
  function createEmbedStrip() {
    let el = document.getElementById('adai-embed-strip');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'adai-embed-strip';
    Object.assign(el.style, {
      position: 'fixed',
      // Sit below the edge-filter chips. The filter cluster is at top:54
      // and is variable-height; 96px clears a couple of chip rows. The
      // strip is scrollable so it never collides with the bookmark dock.
      top: '120px',
      right: '24px',
      zIndex: '40',
      fontFamily: "'SF Mono', 'Menlo', monospace",
      fontSize: '10px',
      color: '#aaa',
      pointerEvents: 'auto',
      userSelect: 'none',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'flex-end',
      gap: '6px',
      maxWidth: '260px',
      maxHeight: 'calc(100vh - 240px)',
      overflowY: 'auto',
    });
    document.body.appendChild(el);
    return el;
  }

  function positionEmbedStrip(el) {
    const filterEl = document.getElementById('adai-edge-filter');
    if (filterEl && filterEl.innerHTML.trim()) {
      const bottom = filterEl.getBoundingClientRect().bottom;
      const top = clamp(bottom + 12, 120, Math.max(120, window.innerHeight - 220));
      el.style.top = `${top}px`;
      el.style.maxHeight = `calc(100vh - ${top + 120}px)`;
    } else {
      el.style.top = '120px';
      el.style.maxHeight = 'calc(100vh - 240px)';
    }
  }

  // ---- Chrome hide toggle (mobile declutter) ------------------------------
  // A single tappable handle that collapses the field's info/control overlays
  // — the right-side edge-filter + embedding strips ("those squares") and the
  // top breadcrumb / logotype / coordinates — so a focused artwork and its
  // relations read clean on a narrow screen. Deliberately KEEPS the bottom
  // rooms nav, the archivist bar, the vitals readout, the canvas content (dots
  // / thumbnails / relation lines / their on-canvas labels), and the handle
  // itself. Pure CSS visibility via the body.field-chrome-hidden class (the
  // hide list lives in style.css — one selector per element, trivial to trim),
  // so there are zero canvas/render changes; it's fully reversible and the
  // choice persists in localStorage. Desktop also gets an 'h' hotkey. The id is
  // adai-* AND a <button>, so field.js's isUiClick / isUiPointer already treat
  // it as chrome — a tap never zooms or starts a pan.
  const CHROME_HIDDEN_KEY = 'adai:field-chrome-hidden';
  let chromeHidden = false;
  try { chromeHidden = localStorage.getItem(CHROME_HIDDEN_KEY) === '1'; } catch (_) {}

  function applyChromeHidden() {
    document.body.classList.toggle('field-chrome-hidden', chromeHidden);
    const btn = document.getElementById('adai-chrome-toggle');
    if (btn) {
      btn.textContent = chromeHidden ? 'show' : 'hide';
      btn.setAttribute('aria-pressed', chromeHidden ? 'true' : 'false');
      btn.title = chromeHidden ? 'Show panels (h)' : 'Hide panels (h)';
    }
    // The cached chrome rects feed on-canvas label placement; invalidate it so
    // labels reflow into the freed space (or back out) on the next frame
    // instead of waiting up to 500ms for the cache to expire.
    chromeRectsCache = { t: 0, rects: [] };
  }

  function setChromeHidden(next) {
    chromeHidden = !!next;
    try { localStorage.setItem(CHROME_HIDDEN_KEY, chromeHidden ? '1' : '0'); } catch (_) {}
    applyChromeHidden();
  }

  function setupChromeToggle() {
    let btn = document.getElementById('adai-chrome-toggle');
    if (!btn) {
      btn = document.createElement('button');
      btn.id = 'adai-chrome-toggle';
      btn.type = 'button';
      btn.setAttribute('aria-label', 'Toggle panels');
      Object.assign(btn.style, {
        position: 'fixed',
        top: '50%',
        right: '6px',
        transform: 'translateY(-50%)',
        zIndex: '45',
        background: 'rgba(10,10,12,0.72)',
        border: '1px solid #2a2a30',
        borderRadius: '2px',
        color: '#888',
        cursor: 'pointer',
        fontFamily: "'SF Mono', 'Menlo', monospace",
        fontSize: '9px',
        letterSpacing: '0.08em',
        lineHeight: '1',
        padding: '8px 7px',
        pointerEvents: 'auto',
        userSelect: 'none',
        backdropFilter: 'blur(4px)',
        WebkitBackdropFilter: 'blur(4px)',
        transition: 'color 160ms, border-color 160ms',
      });
      // stopPropagation: the handle only flips its own label, so it never
      // detaches mid-dispatch — but match the other chrome chips' pattern so
      // the document-level zoomTo in field.js can never see this click.
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        setChromeHidden(!chromeHidden);
      });
      document.body.appendChild(btn);
    }
    applyChromeHidden();
  }

  // ---- Trust hover (edge attribution tooltip) -----------------------------
  // Hovering a solid human-attested neighbour in field-focus surfaces the
  // edge's provenance: `attested by <contributor> · <basis> · <date> · source ↗`.
  // Lazily fetched from /api/edge/attribution (keyed by the edge triple; the
  // stream ships no edge ids) after a short dwell, cached per triple. The
  // tooltip id starts with `adai-` so field.js's isUiClick guard covers the
  // source link, and pointer-events keep it alive while the cursor is on it
  // (the canvas stops receiving pointermove, so hoveredId — and the tip — hold).
  const edgeAttribCache = new Map();
  let edgeAttribKey = null;
  let edgeAttribTimer = null;

  function edgeAttribEl() {
    let el = document.getElementById('adai-edge-attrib');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'adai-edge-attrib';
    Object.assign(el.style, {
      position: 'fixed',
      zIndex: '46',
      display: 'none',
      maxWidth: '340px',
      background: 'rgba(10,10,12,0.94)',
      border: '1px solid #2a2a2c',
      padding: '7px 10px',
      fontFamily: "'SF Mono', 'Menlo', monospace",
      fontSize: '10px',
      lineHeight: '1.6',
      color: '#8a8a8c',
      letterSpacing: '0.03em',
      pointerEvents: 'auto',
    });
    document.body.appendChild(el);
    return el;
  }

  function hideEdgeAttrib() {
    if (edgeAttribTimer) { clearTimeout(edgeAttribTimer); edgeAttribTimer = null; }
    edgeAttribKey = null;
    const el = document.getElementById('adai-edge-attrib');
    if (el) el.style.display = 'none';
  }

  function renderEdgeAttrib(data, edgeType, x, y) {
    const el = edgeAttribEl();
    const color = colorForEdge(edgeType);
    // Several independent sources: one line, everyone who says it underneath.
    const sources = Array.isArray(data.sources) ? data.sources : [];
    if (sources.length > 1) {
      const items = sources.map((s) => {
        const label = escapeForBreadcrumb(s.label || 'unknown');
        return s.source_url && /^https?:\/\//i.test(s.source_url)
          ? `<a href="${escapeForBreadcrumb(s.source_url)}" target="_blank" rel="noopener" style="color:#7eb8da;text-decoration:underline dotted;text-underline-offset:2px">${label}</a>`
          : `<span style="color:#c8c8c8">${label}</span>`;
      });
      el.innerHTML =
        `<div style="color:${color};font-size:9px;letter-spacing:0.08em;margin-bottom:2px">${escapeForBreadcrumb(edgeType)}</div>` +
        `claimed by <span style="color:#c8c8c8">${sources.length} sources</span>: ${items.join(', ')}`;
      el.style.display = 'block';
      const pad = 14;
      const rect = el.getBoundingClientRect();
      el.style.left = `${Math.max(8, Math.min(x + pad, window.innerWidth - rect.width - 8))}px`;
      el.style.top = `${Math.max(8, Math.min(y + pad, window.innerHeight - rect.height - 8))}px`;
      return;
    }
    const parts = [`attested by <span style="color:#c8c8c8">${escapeForBreadcrumb(data.attested_by || 'unknown')}</span>`];
    // Mechanical API titles ("Add edge X: a → b") restate the header — skip.
    if (data.basis && !/^Add (edge|node|signal)\b/.test(data.basis)) parts.push(escapeForBreadcrumb(data.basis));
    if (data.date) parts.push(escapeForBreadcrumb(data.date));
    if (data.source_url && /^https?:\/\//i.test(data.source_url)) {
      parts.push(`<a href="${escapeForBreadcrumb(data.source_url)}" target="_blank" rel="noopener" style="color:#7eb8da;text-decoration:underline dotted;text-underline-offset:2px">source ↗</a>`);
    }
    el.innerHTML =
      `<div style="color:${color};font-size:9px;letter-spacing:0.08em;margin-bottom:2px">${escapeForBreadcrumb(edgeType)}` +
      (data.source_origin ? ` <span style="color:#55555a">· ${escapeForBreadcrumb(data.source_origin)}</span>` : '') +
      `</div>${parts.join(' · ')}`;
    // Place near the pointer, flipped away from the viewport edges.
    el.style.display = 'block';
    const pad = 14;
    const rect = el.getBoundingClientRect();
    const left = Math.min(x + pad, window.innerWidth - rect.width - 8);
    const top = Math.min(y + pad, window.innerHeight - rect.height - 8);
    el.style.left = `${Math.max(8, left)}px`;
    el.style.top = `${Math.max(8, top)}px`;
  }

  function scheduleEdgeAttrib(item, x, y) {
    const e = item && item.edge;
    // Human-attested threads only — embedding-injected items carry edge:null.
    if (!e || item.source === 'embedding' || isDerivedEdge(e)) { hideEdgeAttrib(); return; }
    const key = `${e.source}${e.target}${e.type}`;
    if (key === edgeAttribKey) return;   // already shown/pending for this edge
    hideEdgeAttrib();
    edgeAttribKey = key;
    edgeAttribTimer = setTimeout(() => {
      const show = (data) => { if (edgeAttribKey === key) renderEdgeAttrib(data, e.type, x, y); };
      if (edgeAttribCache.has(key)) { show(edgeAttribCache.get(key)); return; }
      const qs = `source=${encodeURIComponent(e.source)}&target=${encodeURIComponent(e.target)}&type=${encodeURIComponent(e.type)}`;
      fetch(`/api/edge/attribution?${qs}`)
        .then(r => (r.ok ? r.json() : null))
        .then(data => { if (data) { edgeAttribCache.set(key, data); show(data); } })
        .catch(() => {});
    }, 320);
  }

  function syncEmbeddingNeighborsIntoField(payload, bundle, graph) {
    if (bundle.viewLevel !== 'field-focus' || !bundle.focusedId) return;
    // Embedding-sourced threads are embeddings-mode material only. In
    // curatorial mode the strip still LISTS the neighbours (right sidebar),
    // but they must not be merged into the solid field layer — that's the
    // STYLE_KIN-in-the-human-chips leak. setMode re-runs this sync from the
    // payload cache when the user enters embeddings mode.
    if (!derivedVisible(bundle)) return;
    const sections = payload?.sections || [];
    if (!sections.length) return;

    const byId = new Map((bundle.inPlaceNeighbors || []).map(item => [item.id, item]));
    let changed = false;

    for (const section of sections) {
      const edgeType = edgeTypeForEmbeddingSection(section.key);
      const edgeColor = colorForEdge(edgeType);
      for (const n of section.neighbours || []) {
        const id = n.node_id;
        if (!id || id === bundle.focusedId || byId.has(id)) continue;

        const node = graph.byId.get(id);
        const sim = bundle.simById?.get(id);
        if (!node || !sim) continue;

        byId.set(id, {
          id,
          name: n.name || node.name,
          type: n.type || node.type,
          edgeType,
          edgeConfidence: confidenceForSimilarity(n.similarity),
          edgeColor,
          edge: null,
          similarity: n.similarity,
          sim,
          alpha: 1,
          r: CFG.ZOOM_NEIGHBOR_RADIUS,
          groupArtworkCount: 1,
          source: 'embedding',
          embedSectionKey: section.key,
          embedSectionTitle: section.title,
        });
        changed = true;
      }
    }

    if (!changed) return;
    bundle.inPlaceNeighbors = Array.from(byId.values());
    bundle.zoomNeighbors = bundle.inPlaceNeighbors;
    bundle.inPlaceAnchorKey = null;
    bundle.inPlaceVisibleNeighbors = [];
    renderEdgeFilter(bundle, graph);
    const embed = document.getElementById('adai-embed-strip');
    if (embed) requestAnimationFrame(() => positionEmbedStrip(embed));
  }

  function renderEmbedStripPayload(el, payload, bundle, graph) {
    const sections = payload?.sections || [];
    syncEmbeddingNeighborsIntoField(payload, bundle, graph);
    if (!sections.length) {
      el.innerHTML = '<div style="color:#555;font-size:9px;letter-spacing:0.06em">no embedding neighbours</div>';
      return;
    }
    let html = '<div style="color:#888;font-size:9px;letter-spacing:0.08em;text-transform:uppercase;margin-bottom:2px">embedding</div>';
    for (const s of sections) {
      const items = s.neighbours || [];
      if (!items.length) continue;
      const top = items.slice(0, 5);  // strip is space-constrained
      const title = String(s.title || s.key || '').toLowerCase();
      html += `<div class="adai-embed-section" data-key="${escapeForBreadcrumb(s.key || '')}" style="display:flex;flex-direction:column;gap:3px;align-items:flex-end;width:100%">`;
      html += `<div style="color:#888;font-size:9px;letter-spacing:0.04em">${escapeForBreadcrumb(title)} <span style="opacity:0.55">${items.length}</span></div>`;
      for (const n of top) {
        const sim = (typeof n.similarity === 'number') ? n.similarity.toFixed(3) : '—';
        const name = n.name || n.node_id;
        const typeTag = n.type ? `<span style="color:#555;font-size:9px;margin-right:4px">${escapeForBreadcrumb(n.type)}</span>` : '';
        html += `<span class="adai-embed-chip" data-node-id="${escapeForBreadcrumb(n.node_id)}" title="${escapeForBreadcrumb(name)} · cosine ${sim}" style="background:transparent;border:1px solid #2a2a30;color:#c8c8c8;padding:2px 8px;border-radius:2px;cursor:pointer;font-size:9px;line-height:1.4;max-width:240px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:inline-block">${typeTag}${escapeForBreadcrumb(name)}<span style="opacity:0.5;margin-left:6px;font-variant-numeric:tabular-nums">${sim}</span></span>`;
      }
      html += '</div>';
    }
    el.innerHTML = html;
    el.querySelectorAll('.adai-embed-chip').forEach(chip => {
      chip.addEventListener('click', (ev) => {
        ev.stopPropagation();  // zoomTo re-renders this strip → chip detaches mid-dispatch
        const id = chip.dataset.nodeId;
        if (id && typeof bundle.zoomTo === 'function') {
          bundle.zoomTo(id);
        }
      }, { once: true });
    });
  }

  function renderEmbedStrip(bundle, graph) {
    const el = createEmbedStrip();
    positionEmbedStrip(el);
    const focusedId = bundle.focusedId;
    if (!bundle.viewLevel || bundle.viewLevel === '30k' || bundle.viewLevel === 'field-reveal' || !focusedId) {
      el.innerHTML = '';
      return;
    }
    const node = graph.byId.get(focusedId);
    if (!node || !node.slug) { el.innerHTML = ''; return; }

    bundle._embedCache = bundle._embedCache || new Map();
    if (bundle._embedCache.has(focusedId)) {
      const payload = bundle._embedCache.get(focusedId);
      renderEmbedStripPayload(el, payload, bundle, graph);
      return;
    }

    // Prominent animated "computing" cue (the neighbours are computed server
    // side — cosine over precomputed vectors — so this is a network wait, not
    // browser work). Timeout the fetch so a stalled connection (Safari on
    // reload especially) can't leave it spinning forever — fail to a tap-to-retry.
    el.innerHTML = '<div class="adai-embed-loading"><span class="adai-spin"></span>embedding · computing…</div>';
    const url = `/api/neighbours/${encodeURIComponent(node.type)}/${encodeURIComponent(node.slug)}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    fetch(url, { headers: { 'accept': 'application/json' }, signal: ctrl.signal })
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`status ${r.status}`)))
      .then(payload => {
        clearTimeout(timer);
        bundle._embedCache.set(focusedId, payload);
        // Bail out if the user has navigated away while we were fetching.
        if (bundle.focusedId !== focusedId) return;
        renderEmbedStripPayload(el, payload, bundle, graph);
      })
      .catch(err => {
        clearTimeout(timer);
        console.warn('[adai] /api/neighbours fetch failed', err);
        if (bundle.focusedId !== focusedId) return;
        const slow = err && err.name === 'AbortError';
        el.innerHTML = `<div class="adai-embed-retry" role="button" tabindex="0" title="retry">embedding · ${slow ? 'slow to respond' : 'unavailable'} — retry</div>`;
        const retry = el.querySelector('.adai-embed-retry');
        if (retry) retry.addEventListener('click', (e) => {
          // renderEmbedStrip() re-renders this strip via innerHTML and detaches
          // the clicked node mid-dispatch; field.js's isUiClick isConnected guard
          // already catches that, but stopPropagation is the belt-and-suspenders
          // every chrome chip handler uses so the document-level zoomTo never sees it.
          e.stopPropagation();
          bundle._embedCache.delete(focusedId);
          renderEmbedStrip(bundle, graph);
        });
      });
  }

  function pushHistory(bundle) {
    bundle.history = bundle.history || [];
    bundle.history.push({
      level: bundle.viewLevel || '30k',
      focusedId: bundle.focusedId,
    });
  }

  function zoomToNode(graph, bundle, nodeId, canvasW, canvasH, opts = {}) {
    const node = graph.byId.get(nodeId);
    if (!node) return;
    if (!opts.fromFieldStudy && window.ADAI_FIELD_STUDY?.zoomToNode) {
      window.ADAI_FIELD_STUDY.zoomToNode(nodeId, { syncGraph: false });
    }
    // Focus change clears archivist highlights — the rings were context
    // for "what we just talked about", not a sticky overlay. The
    // highlight_nodes tool description documents this contract. Optional
    // chain in case the public API hasn't been wired up yet (zoomToNode
    // is module-scoped; bundle.clearHighlights is attached inside start()).
    focusNodeInPlace(graph, bundle, nodeId, opts);
  }

  function zoomBack(graph, bundle, canvasW, canvasH) {
    if (bundle.transitioning) return;
    cancelReplay(bundle);
    if (!bundle.viewLevel || bundle.viewLevel === '30k') return;
    if (bundle.viewLevel === 'field-focus' || bundle.viewLevel === 'field-reveal') {
      clearInPlaceFocus(bundle, graph);
      return;
    }
    // Same contract as zoomToNode: focus change drops archivist highlights.
    bundle.clearHighlights?.();
    bundle.history = bundle.history || [];
    const prev = bundle.history.pop() || { level: '30k', focusedId: null };

    // Going back to 30k: full reset
    if (prev.level === '30k') {
      bundle.transitioning = true;
      const neighbors = bundle.zoomNeighbors || [];
      const focusObj = bundle.zoomFocus;
      // Save start states
      for (const s of bundle.sim) {
        s.tweenFromX = s.x; s.tweenFromY = s.y; s.tweenFromR = s.r;
        s.tweenFromAlpha = s.alpha != null ? s.alpha : 1;
        s.tweenToX = s.baseX; s.tweenToY = s.baseY; s.tweenToR = s.baseR;
        s.tweenToAlpha = 1;
      }
      for (const n of neighbors) {
        n.fadeFrom = n.alpha;
        n.fadeFromX = n.tx; n.fadeFromY = n.ty; n.fadeFromR = n.tr;
      }
      const focusFromAlpha = focusObj ? focusObj.alpha : 0;
      const focusFromX = focusObj ? focusObj.x : 0;
      const focusFromY = focusObj ? focusObj.y : 0;
      const focusFromR = focusObj ? focusObj.r : 0;
      const cx = bundle.zoomCenter ? bundle.zoomCenter.x : canvasW / 2;
      const cy = bundle.zoomCenter ? bundle.zoomCenter.y : canvasH / 2;

      hideGraphOverlay();
      setBrandOpacityForZoom(false);

      runTween(CFG.ZOOM_TRANSITION_MS, (e) => {
        for (const s of bundle.sim) {
          s.x = s.tweenFromX + (s.tweenToX - s.tweenFromX) * e;
          s.y = s.tweenFromY + (s.tweenToY - s.tweenFromY) * e;
          s.r = s.tweenFromR + (s.tweenToR - s.tweenFromR) * e;
          s.alpha = s.tweenFromAlpha + (s.tweenToAlpha - s.tweenFromAlpha) * e;
        }
        for (const n of neighbors) {
          n.tx = n.fadeFromX + (cx - n.fadeFromX) * e;
          n.ty = n.fadeFromY + (cy - n.fadeFromY) * e;
          n.tr = n.fadeFromR * (1 - e);
          n.alpha = n.fadeFrom * (1 - e);
        }
        if (focusObj) {
          focusObj.x = focusFromX + (cx - focusFromX) * e * 0.5;
          focusObj.y = focusFromY + (cy - focusFromY) * e * 0.5;
          focusObj.r = focusFromR * (1 - e);
          focusObj.alpha = focusFromAlpha * (1 - e);
        }
      }, () => {
        bundle.transitioning = false;
        bundle.viewLevel = '30k';
        bundle.focusedId = null;
        bundle.zoomNeighbors = [];
        bundle.zoomFocus = null;
        renderBreadcrumb(bundle, graph);
        renderEmbedStrip(bundle, graph);
        bundle.address?.changed();
      });
      return;
    }

    // Going back to a previous focused node (any type). Delegate to the
    // unified dispatcher with noPush so we don't re-add this state to history.
    if (prev.focusedId) {
      zoomToNode(graph, bundle, prev.focusedId, canvasW, canvasH, { noPush: true });
    }
  }

  function restoreBrandOpacity() {
    const targets = [
      document.getElementById('mopey'),
      document.getElementById('myCanvas'),
      document.querySelector('#mopey canvas'),
    ].filter(Boolean);
    for (const el of targets) {
      el.style.transition = `opacity ${CFG.ZOOM_TRANSITION_MS}ms ease`;
      el.style.opacity = CFG.BRAND_OPACITY_WHEN_ACTIVE;
    }
  }

  function setGraphFocusActive(active) {
    document.body.classList.toggle('field-graph-focused', !!active);
    syncGraphCanvasVisibility();
  }

  function setGraphRevealActive(active) {
    document.body.classList.toggle('field-graph-revealing', !!active);
    syncGraphCanvasVisibility();
  }

  function graphOverlayActive() {
    return document.body.classList.contains('field-graph-focused') ||
      document.body.classList.contains('field-graph-revealing');
  }

  function syncGraphCanvasVisibility() {
    // Option B: the constellation is the browsable base view, so #graph-canvas
    // stays visible at all times (CSS keeps it at opacity 1). Reveal/focus draw
    // over it; we never hide or clear it here.
    const canvas = document.getElementById('graph-canvas');
    if (!canvas) return;
    canvas.style.display = 'block';
    canvas.style.opacity = '';
  }

  function hideGraphOverlay() {
    setGraphFocusActive(false);
    setGraphRevealActive(false);
    syncGraphCanvasVisibility();
  }

  function clearFieldReveal(bundle) {
    if (fieldRevealTimer) {
      clearTimeout(fieldRevealTimer);
      fieldRevealTimer = null;
    }
    if (bundle) bundle.fieldReveal = null;
    setGraphRevealActive(false);
  }

  function projectFieldDot(sim) {
    if (!sim) return null;
    const api = window.ADAI_FIELD_STUDY;
    if (api?.projectBrandPoint) {
      return api.projectBrandPoint(sim.bx, sim.by, sim.bRad);
    }
    return { x: sim.x, y: sim.y, radius: sim.r || sim.baseR || 2, scale: 1 };
  }

  function projectFieldAnchor(anchor) {
    if (!anchor) return null;
    const api = window.ADAI_FIELD_STUDY;
    if (api?.projectBrandPoint) {
      return api.projectBrandPoint(anchor.x, anchor.y, anchor.radius);
    }
    return { x: anchor.x, y: anchor.y, radius: anchor.radius || 2, scale: 1 };
  }

  function projectInPlaceItem(item) {
    const target = item.fieldAnchor;
    if (target) {
      // Ease the rendered anchor toward its assigned dot in FIELD space —
      // when stickiness does allow a swap, the ring/label/thread glide to
      // the new dot instead of teleporting, and because the easing happens
      // pre-projection it stays locked to the camera during pans/zooms.
      // Time-based exponential smoothing: per-call safe (multiple calls in
      // the same frame advance dt≈0), settles in ~3× the time constant.
      let r = item.renderAnchor;
      if (!r) {
        r = item.renderAnchor = { x: target.x, y: target.y, radius: target.radius, t: 0 };
      } else {
        const now = performance.now();
        const dt = Math.min(120, now - (r.t || now));
        r.t = now;
        if (r.x !== target.x || r.y !== target.y || r.radius !== target.radius) {
          const k = 1 - Math.exp(-dt / CFG.IN_PLACE_ANCHOR_EASE_MS);
          r.x += (target.x - r.x) * k;
          r.y += (target.y - r.y) * k;
          r.radius += (target.radius - r.radius) * k;
          if (Math.abs(target.x - r.x) < 0.05 && Math.abs(target.y - r.y) < 0.05) {
            r.x = target.x; r.y = target.y; r.radius = target.radius;
          }
        }
      }
      return projectFieldAnchor(r);
    }
    return projectFieldDot(item.sim);
  }

  // Focus position for an in-place reveal: the focused node's own field dot,
  // even while it projects off-screen — every caller visiblePoint-guards and
  // simply skips drawing/hit-testing until the dot is in view. Returning the
  // true projection (instead of the old screen-centre fallback for off-screen
  // dots) is what makes focus-to-focus camera flights read correctly: the old
  // focus pans away with the world and the new one rides its dot in, rather
  // than a ghost focus teleporting to screen-centre for the duration of the
  // flight. The centre fallback survives only for a node with no field dot at
  // all, so it renders instead of vanishing. (Edge dots no longer need the
  // fallback: constrainCamera's zoom overscan can centre any field point.)
  function inPlaceFocusPoint(bundle, width, height) {
    const p = projectFieldDot(bundle.simById?.get(bundle.focusedId));
    if (p) return p;
    return {
      x: width / 2,
      y: height / 2,
      radius: clamp(Math.min(width, height) * 0.014, 8, 18),
      scale: 1,
    };
  }

  function visiblePoint(p, width, height, margin = 72) {
    return !!p && p.x >= -margin && p.x <= width + margin && p.y >= -margin && p.y <= height + margin;
  }

  function fieldRegistryDots() {
    return Array.isArray(window.__adaiDotRegistry) ? window.__adaiDotRegistry : [];
  }

  // ---- hover-reveal spatial index ---------------------------------------
  // The hover colour-reveal used to walk the FULL dot registry (tens of
  // thousands of dots) every frame the cursor moved at 30k. Bucket the
  // registry once into a coarse brand-space grid; each frame back-projects
  // the cursor + reveal reach into brand space and visits only the buckets
  // the reveal can touch. The per-dot screen-space falloff test is unchanged,
  // so this is purely a candidate filter — same pixels, far fewer visits.
  const REVEAL_GRID_CELL = 96; // brand units
  let revealGridCache = null;

  function revealGridFor(dots) {
    if (revealGridCache && revealGridCache.registry === dots && revealGridCache.size === dots.length) {
      return revealGridCache.cells;
    }
    const cells = new Map();
    for (let i = 0; i < dots.length; i++) {
      const key = `${(dots[i].x / REVEAL_GRID_CELL) | 0},${(dots[i].y / REVEAL_GRID_CELL) | 0}`;
      let arr = cells.get(key);
      if (!arr) { arr = []; cells.set(key, arr); }
      arr.push(i);
    }
    revealGridCache = { registry: dots, size: dots.length, cells };
    return cells;
  }

  function buildInPlaceNeighbors(graph, bundle, focusedId) {
    const groups = gatherNeighborsByType(graph, focusedId, derivedVisible(bundle));
    const out = [];
    for (const group of groups) {
      for (const item of group.items) {
        // Keep EVERY curated neighbour, even one without its own field dot
        // (a platform like SuperRare, a concept like landscape, etc.). Those get
        // anchored to a free dot near the focus at render time, the same as any
        // other neighbour — dropping them was why an artwork's EXHIBITED_AT /
        // EMBODIES targets showed only "when lucky" (when they happened to be
        // placed in the field that load).
        out.push({
          ...item,
          sim: bundle.simById?.get(item.id) || null,
          alpha: 1,
          r: CFG.ZOOM_NEIGHBOR_RADIUS
        });
      }
    }
    // Cap high fan-out so a hub reads like a normal node (and stays performant).
    // Selection = most-connected, partially randomised: degree times a stable
    // pseudo-random factor (seeded by id, so it doesn't flicker frame-to-frame or
    // between the reveal and focus passes). Better-connected neighbours win on
    // average, but the set is a varied spread rather than a fixed alphabetical
    // slice. Nodes under the cap show all their neighbours (landscape unaffected).
    if (out.length > CFG.MAX_INPLACE_NEIGHBORS) {
      const degree = (id) => (graph.neighborsOf ? graph.neighborsOf(id).size : 0);
      const score = (id) => {
        const noise = (hashString(id) % 1000) / 1000;   // [0,1), deterministic
        return (degree(id) + 1) * (0.6 + 0.8 * noise);   // factor in [0.6, 1.4)
      };
      out.sort((a, b) => score(b.id) - score(a.id));
      out.length = CFG.MAX_INPLACE_NEIGHBORS;
    }
    return out;
  }

  function orderedInPlaceNeighbors(graph, bundle, width, height) {
    const neighbors = bundle.inPlaceNeighbors || [];
    if (neighbors.length <= 1) return { neighbors, layout: null, desiredById: new Map() };

    const layout = computeLayoutFor(graph, bundle.focusedId, width, height, derivedVisible(bundle));
    const itemById = new Map(neighbors.map(item => [item.id, item]));
    const desiredById = new Map();
    const ordered = [];

    for (const desired of layout.neighbors || []) {
      desiredById.set(desired.id, desired);
      const item = itemById.get(desired.id);
      if (item) ordered.push(item);
    }
    for (const item of neighbors) {
      if (!desiredById.has(item.id)) ordered.push(item);
    }

    // Items the layout doesn't know — embedding-sourced neighbours merged in
    // by syncEmbeddingNeighborsIntoField (the layouts only place graph-edge
    // neighbours). Without a desired position their target offset defaulted
    // to (0,0) = the focus point itself, so they all clumped in a tight ring
    // around the focus. Fan them on a deterministic golden-angle mid-ring
    // instead (stable by list index — no flicker between anchor refreshes).
    const extras = ordered.filter(item => !desiredById.has(item.id));
    if (extras.length && layout) {
      const GOLDEN = Math.PI * (3 - Math.sqrt(5)); // ≈137.5° — no two coincide
      const Rx = layout.Rx || Math.min(width, height) * 0.42;
      const Ry = layout.Ry || Math.min(width, height) * 0.42;
      extras.forEach((item, i) => {
        const ang = -Math.PI / 2 + i * GOLDEN;
        const rad = 0.48 + 0.16 * (i % 3) / 2; // stagger 0.48 / 0.56 / 0.64
        desiredById.set(item.id, {
          x: layout.cx + Math.cos(ang) * Rx * rad,
          y: layout.cy + Math.sin(ang) * Ry * rad,
        });
      });
    }

    return { neighbors: ordered, layout, desiredById };
  }

  function visibleAnchoredNeighbors(bundle, width, height) {
    const visible = [];
    for (const item of bundle.inPlaceNeighbors || []) {
      const point = projectInPlaceItem(item);
      if (visiblePoint(point, width, height, CFG.IN_PLACE_ANCHOR_MARGIN)) {
        visible.push({ item, point });
      } else {
        item.labelBBox = null;
      }
    }
    bundle.inPlaceVisibleNeighbors = visible;
    return visible;
  }

  function tangentFromField(point, candidates) {
    const maxR = CFG.IN_PLACE_CURVE_NEAR_RADIUS;
    const maxD2 = maxR * maxR;
    let xx = 0;
    let xy = 0;
    let yy = 0;
    let count = 0;

    for (const c of candidates) {
      const p = c.point;
      const dx = p.x - point.x;
      const dy = p.y - point.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < 1 || d2 > maxD2) continue;

      const w = 1 - d2 / maxD2;
      xx += dx * dx * w;
      xy += dx * dy * w;
      yy += dy * dy * w;
      count++;
    }

    if (count < 4) return null;
    const angle = 0.5 * Math.atan2(2 * xy, xx - yy);
    return { x: Math.cos(angle), y: Math.sin(angle) };
  }

  function orientTangent(tangent, from, to) {
    if (!tangent) return null;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dot = tangent.x * dx + tangent.y * dy;
    return dot < 0 ? { x: -tangent.x, y: -tangent.y } : tangent;
  }

  function buildFieldCurve(focusPoint, point, candidates, width, height) {
    const dx = point.x - focusPoint.x;
    const dy = point.y - focusPoint.y;
    const distance = Math.hypot(dx, dy);
    if (distance < 3) return null;

    let t1 = orientTangent(tangentFromField(focusPoint, candidates), focusPoint, point);
    let t2 = orientTangent(tangentFromField(point, candidates), focusPoint, point);
    if (!t1 && !t2) {
      const normal = { x: -dy / distance, y: dx / distance };
      const centerX = width / 2;
      const centerY = height / 2;
      const sign = Math.sign((focusPoint.x - centerX) * dy - (focusPoint.y - centerY) * dx) || 1;
      t1 = { x: dx / distance + normal.x * 0.85 * sign, y: dy / distance + normal.y * 0.85 * sign };
      t2 = t1;
    } else if (!t1) {
      t1 = t2;
    } else if (!t2) {
      t2 = t1;
    }

    const l1 = Math.hypot(t1.x, t1.y) || 1;
    const l2 = Math.hypot(t2.x, t2.y) || 1;
    t1 = { x: t1.x / l1, y: t1.y / l1 };
    t2 = { x: t2.x / l2, y: t2.y / l2 };

    const control = clamp(distance * CFG.IN_PLACE_CURVE_CONTROL_SCALE, 28, 180);
    let c1x = focusPoint.x + t1.x * control;
    let c1y = focusPoint.y + t1.y * control;
    let c2x = point.x - t2.x * control;
    let c2y = point.y - t2.y * control;

    const midX = (focusPoint.x + point.x) / 2;
    const midY = (focusPoint.y + point.y) / 2;
    const curveMidX = (focusPoint.x + 3 * c1x + 3 * c2x + point.x) / 8;
    const curveMidY = (focusPoint.y + 3 * c1y + 3 * c2y + point.y) / 8;
    const bend = Math.hypot(curveMidX - midX, curveMidY - midY);
    if (bend < CFG.IN_PLACE_CURVE_MIN_BEND) {
      const normal = { x: -dy / distance, y: dx / distance };
      const sign = Math.sign((point.x - width / 2) * dy - (point.y - height / 2) * dx) || 1;
      const extra = CFG.IN_PLACE_CURVE_MIN_BEND - bend;
      c1x += normal.x * extra * sign;
      c1y += normal.y * extra * sign;
      c2x += normal.x * extra * sign;
      c2y += normal.y * extra * sign;
    }

    return { c1x, c1y, c2x, c2y };
  }

  function strokeFieldCurve(ctx, focusPoint, point, curve) {
    ctx.beginPath();
    ctx.moveTo(focusPoint.x, focusPoint.y);
    if (curve) {
      ctx.bezierCurveTo(curve.c1x, curve.c1y, curve.c2x, curve.c2y, point.x, point.y);
    } else {
      ctx.lineTo(point.x, point.y);
    }
    ctx.stroke();
  }

  function labelHeight() {
    return CFG.NAME_TEXT_SIZE + CFG.LABEL_PAD_Y * 2;
  }

  function rectsOverlap(a, b, gap = CFG.LABEL_GAP) {
    return !(
      a.x1 + gap <= b.x0 ||
      a.x0 - gap >= b.x1 ||
      a.y1 + gap <= b.y0 ||
      a.y0 - gap >= b.y1
    );
  }

  function rectInBounds(rect, width, height) {
    return rect.x0 >= CFG.LABEL_MARGIN &&
      rect.y0 >= CFG.LABEL_MARGIN &&
      rect.x1 <= width - CFG.LABEL_MARGIN &&
      rect.y1 <= height - CFG.LABEL_MARGIN;
  }

  function rectHitsAny(rect, occupied) {
    return occupied.some(other => rectsOverlap(rect, other));
  }

  function clipLabelText(ctx, text, maxWidth = CFG.LABEL_MAX_WIDTH) {
    const value = String(text || '');
    if (ctx.measureText(value).width <= maxWidth) return value;
    const ellipsis = '...';
    let lo = 0;
    let hi = value.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (ctx.measureText(value.slice(0, mid) + ellipsis).width <= maxWidth) lo = mid;
      else hi = mid - 1;
    }
    return value.slice(0, Math.max(1, lo)).trimEnd() + ellipsis;
  }

  function makeLabelRect(x, y, textWidth, align) {
    const paddedWidth = textWidth + CFG.LABEL_PAD_X * 2;
    const h = labelHeight();
    let x0 = x - CFG.LABEL_PAD_X;
    if (align === 'right') x0 = x - textWidth - CFG.LABEL_PAD_X;
    if (align === 'center') x0 = x - textWidth / 2 - CFG.LABEL_PAD_X;
    return {
      x0,
      y0: y - h / 2,
      x1: x0 + paddedWidth,
      y1: y + h / 2,
      textX: align === 'right' ? x : align === 'center' ? x : x,
      textY: y,
      align,
    };
  }

  function reserveLabel(occupied, rect) {
    occupied.push({ x0: rect.x0, y0: rect.y0, x1: rect.x1, y1: rect.y1 });
  }

  // Screen rects of the DOM chrome (breadcrumb, bookmark/edge-filter/embed
  // strips, logotype, vitals, rooms nav, archivist bar) so canvas labels are
  // never placed underneath them (review note 14: "avoid graph content
  // underlaying across the top navigation / pathway"). Cached and refreshed
  // at most twice a second — getBoundingClientRect per frame would thrash
  // layout; the chrome moves rarely (renders, dock cycling, resize).
  const CHROME_RECT_SELECTORS = [
    '#adai-breadcrumb', '#adai-bookmarks', '#adai-edge-filter',
    '#adai-embed-strip', '#logotype', '#coordinates', '#vitals',
    '#rooms', '#archivist-bar', '#adai-chrome-toggle',
  ];
  let chromeRectsCache = { t: 0, rects: [] };
  function chromeOccupiedRects() {
    const now = performance.now();
    if (now - chromeRectsCache.t < 500) return chromeRectsCache.rects;
    const rects = [];
    for (const sel of CHROME_RECT_SELECTORS) {
      const el = document.querySelector(sel);
      if (!el) continue;
      // Hidden/empty chrome (display:none, cleared innerHTML) collapses to a
      // ~0-size rect and is skipped here.
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      rects.push({ x0: r.left - 4, y0: r.top - 4, x1: r.right + 4, y1: r.bottom + 4 });
    }
    chromeRectsCache = { t: now, rects };
    return rects;
  }

  function labelBudget(width, height, candidateCount) {
    const areaBudget = Math.floor((width * height) / 52000);
    const max = candidateCount > 36 ? CFG.LABEL_DENSE_MAX_VISIBLE : CFG.LABEL_MAX_VISIBLE;
    return clamp(areaBudget, 10, max);
  }

  function labelPriority(item, point, focusPoint) {
    const directBonus = item.source === 'embedding' ? 0 : 120;
    const confidence = { high: 30, medium: 18, low: 8, unverified: 0 }[item.edgeConfidence] || 0;
    const typeBonus = {
      CREATED_BY: 36,
      COLLABORATES_WITH: 28,
      BELONGS_TO: 22,
      EXHIBITED_AT: 18,
      HELD_BY: 18,
      STYLE_KIN: 14,
      SUGGESTS_CREATED_BY: 14,
      VISUALLY_AFFINE: 8,
      STYLE_PROXIMITY: 6,
    }[item.edgeType] || 4;
    const similarity = typeof item.similarity === 'number' ? item.similarity * 20 : 0;
    const sources = item.edge && item.edge.src > 1 ? 10 * (item.edge.src - 1) : 0;
    const distancePenalty = focusPoint && point ? Math.hypot(point.x - focusPoint.x, point.y - focusPoint.y) / 120 : 0;
    return directBonus + confidence + typeBonus + similarity + sources - distancePenalty;
  }

  function roundedRectPath(ctx, rect, radius = 3) {
    const r = Math.min(radius, (rect.x1 - rect.x0) / 2, (rect.y1 - rect.y0) / 2);
    ctx.beginPath();
    ctx.moveTo(rect.x0 + r, rect.y0);
    ctx.lineTo(rect.x1 - r, rect.y0);
    ctx.quadraticCurveTo(rect.x1, rect.y0, rect.x1, rect.y0 + r);
    ctx.lineTo(rect.x1, rect.y1 - r);
    ctx.quadraticCurveTo(rect.x1, rect.y1, rect.x1 - r, rect.y1);
    ctx.lineTo(rect.x0 + r, rect.y1);
    ctx.quadraticCurveTo(rect.x0, rect.y1, rect.x0, rect.y1 - r);
    ctx.lineTo(rect.x0, rect.y0 + r);
    ctx.quadraticCurveTo(rect.x0, rect.y0, rect.x0 + r, rect.y0);
  }

  function drawReadableLabel(ctx, placed, alpha = 0.78, backingAlpha = 1) {
    ctx.save();
    roundedRectPath(ctx, placed, 3);
    ctx.fillStyle = '#050506';
    ctx.globalAlpha = CFG.LABEL_BG_ALPHA * backingAlpha;
    ctx.fill();
    ctx.strokeStyle = '#FFFFFF';
    ctx.globalAlpha = CFG.LABEL_STROKE_ALPHA * backingAlpha;
    ctx.lineWidth = 0.75;
    ctx.stroke();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = '#FFFFFF';
    ctx.textAlign = placed.align;
    ctx.textBaseline = 'middle';
    ctx.fillText(placed.label, placed.textX, placed.textY);
    ctx.restore();
  }

  function placeLabel(ctx, text, point, preferredVector, width, height, occupied, options = {}) {
    const label = clipLabelText(ctx, text);
    const textWidth = ctx.measureText(label).width;
    const baseOffset = (options.radius || 0) + CFG.LABEL_DOT_CLEARANCE;
    const vx = preferredVector?.x || 1;
    const vy = preferredVector?.y || 0;
    const len = Math.hypot(vx, vy) || 1;
    const ux = vx / len;
    const uy = vy / len;
    const nx = -uy;
    const ny = ux;
    const directions = [
      { x: ux, y: uy },
      { x: ux * 0.78 + nx * 0.62, y: uy * 0.78 + ny * 0.62 },
      { x: ux * 0.78 - nx * 0.62, y: uy * 0.78 - ny * 0.62 },
      { x: nx, y: ny },
      { x: -nx, y: -ny },
      { x: -ux * 0.45 + nx * 0.9, y: -uy * 0.45 + ny * 0.9 },
      { x: -ux * 0.45 - nx * 0.9, y: -uy * 0.45 - ny * 0.9 },
      { x: -ux, y: -uy },
    ];
    const distances = [baseOffset, baseOffset + 12, baseOffset + 28, baseOffset + 46];

    let best = null;
    let bestScore = Infinity;
    for (const dir of directions) {
      const dLen = Math.hypot(dir.x, dir.y) || 1;
      const dx = dir.x / dLen;
      const dy = dir.y / dLen;
      const align = Math.abs(dx) < 0.22 ? 'center' : dx >= 0 ? 'left' : 'right';
      for (const distance of distances) {
        const lx = point.x + dx * distance;
        const ly = point.y + dy * distance;
        const rect = makeLabelRect(lx, ly, textWidth, align);
        if (!rectInBounds(rect, width, height)) continue;
        if (rectHitsAny(rect, occupied)) continue;
        const score = distance + Math.abs(dy) * 3;
        if (score < bestScore) {
          bestScore = score;
          best = { ...rect, label };
        }
      }
    }

    if (!best) return null;
    reserveLabel(occupied, best);
    return best;
  }

  function refreshInPlaceAnchors(graph, bundle, width, height, focusPoint) {
    const focusedSim = bundle.simById?.get(bundle.focusedId);
    if (!focusedSim || !focusPoint) return [];

    const key = [
      bundle.focusedId,
      width,
      height,
      Math.round(focusPoint.x / 10),
      Math.round(focusPoint.y / 10),
      Math.round((focusPoint.scale || 1) * 10)
    ].join(':');
    if (bundle.inPlaceAnchorKey === key && Array.isArray(bundle.inPlaceVisibleNeighbors)) {
      return visibleAnchoredNeighbors(bundle, width, height);
    }

    const { neighbors, layout, desiredById } = orderedInPlaceNeighbors(graph, bundle, width, height);
    const registry = fieldRegistryDots();
    const candidates = [];
    const clearance = Math.max(CFG.IN_PLACE_FOCUS_CLEARANCE, clamp(focusPoint.radius, 4, 18) * 3);

    for (let i = 0; i < registry.length; i++) {
      const dot = registry[i];
      const x = Number(dot.x);
      const y = Number(dot.y);
      const radius = Number(dot.radius);
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(radius) || radius <= 0) continue;

      const point = projectFieldAnchor({ x, y, radius });
      if (!visiblePoint(point, width, height, CFG.IN_PLACE_ANCHOR_MARGIN)) continue;

      const dx = point.x - focusPoint.x;
      const dy = point.y - focusPoint.y;
      const screenDistance = Math.hypot(dx, dy);
      if (screenDistance < clearance) continue;

      candidates.push({
        x,
        y,
        radius,
        point,
        screenDistance,
        angle: Math.atan2(dy, dx),
      });
    }

    candidates.sort((a, b) => a.screenDistance - b.screenDistance);

    const used = new Set();      // candidate indices already selected as anchors
    const blocked = new Set();   // candidates within MIN_SEP of a selected anchor
    const minSep = CFG.IN_PLACE_ANCHOR_MIN_SEP;
    const minSep2 = minSep * minSep;
    const visible = [];
    const layoutCx = layout?.cx ?? width / 2;
    const layoutCy = layout?.cy ?? height / 2;

    // Index candidates by their (stable) field coordinates so an item's
    // previous anchor can be re-claimed across refreshes (stickiness).
    const candIdxByPos = new Map();
    for (let i = 0; i < candidates.length; i++) {
      candIdxByPos.set(candidates[i].x + ',' + candidates[i].y, i);
    }

    const inset = CFG.IN_PLACE_TARGET_INSET;
    const insetTop = CFG.IN_PLACE_TARGET_INSET_TOP;
    const insetBottom = CFG.IN_PLACE_TARGET_INSET_BOTTOM;
    for (const item of neighbors) {
      const desired = desiredById.get(item.id);
      const dx = desired ? (desired.x - layoutCx) * CFG.IN_PLACE_LAYOUT_SCALE : 0;
      const dy = desired ? (desired.y - layoutCy) * CFG.IN_PLACE_LAYOUT_SCALE : 0;
      // Clamp targets to stay inside the viewport (the elliptical layouts
      // reach for the edges; an off-centre focus must not push them past).
      // Top/bottom insets are deeper — they clear the chrome bands.
      const targetX = clamp(focusPoint.x + dx, inset, width - inset);
      const targetY = clamp(focusPoint.y + dy, insetTop, height - insetBottom);
      const targetDistance = Math.hypot(targetX - focusPoint.x, targetY - focusPoint.y);

      // Two-tier pick: prefer the best candidate that keeps MIN_SEP from every
      // already-chosen anchor; fall back to the best remaining one (stacking
      // beats dropping the neighbour when the local field is sparse).
      let bestIdx = -1;
      let bestScore = Infinity;
      let bestSpacedIdx = -1;
      let bestSpacedScore = Infinity;
      for (let i = 0; i < candidates.length; i++) {
        if (used.has(i)) continue;
        const c = candidates[i];
        const distanceScore = Math.hypot(c.point.x - targetX, c.point.y - targetY);
        const radialScore = Math.abs(c.screenDistance - targetDistance) * 0.2;
        const score = distanceScore + radialScore;
        if (score < bestScore) {
          bestScore = score;
          bestIdx = i;
        }
        if (!blocked.has(i) && score < bestSpacedScore) {
          bestSpacedScore = score;
          bestSpacedIdx = i;
        }
      }

      // Sticky re-claim: if this item kept an anchor from the previous
      // refresh and that same registry dot is still available, prefer it
      // unless a new candidate is clearly better (slack in score px).
      // Identity stability beats marginal optimality — re-optimising from
      // scratch on every camera step made near-equivalent dots swap and the
      // threads flick during zoom transitions.
      let pickIdx = bestSpacedIdx >= 0 ? bestSpacedIdx : bestIdx;
      const referenceScore = bestSpacedIdx >= 0 ? bestSpacedScore : bestScore;
      const prev = item.fieldAnchor;
      if (prev) {
        const pi = candIdxByPos.get(prev.x + ',' + prev.y);
        if (pi != null && !used.has(pi) && !blocked.has(pi)) {
          const c = candidates[pi];
          const prevScore = Math.hypot(c.point.x - targetX, c.point.y - targetY)
            + Math.abs(c.screenDistance - targetDistance) * 0.2;
          if (prevScore <= referenceScore + CFG.IN_PLACE_ANCHOR_STICKINESS) pickIdx = pi;
        }
      }
      if (pickIdx >= 0) {
        used.add(pickIdx);
        const chosen = candidates[pickIdx];
        // Block every still-free candidate inside the separation radius so the
        // next neighbours fan out instead of piling onto the same dot cluster.
        for (let i = 0; i < candidates.length; i++) {
          if (used.has(i) || blocked.has(i)) continue;
          const c = candidates[i];
          const sx = c.point.x - chosen.point.x;
          const sy = c.point.y - chosen.point.y;
          if (sx * sx + sy * sy < minSep2) blocked.add(i);
        }
        item.fieldAnchor = chosen;
      } else {
        item.fieldAnchor = null;
      }

      const point = projectInPlaceItem(item);
      if (visiblePoint(point, width, height, CFG.IN_PLACE_ANCHOR_MARGIN)) {
        item.fieldCurve = buildFieldCurve(focusPoint, point, candidates, width, height);
        visible.push({ item, point });
      } else {
        item.labelBBox = null;
        item.fieldCurve = null;
      }
    }

    bundle.inPlaceAnchorKey = key;
    bundle.inPlaceVisibleNeighbors = visible;
    return visible;
  }

  function drawRevealPick(ctx, point, color, radius, alpha, pulse) {
    const glowRadius = radius * (3 + pulse * 0.7);
    ctx.fillStyle = color;
    ctx.globalAlpha = alpha * 0.15;
    ctx.beginPath();
    ctx.arc(point.x, point.y, glowRadius, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = color;
    ctx.globalAlpha = alpha;
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.arc(point.x, point.y, radius * (1.72 + pulse * 0.18), 0, Math.PI * 2);
    ctx.stroke();

    ctx.strokeStyle = '#FFFFFF';
    ctx.globalAlpha = alpha * 0.58;
    ctx.lineWidth = 0.95;
    ctx.beginPath();
    ctx.arc(point.x, point.y, radius * 1.12, 0, Math.PI * 2);
    ctx.stroke();

    ctx.fillStyle = '#FFFFFF';
    ctx.globalAlpha = alpha * 0.92;
    ctx.beginPath();
    ctx.arc(point.x, point.y, Math.max(1.4, radius * 0.24), 0, Math.PI * 2);
    ctx.fill();
  }

  function rgbForHex(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
    if (!m) return { r: 255, g: 255, b: 255 };
    const n = parseInt(m[1], 16);
    return {
      r: (n >> 16) & 255,
      g: (n >> 8) & 255,
      b: n & 255,
    };
  }

  function rgbaForHex(hex, alpha) {
    const { r, g, b } = rgbForHex(hex);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  function drawCentralFocusGlow(ctx, point, radius, accent = '#FFFFFF', pulse = 0.5, alphaScale = 1) {
    const r = Math.max(radius, 5);
    const outer = r * CFG.FIELD_FOCUS_GLOW_RADIUS * (1 + pulse * 0.04);

    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    const gradient = ctx.createRadialGradient(point.x, point.y, 0, point.x, point.y, outer);
    gradient.addColorStop(0, `rgba(255, 255, 255, ${CFG.FIELD_FOCUS_GLOW_ALPHA * alphaScale})`);
    gradient.addColorStop(0.22, rgbaForHex(accent, 0.2 * alphaScale));
    gradient.addColorStop(0.58, rgbaForHex(accent, 0.06 * alphaScale));
    gradient.addColorStop(1, 'rgba(255, 255, 255, 0)');
    ctx.fillStyle = gradient;
    ctx.globalAlpha = 1;
    ctx.beginPath();
    ctx.arc(point.x, point.y, outer, 0, Math.PI * 2);
    ctx.fill();

    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#FFFFFF';
    ctx.globalAlpha = 0.26 * alphaScale;
    ctx.beginPath();
    ctx.arc(point.x, point.y, r * 3.05, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = accent;
    ctx.globalAlpha = 0.92 * alphaScale;
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    ctx.arc(point.x, point.y, r * (2.18 + pulse * 0.16), 0, Math.PI * 2);
    ctx.stroke();

    ctx.strokeStyle = '#FFFFFF';
    ctx.globalAlpha = alphaScale;
    ctx.lineWidth = 1.45;
    ctx.beginPath();
    ctx.arc(point.x, point.y, r * 1.42, 0, Math.PI * 2);
    ctx.stroke();

    ctx.fillStyle = '#FFFFFF';
    ctx.globalAlpha = 0.96 * alphaScale;
    ctx.beginPath();
    ctx.arc(point.x, point.y, Math.max(2.2, r * 0.32), 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function drawInPlaceReveal(ctx, bundle, graph, width, height, filterMatch, revealAlpha = 1, revealState = bundle.fieldReveal) {
    const focusedSim = bundle.simById?.get(bundle.focusedId);
    const focusPoint = inPlaceFocusPoint(bundle, width, height);
    if (!visiblePoint(focusPoint, width, height, 140)) return;

    const startedAt = revealState?.startedAt || performance.now();
    const elapsed = performance.now() - startedAt;
    const visibleNeighbors = refreshInPlaceAnchors(graph, bundle, width, height, focusPoint);
    const focusRadius = clamp(focusPoint.radius, 4, 18);
    const pulse = 0.5 + 0.5 * Math.sin(elapsed / 120);

    const picked = visibleNeighbors
      .filter(({ item }) => filterMatch(item))
      .sort((a, b) => labelPriority(b.item, b.point, focusPoint) - labelPriority(a.item, a.point, focusPoint))
      .slice(0, CFG.FIELD_REVEAL_MAX_NODES);

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    drawCentralFocusGlow(ctx, focusPoint, focusRadius * 1.15, colorForNode(focusedSim), pulse, revealAlpha);

    picked.forEach(({ item, point }, index) => {
      const reveal = clamp((elapsed - index * CFG.FIELD_REVEAL_STAGGER_MS) / 360, 0, 1);
      if (reveal <= 0) return;
      const eased = 1 - Math.pow(1 - reveal, 3);
      const radius = clamp(point.radius, 3, 13);
      drawRevealPick(ctx, point, item.edgeColor || '#E8E6E1', radius, eased * revealAlpha, pulse);
    });

    ctx.restore();
  }

  function focusNodeInPlace(graph, bundle, nodeId, opts = {}) {
    const node = graph.byId.get(nodeId);
    if (!node) return;
    if (!opts.fromReplay && !opts.fromReveal) cancelReplay(bundle);
    // Every node is placed in the field now, so the focus always renders here.
    // (If a node ever lacked a dot, inPlaceFocusPoint centres it rather than
    // falling back to any legacy view.)
    const revealBlend = opts.fromReveal
      ? {
          ...(bundle.fieldReveal || {}),
          focusedId: nodeId,
          startedAt: bundle.fieldReveal?.startedAt || (performance.now() - CFG.FIELD_REVEAL_MS),
          focusStartedAt: performance.now(),
        }
      : null;
    clearFieldReveal(bundle);
    if (!opts.noPush && bundle.focusedId && bundle.focusedId !== nodeId) pushHistory(bundle);
    bundle.clearHighlights?.();
    bundle.viewLevel = 'field-focus';
    bundle.focusedId = nodeId;
    bundle.zoomFocus = null;
    bundle.zoomCenter = null;
    bundle.outgoingNeighbors = [];
    bundle.transitioning = false;
    hideEdgeAttrib();
    applyDefaultFiltersForMode(bundle);
    bundle.inPlaceNeighbors = buildInPlaceNeighbors(graph, bundle, nodeId);
    bundle.zoomNeighbors = bundle.inPlaceNeighbors;
    bundle.inPlaceAnchorKey = null;
    bundle.inPlaceVisibleNeighbors = [];
    bundle.fieldFocusBlend = revealBlend;
    setGraphFocusActive(true);
    renderBreadcrumb(bundle, graph);
    renderEdgeFilter(bundle, graph);
    renderEmbedStrip(bundle, graph);
    renderBookmarksStrip(bundle, graph);
    bundle.address?.changed();
  }

  function revealNodeInPlace(graph, bundle, nodeId, opts = {}) {
    const node = graph.byId.get(nodeId);
    if (!node) return;
    if (!opts.fromReplay) cancelReplay(bundle);
    // Streaming-safety (see focusNodeInPlace): off-field nodes can't anchor the
    // reveal animation, so skip straight to the focus path, which falls back to
    // the legacy zoom view for them.
    if (!bundle.simById || !bundle.simById.has(nodeId)) {
      focusNodeInPlace(graph, bundle, nodeId, opts);
      return;
    }
    clearFieldReveal(bundle);
    if (!opts.noPush && bundle.focusedId && bundle.focusedId !== nodeId) pushHistory(bundle);
    bundle.clearHighlights?.();
    bundle.viewLevel = 'field-reveal';
    bundle.focusedId = nodeId;
    bundle.zoomFocus = null;
    bundle.zoomCenter = null;
    bundle.outgoingNeighbors = [];
    bundle.transitioning = false;
    applyDefaultFiltersForMode(bundle);
    bundle.inPlaceNeighbors = buildInPlaceNeighbors(graph, bundle, nodeId);
    bundle.zoomNeighbors = bundle.inPlaceNeighbors;
    bundle.inPlaceAnchorKey = null;
    bundle.inPlaceVisibleNeighbors = [];
    bundle.fieldReveal = {
      focusedId: nodeId,
      startedAt: performance.now(),
    };
    setGraphFocusActive(false);
    setGraphRevealActive(true);
    renderBreadcrumb(bundle, graph);
    renderEdgeFilter(bundle, graph);
    renderEmbedStrip(bundle, graph);
    renderBookmarksStrip(bundle, graph);
    bundle.address?.changed();

    fieldRevealTimer = setTimeout(() => {
      fieldRevealTimer = null;
      if (bundle.fieldReveal?.focusedId !== nodeId) return;
      focusNodeInPlace(graph, bundle, nodeId, { ...opts, noPush: true, fromReveal: true });
    }, CFG.FIELD_REVEAL_MS);
  }

  function clearInPlaceFocus(bundle, graph) {
    cancelReplay(bundle);
    clearFieldReveal(bundle);
    hideEdgeAttrib();
    bundle.fieldFocusBlend = null;
    bundle.viewLevel = '30k';
    bundle.focusedId = null;
    bundle.zoomNeighbors = [];
    bundle.inPlaceNeighbors = [];
    bundle.inPlaceAnchorKey = null;
    bundle.inPlaceVisibleNeighbors = [];
    bundle.zoomFocus = null;
    bundle.zoomCenter = null;
    bundle.transitioning = false;
    hideGraphOverlay();
    renderBreadcrumb(bundle, graph);
    renderEdgeFilter(bundle, graph);
    renderEmbedStrip(bundle, graph);
    renderBookmarksStrip(bundle, graph);
    bundle.address?.changed();
  }

  function drawInPlaceFocus(ctx, bundle, graph, width, height, filterMatch, dimmedAlpha, focusAlpha = 1) {
    const focusedSim = bundle.simById?.get(bundle.focusedId);
    const focusPoint = inPlaceFocusPoint(bundle, width, height);
    if (!visiblePoint(focusPoint, width, height, 140)) return;

    const focusRadius = clamp(focusPoint.radius, 4, 18);
    const visibleNeighbors = refreshInPlaceAnchors(graph, bundle, width, height, focusPoint);

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    for (const { item, point } of visibleNeighbors) {
      const baseA = CFG.EDGE_THREAD_ALPHA;
      const a = (filterMatch(item) ? baseA : baseA * dimmedAlpha) * focusAlpha;
      if (a < 0.01) continue;
      const baseWidth = CFG.EDGE_THREAD_WIDTH_BY_CONFIDENCE[item.edgeConfidence] || CFG.EDGE_THREAD_WIDTH_DEFAULT;
      applyEdgeThreadStyle(ctx, item, a, baseWidth);
      strokeFieldCurve(ctx, focusPoint, point, item.fieldCurve);
    }
    resetEdgeThreadStyle(ctx);

    // Hover magnification (review note 17): the hovered item's dot/thumb
    // grows by IN_PLACE_HOVER_MAGNIFY, eased per frame so it breathes in
    // and out rather than popping. Hovered item draws LAST so the enlarged
    // thumb sits above its packed neighbours.
    const hovId = bundle.getHoveredId ? bundle.getHoveredId() : null;
    const drawNeighbourDot = ({ item, point }) => {
      const matched = filterMatch(item);
      const a = (matched ? 1 : 0.16) * focusAlpha;
      const targetMag = item.id === hovId ? CFG.IN_PLACE_HOVER_MAGNIFY : 1;
      item._mag = (item._mag == null ? 1 : item._mag) + (targetMag - (item._mag == null ? 1 : item._mag)) * 0.28;
      if (Math.abs(item._mag - targetMag) < 0.01) item._mag = targetMag;
      const m = item._mag;
      const r = clamp(point.radius, 3, 13) * m;
      // Artwork neighbours render as their thumbnail; the edge-coloured ring
      // around it still encodes the relationship type. Non-artworks (and
      // unloaded images) stay as a coloured dot.
      const node = graph.byId.get(item.id);
      const img = matched ? getImageFor(node) : null;
      const tr = clamp(clamp(point.radius, 3, 13) * 1.8, 8, 30) * m; // thumbnail radius
      const ringR = img ? tr + 3 : r * 1.55;     // edge ring sits outside the thumb

      ctx.globalAlpha = a;
      ctx.strokeStyle = item.edgeColor || '#E8E6E1';
      ctx.lineWidth = matched ? 1.65 : 0.85;
      ctx.beginPath();
      ctx.arc(point.x, point.y, ringR, 0, Math.PI * 2);
      ctx.stroke();

      if (!matched) return;

      if (img) {
        ctx.globalAlpha = focusAlpha;
        drawCircleImage(ctx, img, point.x, point.y, tr);
        return;
      }

      ctx.globalAlpha = 0.32 * focusAlpha;
      ctx.fillStyle = item.edgeColor || '#E8E6E1';
      ctx.beginPath();
      ctx.arc(point.x, point.y, r * 0.72, 0, Math.PI * 2);
      ctx.fill();

      ctx.globalAlpha = 0.95 * focusAlpha;
      ctx.fillStyle = '#FFFFFF';
      ctx.beginPath();
      ctx.arc(point.x, point.y, Math.max(1.4, r * 0.28), 0, Math.PI * 2);
      ctx.fill();
    };
    let hoveredEntry = null;
    for (const entry of visibleNeighbors) {
      if (entry.item.id === hovId) { hoveredEntry = entry; continue; }
      drawNeighbourDot(entry);
    }
    if (hoveredEntry) drawNeighbourDot(hoveredEntry);

    const focusPulse = 0.5 + 0.5 * Math.sin(performance.now() / 520);
    drawCentralFocusGlow(ctx, focusPoint, focusRadius, colorForNode(focusedSim), focusPulse, focusAlpha);
    // If the focused node is an artwork, show its image as a hero thumbnail
    // inside the glow.
    const focusImg = getImageFor(graph.byId.get(bundle.focusedId));
    if (focusImg) {
      ctx.globalAlpha = focusAlpha;
      drawCircleImage(ctx, focusImg, focusPoint.x, focusPoint.y, clamp(focusRadius * 2.4, 20, CFG.THUMB_HERO_RADIUS));
    }

    if (!bundle.transitioning) {
      // Seed with the DOM chrome rects so labels never render under the
      // breadcrumb/strips/nav (copied — reserveLabel mutates the array).
      const occupiedLabels = chromeOccupiedRects().slice();
      const focusNode = graph.byId.get(bundle.focusedId);
      ctx.font = `13px 'SF Mono', monospace`;
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#FFFFFF';
      ctx.globalAlpha = focusAlpha;
      const focusLabel = placeLabel(
        ctx,
        focusNode?.name || focusedSim?.name || bundle.focusedId,
        focusPoint,
        { x: 0, y: 1 },
        width,
        height,
        occupiedLabels,
        { radius: focusRadius * 2.55 + 4 }
      );
      if (focusLabel) {
        drawReadableLabel(ctx, focusLabel, focusAlpha, focusAlpha);
      }

      ctx.font = `${CFG.NAME_TEXT_SIZE}px 'SF Mono', monospace`;
      ctx.textBaseline = 'middle';
      // Try to label every visible neighbour, highest-priority first. placeLabel
      // drops only those that would overlap, so we get as many readable labels as
      // fit instead of an arbitrary budget that left nodes silently unlabelled.
      const labelItems = visibleNeighbors
        .filter(({ item }) => filterMatch(item))
        .sort((a, b) => {
          // Hovered item always labels first (its magnified thumb is the
          // one the visitor is deciding whether to click).
          const hovBonus = (it) => (it.id === hovId ? 10000 : 0);
          return (labelPriority(b.item, b.point, focusPoint) + hovBonus(b.item))
               - (labelPriority(a.item, a.point, focusPoint) + hovBonus(a.item));
        });
      for (const { item, point } of visibleNeighbors) item.labelBBox = null;
      for (const { item, point } of labelItems) {
        if (!filterMatch(item)) { item.labelBBox = null; continue; }
        const dx = point.x - focusPoint.x;
        const dy = point.y - focusPoint.y;
        const d = Math.hypot(dx, dy) || 1;
        const name = item.name || (item.id || '').split(':')[1] || item.id;
        const placed = placeLabel(
          ctx,
          name,
          point,
          { x: dx / d, y: dy / d },
          width,
          height,
          occupiedLabels,
          { radius: clamp(point.radius, 3, 13) }
        );
        if (!placed) {
          item.labelBBox = null;
          continue;
        }
        drawReadableLabel(ctx, placed, 0.98 * focusAlpha, focusAlpha);
        item.labelBBox = placed;
      }
    }

    ctx.restore();
  }

  function hitInPlaceNode(bundle, x, y, width, height) {
    const focusSim = bundle.simById?.get(bundle.focusedId);
    const focusPoint = inPlaceFocusPoint(bundle, width, height);
    if (visiblePoint(focusPoint, width, height, 96)) {
      const fr = Math.max(clamp(focusPoint.radius, 4, 18) * 2.6, CFG.CLICK_TOLERANCE);
      const dx = focusPoint.x - x;
      const dy = focusPoint.y - y;
      if (dx * dx + dy * dy <= fr * fr) return { id: bundle.focusedId, role: 'focus' };
    }

    let best = null;
    let bestD2 = CFG.CLICK_TOLERANCE * CFG.CLICK_TOLERANCE;
    for (const n of bundle.inPlaceNeighbors || []) {
      const p = projectInPlaceItem(n);
      if (!visiblePoint(p, width, height, 80)) continue;
      const r = Math.max(clamp(p.radius, 3, 13) * 1.8, CFG.CLICK_TOLERANCE);
      const dx = p.x - x;
      const dy = p.y - y;
      const d2 = dx * dx + dy * dy;
      if (d2 <= r * r && d2 < bestD2) {
        bestD2 = d2;
        best = { id: n.id, role: 'neighbor', item: n };
      }
    }
    return best;
  }

  // ---- render loop ----
  async function start(graph) {
    const canvas = ensureCanvas();
    let { ctx, w, h } = sizeCanvas(canvas);

    // Wait for the spiral registry (the Shape-of-Time dots we bind to).
    const brand = await waitForRegistry();
    if (!brand) {
      console.warn('[adai] dotRegistry unavailable — skipping graph layer');
      return;
    }
    console.log(`[adai] dotRegistry: ${brand.positions.length} brand positions; graph: ${graph.nodes.length} nodes`);

    const bundle = pairNodesToPositions(graph, brand);
    reproject(bundle);
    console.log(`[adai] snapshot: ${bundle.snapshotSize} nodes placed over ${bundle.distinctCount} distinct brand positions`);
    restoreBrandOpacity();

    window.ADAI_GRAPH_FIELD = bundle;
    bundle.simById = new Map(bundle.sim.map(s => [s.id, s]));
    bundle.brandPointForNode = (id) => {
      const s = bundle.simById.get(id);
      if (!s) return null;
      return { id: s.id, name: s.name, type: s.type, x: s.bx, y: s.by, radius: s.bRad };
    };
    bundle.findNearestBrandPoint = (brandX, brandY, opts = {}) => {
      const maxDistance = Number.isFinite(opts.maxDistance) ? opts.maxDistance : Infinity;
      let best = null;
      let bestD2 = maxDistance * maxDistance;
      for (const s of bundle.sim) {
        const dx = s.bx - brandX;
        const dy = s.by - brandY;
        const d2 = dx * dx + dy * dy;
        if (d2 < bestD2) {
          bestD2 = d2;
          best = s;
        }
      }
      if (!best) return null;
      return {
        id: best.id,
        name: best.name,
        type: best.type,
        x: best.bx,
        y: best.by,
        radius: best.bRad,
        distance: Math.sqrt(bestD2)
      };
    };
    bundle.focusNearestBrandPoint = (brandX, brandY, opts = {}) => {
      const hit = bundle.findNearestBrandPoint(brandX, brandY, opts);
      if (!hit) return null;
      revealNodeInPlace(graph, bundle, hit.id, { ...opts, fromFieldStudy: true });
      return hit;
    };
    bundle.focusInPlace = (id, opts = {}) => {
      if (!id || !graph.byId.has(id)) return;
      focusNodeInPlace(graph, bundle, id, opts);
    };
    bundle.revealInPlace = (id, opts = {}) => {
      if (!id || !graph.byId.has(id)) return;
      revealNodeInPlace(graph, bundle, id, opts);
    };
    // Public navigation API — used by the search palette and other surfaces
    // to zoom into a specific node without synthesising a canvas click.
    bundle.zoomTo = (id, opts = {}) => {
      if (!id || !graph.byId.has(id)) return;
      zoomToNode(graph, bundle, id, w, h, opts);
    };

    // ---- Public API for the archivist chat (and any other driver) ----
    // Single side-effect contract: every method mutates bundle state, never
    // touches DOM directly. The frame loop reads bundle.highlightedIds /
    // bundle.fieldMode and renders accordingly.
    bundle.highlightedIds = new Set();
    let highlightTimer = null;
    bundle.highlightNodes = (ids, ttlMs = 30000) => {
      if (!Array.isArray(ids)) return;
      bundle.highlightedIds = new Set(ids.filter(id => graph.byId.has(id)));
      if (highlightTimer) clearTimeout(highlightTimer);
      if (ttlMs > 0) highlightTimer = setTimeout(() => {
        bundle.highlightedIds = new Set();
        highlightTimer = null;
      }, ttlMs);
    };
    bundle.clearHighlights = () => {
      if (highlightTimer) { clearTimeout(highlightTimer); highlightTimer = null; }
      bundle.highlightedIds = new Set();
    };
    bundle.hideOverlay = () => {
      clearFieldReveal(bundle);
      hideGraphOverlay();
    };
    bundle.zoomToHome = (opts = {}) => {
      if (!bundle.viewLevel || bundle.viewLevel === '30k') {
        hideGraphOverlay();
        clearFieldReveal(bundle);
        return;
      }
      if (opts.syncField !== false) {
        window.ADAI_FIELD_STUDY?.reset?.({ syncGraph: false });
      }
      if (bundle.viewLevel === 'field-focus' || bundle.viewLevel === 'field-reveal') {
        clearInPlaceFocus(bundle, graph);
        return;
      }
      // Same trick the empty-space click uses: collapse history so a single
      // zoomBack walks all the way out.
      bundle.history = [{ level: '30k', focusedId: null }];
      zoomBack(graph, bundle, w, h);
    };
    // Field mode: 'curatorial' (default) or 'embeddings'. Sets activeFilters
    // so when the user (or the archivist) zooms into a node, the right edge
    // types are foregrounded. The filter chip cluster still lets the user
    // override per-zoom.
    //
    // The mode is sticky: applyDefaultFiltersForMode (called from both
    // zoom-to handlers) re-applies the right filter set after every
    // zoom-to so e.g. set_field_mode('embeddings') followed by
    // focus_node(...) doesn't silently lose the embeddings foregrounding.
    bundle.fieldMode = 'curatorial';
    // Rebuild the focused node's neighbour set for the current mode: the
    // builders exclude derived edges in curatorial mode and include them in
    // embeddings mode, so a mid-focus mode flip must re-derive the list (and
    // re-merge the embed-strip neighbours from cache when entering
    // embeddings — renderEmbedStrip re-runs the sync off its payload cache).
    const rebuildFocusForMode = () => {
      if (bundle.viewLevel !== 'field-focus' || !bundle.focusedId) return;
      bundle.inPlaceNeighbors = buildInPlaceNeighbors(graph, bundle, bundle.focusedId);
      bundle.zoomNeighbors = bundle.inPlaceNeighbors;
      bundle.inPlaceAnchorKey = null;
      bundle.inPlaceVisibleNeighbors = [];
      renderEmbedStrip(bundle, graph);
    };
    bundle.setMode = (mode) => {
      if (mode !== 'curatorial' && mode !== 'embeddings') return;
      const changed = bundle.fieldMode !== mode;
      bundle.fieldMode = mode;
      // STYLE_KIN / VISUALLY_AFFINE are excluded from the initial streamed
      // payload (they're ~10k edges only ever shown here) and lazy-loaded the
      // first time we enter embeddings mode. Once the loader merges them into
      // the live index, re-apply filters so the chips + edge rendering pick
      // them up. The frame loop reads edgesFor() live, so no explicit redraw.
      if (mode === 'embeddings' && !bundle.derivedRequested
          && typeof window.ADAI_LOAD_DERIVED === 'function') {
        bundle.derivedRequested = true;
        window.ADAI_LOAD_DERIVED().then(() => {
          // Still in embeddings mode? Rebuild the focused neighbour set so
          // the freshly merged derived edges actually appear.
          if (bundle.fieldMode === 'embeddings') rebuildFocusForMode();
          applyDefaultFiltersForMode(bundle);
          renderEdgeFilter(bundle, graph);
        }).catch(() => {});
      }
      if (changed) rebuildFocusForMode();
      applyDefaultFiltersForMode(bundle);
      renderEdgeFilter(bundle, graph);
    };

    // ---- chrome ----
    setupChromeToggle();   // declutter handle — applies the persisted hide state
    renderIntro();
    renderBreadcrumb(bundle, graph);
    renderEdgeFilter(bundle, graph);
    renderEmbedStrip(bundle, graph);
    renderBookmarksStrip(bundle, graph);

    // Curated edges stream in just after the constellation paints (the loader
    // posts nodes first). Re-render the edge-dependent chrome once they land so
    // the filter chip counts reflect the real graph. The frame loop reads
    // edgesFor() live, so the field itself needs no nudge. once:true — a fresh
    // page load only streams once (repeat visits arrive complete from cache).
    window.addEventListener('adai:graph-edges', () => {
      renderEdgeFilter(bundle, graph);
      renderBreadcrumb(bundle, graph);
    }, { once: true });

    // ---- the address follows the field (issue #85) ----
    // /field/<type>/<slug> names the open profile, else the focused node;
    // each change is a history step, Back/Forward re-apply an entry
    // (public/field/js-interface/field-address.js).
    function focusOn(id) {
      if (!id || !graph.byId.has(id) || bundle.focusedId === id) return;
      if (window.ADAI_FIELD_STUDY?.zoomToNode?.(id)) return;
      bundle.revealInPlace(id);
    }
    bundle.address = window.ADAI_FIELD_ADDRESS?.create({
      win: window,
      nodeFor: (id) => graph.byId.get(id) || null,
      read: () => {
        const ev = window.ADAI_ENTITY_VIEW;
        return { focusId: bundle.focusedId || null, profileId: ev?.isOpen ? (ev.currentId || null) : null };
      },
      idFromLocation: () => deepLinkTarget().id,
      // Back/Forward is a navigation: a reading still replaying stops there.
      interrupted: () => cancelReplay(bundle),
      apply: ({ id, profile, focus }) => {
        const ev = window.ADAI_ENTITY_VIEW;
        if (profile && id) {
          if (ev && (!ev.isOpen || ev.currentId !== id)) ev.open(id);
        } else if (ev?.isOpen) {
          ev.close();
        }
        if (focus) focusOn(focus);
        else if (!profile && bundle.focusedId) bundle.zoomToHome();
      },
    }) || null;
    window.addEventListener('adai:entity-view', (e) => {
      const d = e.detail || {};
      if (!d.open && d.reason === 'dismiss') bundle.address?.profileDismissed();
      else bundle.address?.changed();
    });

    // If the URL has ?reading=..., auto-replay it on load. A reading is the
    // page's one initial navigation: a shared reading also carries the node
    // path it was shared from (buildShareUrl keeps the pathname), and neither
    // that deep link nor "open on yourself" may jump in on top of the replay.
    const urlPath = (readingFromUrl() || []).filter((id) => graph.byId.has(id));
    const replayingOnLoad = urlPath.length > 0;
    if (replayingOnLoad) {
      // The page lands on the reading: its replay is this entry, not a new step.
      bundle.address?.landing(urlPath.length * (CFG.ZOOM_TRANSITION_MS + CFG.REPLAY_DWELL_MS) + 2000);
      // Clear the param so reload doesn't replay again, but keep the URL clean.
      const u = new URL(window.location.href);
      u.searchParams.delete('reading');
      window.history.replaceState(window.history.state, '', u.href);
      // Replay after a short beat so the brand viz finishes its first paint —
      // unless the visitor navigated in the meantime.
      initialNavigation(bundle, () => replayPath(graph, bundle, urlPath, { snapshot: false }), 400, { keep: true });
    }
    // A reload: the entry this page wrote comes back as it was (its focus,
    // its profile, its place in a profile chain). A new arrival is stamped.
    const restoredEntry = bundle.address?.rehydrate() ?? null;
    const restored = replayingOnLoad ? null : restoredEntry;
    if (restored) {
      initialNavigation(bundle, () => {
        const ev = window.ADAI_ENTITY_VIEW;
        if (restored.focus) {
          if (!window.ADAI_FIELD_STUDY?.zoomToNode?.(restored.focus)) bundle.revealInPlace(restored.focus);
        }
        if (restored.profile && restored.id && ev) ev.open(restored.id);
      }, 600);
    }

    // The node the URL names, resolved to its id: /field/<type>/<slug> (the
    // clean, shareable form, issue #71), or the legacy ?node=<id-or-slug>
    // (the server 301s that to the clean form when it resolves). Kept in the
    // URL: it IS the share artifact, and re-focusing on reload is what you'd
    // expect from such a link.
    function deepLinkTarget() {
      const pm = window.location.pathname.match(/^\/field\/([a-z_]+)\/([^/]+)\/?$/);
      let wanted = null;
      if (pm) {
        try { wanted = `${pm[1]}:${decodeURIComponent(pm[2])}`; } catch { wanted = `${pm[1]}:${pm[2]}`; }
      } else {
        const q = new URL(window.location.href).searchParams.get('node');
        wanted = q && q.trim() ? q.trim() : null;
      }
      if (!wanted) return { wanted: null, id: null };
      if (graph.byId.has(wanted) && !pm) return { wanted, id: wanted };
      // Slug match, with or without a `type:` prefix, so both
      // /field?node=protocol-art and /field/concept/protocol-art resolve even
      // when the stored id uses the legacy spaced form.
      const m = wanted.match(/^([a-z_]+):(.+)$/);
      for (const n of graph.nodes) {
        if (m ? (n.type === m[1] && n.slug === m[2]) : n.slug === wanted) return { wanted, id: n.id };
      }
      return { wanted, id: graph.byId.has(wanted) ? wanted : null };
    }

    const deepLink = replayingOnLoad || restored ? { wanted: null, id: null } : deepLinkTarget();
    if (deepLink.wanted) {
      const targetId = deepLink.id;
      if (targetId) {
        // The address already names it (or names it the legacy way): hold it
        // there until the focus lands, then settle it in place, no new step.
        bundle.address?.expect(bundle.address.urlFor(targetId));
        bundle.address?.landing();
        // Same beat as ?reading — let the brand viz finish its first paint,
        // then drive the field-study zoom (pans the bitmap camera AND reveals
        // the node's neighbourhood). Falls back to the in-place reveal when
        // the field study isn't up (e.g. stage missing).
        const id = targetId;
        initialNavigation(bundle, () => {
          if (window.ADAI_FIELD_STUDY?.zoomToNode?.(id)) return;
          bundle.revealInPlace(id);
        }, 600);
      } else {
        console.warn('[adai] deep-link did not resolve:', deepLink.wanted);
      }
    }

    // Any navigation after this point (a click, Back) outranks "open on yourself".
    const startGen = bundle.replayGen || 0;

    // ---- personal lens (docs/CLAIM-SPEC.md §5) ----
    // Signed in with a claimed page: the field opens on your node (unless the
    // URL already names one), and "my field" (chip, or the m key) veils
    // everything beyond your neighbourhood — 2 hops, 1 when that is too many.
    // A personal VIEW of public data: nothing is hidden from anyone.
    bundle.lens = { on: false, self: null, mine: [], sims: [], edges: [] };
    const LENS_MAX = 500;
    function lensNeighbourhood(seeds) {
      const live = (e) => !isDerivedEdge(e);
      const ring = (ids) => {
        const out = new Set(ids);
        for (const id of ids) for (const e of graph.edgesFor(id)) {
          if (!live(e)) continue;
          out.add(e.source === id ? e.target : e.source);
        }
        return out;
      };
      const one = ring(seeds);
      const two = ring([...one]);
      const set = two.size > LENS_MAX ? one : two;
      const edges = [];
      const seen = new Set();
      for (const id of set) for (const e of graph.edgesFor(id)) {
        if (!live(e) || seen.has(e) || !set.has(e.source) || !set.has(e.target)) continue;
        seen.add(e);
        edges.push(e);
      }
      return { set, edges };
    }
    function lensChip() {
      let el = document.getElementById('adai-lens-chip');
      if (el) return el;
      el = document.createElement('button');
      el.id = 'adai-lens-chip';
      el.type = 'button';
      Object.assign(el.style, {
        position: 'fixed', left: '24px', bottom: '24px', zIndex: '40',
        fontFamily: "'SF Mono', 'Menlo', monospace", fontSize: '10px', letterSpacing: '0.08em',
        color: '#aaa', background: 'rgba(10,10,12,0.75)', border: '1px solid #333',
        borderRadius: '10px', padding: '4px 10px', cursor: 'pointer',
      });
      el.addEventListener('click', () => setLens(!bundle.lens.on));
      document.body.appendChild(el);
      return el;
    }
    function setLens(on) {
      const L = bundle.lens;
      if (!L.self) return;
      L.on = !!on;
      if (L.on && !L.sims.length) {
        const { set, edges } = lensNeighbourhood(L.mine);
        L.sims = [...set].map(id => bundle.simById.get(id)).filter(Boolean);
        L.edges = edges;
      }
      try { localStorage.setItem('adai-lens', L.on ? '1' : '0'); } catch { /* storage blocked */ }
      const chip = lensChip();
      chip.textContent = L.on ? '● my field — m' : '○ my field — m';
      chip.style.color = L.on ? '#e8e6e1' : '#aaa';
      chip.style.borderColor = L.on ? '#7eb8da' : '#333';
    }
    bundle.setLens = setLens;
    fetch('/api/contested', { cache: 'no-cache' })
      .then(r => (r.ok ? r.json() : null))
      .then(j => {
        if (j && Array.isArray(j.relations)) {
          contestedTriples = new Set(j.relations.map(r => `${r.source_id}\u0000${r.edge_type}\u0000${r.target_id}`));
        }
      })
      .catch(() => {});
    fetch('/api/intake/me', { credentials: 'same-origin', cache: 'no-cache' })
      .then(r => (r.ok ? r.json() : null))
      .then(me => {
        const mine = ((me && me.claims) || [])
          .filter(c => c.claim_status === 'approved' && graph.byId.has(c.id))
          .map(c => c.id);
        if (!mine.length) return;
        const params = new URL(window.location.href).searchParams;
        const named = deepLinkTarget().id;
        const L = bundle.lens;
        L.mine = mine;
        L.self = named && mine.includes(named) ? named : mine[0];
        let stored = null;
        try { stored = localStorage.getItem('adai-lens'); } catch { /* storage blocked */ }
        setLens(params.get('lens') === '1' || stored === '1');
        // Open on yourself, unless the link names another node or replays a reading.
        if (!named && !replayingOnLoad && !restored && (bundle.replayGen || 0) === startGen) {
          bundle.address?.landing();
          initialNavigation(bundle, () => {
            if (window.ADAI_FIELD_STUDY?.zoomToNode?.(L.self)) return;
            bundle.revealInPlace(L.self);
          }, 700);
        }
      })
      .catch(() => {});
    document.addEventListener('keydown', (e) => {
      if ((e.key !== 'm' && e.key !== 'M') || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (!bundle.lens.self) return;
      e.preventDefault();
      setLens(!bundle.lens.on);
    });

    // ---- interaction state ----
    const panel = createEntityPanel();
    let hoveredId = null;
    let selectedId = null;
    // Live cursor position (canvas space) for the label "reading lens" —
    // labels reveal only near the cursor so the full constellation can stay
    // dense without flooding the GPU with thousands of text draws. null when
    // the pointer is off-canvas.
    let cursorX = null, cursorY = null;
    // Touch has no hover, so the colour-reveal (the field's primary discovery
    // affordance) is driven by the active finger instead: a finger-drag reveals
    // colour under it, then fades on lift. cursorStrength multiplies the reveal
    // so the fade is smooth. Mouse hover keeps strength pinned at 1.
    let cursorStrength = 1;
    let cursorFadeStart = 0;          // perf.now() when a lifted-finger reveal began fading
    const TOUCH_REVEAL_FADE_MS = 850;
    let touchReveal = null;           // {x,y,id,moved} for the active single-finger reveal
    const activeTouchIds = new Set(); // live touch pointers on the canvas (≥2 ⇒ pinch)
    let suppressTapZoomUntil = 0;     // expires even if Safari never emits the synthetic click
    let multiTouchSession = false;    // suppress residual clicks until all pinch fingers lift
    const TOUCH_REVEAL_THRESHOLD = 8; // px before a touch is a drag-reveal, not a tap
    const TOUCH_CLICK_SUPPRESS_MS = 500;

    function suppressTapZoomBriefly() {
      suppressTapZoomUntil = Math.max(
        suppressTapZoomUntil,
        performance.now() + TOUCH_CLICK_SUPPRESS_MS
      );
    }

    function onResize() {
      applyViewportTuning();   // re-tune the narrow-viewport bandaid knobs
      const next = sizeCanvas(canvas);
      ctx = next.ctx; w = next.w; h = next.h;
      reproject(bundle);
    }
    window.addEventListener('resize', onResize, { passive: true });

    function handlePointerMove(e) {
      // During a two-finger pinch (field.js owns the camera) don't let either
      // finger drag the single-point reveal around — it would flicker between
      // them. The pinch itself magnifies the field; reveal resumes on lift.
      if (e.pointerType === 'touch' && activeTouchIds.size >= 2) return;
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      cursorX = x; cursorY = y;
      if (e.pointerType === 'touch') {
        if (touchReveal && e.pointerId === touchReveal.id) {
          cursorStrength = 1; cursorFadeStart = 0;   // following the finger — full strength
          if (!touchReveal.moved &&
              Math.hypot(x - touchReveal.x, y - touchReveal.y) > TOUCH_REVEAL_THRESHOLD) {
            touchReveal.moved = true;
          }
        }
      } else {
        // A real mouse cancels any lingering touch-reveal fade — hover is full.
        cursorStrength = 1; cursorFadeStart = 0;
      }
      let hit = null;
      if (!bundle.viewLevel || bundle.viewLevel === '30k') {
        hit = nearestSim(bundle, x, y, CFG.CLICK_TOLERANCE);
      } else if (bundle.viewLevel === 'field-focus') {
        hit = hitInPlaceNode(bundle, x, y, w, h);
        // Trust hover: surface the hovered edge's attribution after a dwell.
        // hitInPlaceNode returns a {id, role, item} wrapper — the neighbour
        // item (with .edge) is under .item; the focus hit has none.
        if (hit && hit.item) scheduleEdgeAttrib(hit.item, x, y);
        else hideEdgeAttrib();
      } else {
        // Only dot proximity counts — labels are not clickable.
        const ns = bundle.zoomNeighbors || [];
        let bestD2 = CFG.CLICK_TOLERANCE * CFG.CLICK_TOLERANCE;
        for (const n of ns) {
          const dx = (n.tx ?? n.x) - x;
          const dy = (n.ty ?? n.y) - y;
          const d2 = dx * dx + dy * dy;
          if (d2 < bestD2) { bestD2 = d2; hit = n; }
        }
      }
      const newId = hit ? hit.id : null;
      if (newId !== hoveredId) {
        hoveredId = newId;
        // Empty field while zoomed is draggable (field.js pan) — show it.
        const zoomedIn = window.ADAI_FIELD_STUDY?.isZoomed;
        canvas.style.cursor = hit ? 'pointer' : (zoomedIn ? 'grab' : 'default');
      }
    }

    // Pointer events cover mouse, touch and pen — binding mousemove too would
    // fire the handler twice per move on mouse devices.
    canvas.addEventListener('pointermove', handlePointerMove, { passive: true });

    // ---- Touch reveal (the hover analogue) ----
    // Mouse hover is handled by pointermove above. Touch fires pointermove only
    // while a finger is down, so we seed the reveal on pointerdown and decide on
    // pointerup whether the gesture was a tap (→ let the click zoom) or a
    // drag-reveal (→ suppress the zoom and fade the colour out).
    function handlePointerDown(e) {
      if (e.pointerType !== 'touch') return;
      activeTouchIds.add(e.pointerId);
      if (activeTouchIds.size >= 2) {
        // Second finger ⇒ pinch (field.js drives it). Drop any reveal + hover,
        // and suppress the tap-zoom around the multi-touch session so a residual
        // click from lift-off does not zoom.
        multiTouchSession = true;
        touchReveal = null;
        suppressTapZoomBriefly();
        cursorX = null; cursorY = null; cursorFadeStart = 0; cursorStrength = 1;
        if (hoveredId) { hoveredId = null; canvas.style.cursor = 'default'; }
        return;
      }
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      touchReveal = { x, y, id: e.pointerId, moved: false };
      cursorX = x; cursorY = y;          // bloom colour under the finger at once
      cursorStrength = 1; cursorFadeStart = 0;
      suppressTapZoomUntil = 0;
      multiTouchSession = false;
    }

    function handlePointerUp(e) {
      if (e.pointerType !== 'touch') return;
      const wasMultiTouch = multiTouchSession || activeTouchIds.size >= 2;
      activeTouchIds.delete(e.pointerId);
      if (wasMultiTouch) suppressTapZoomBriefly();
      if (activeTouchIds.size === 0) multiTouchSession = false;
      if (touchReveal && e.pointerId === touchReveal.id) {
        if (touchReveal.moved) {
          // It was a reveal-drag, not a tap — don't zoom, ease the colour out.
          suppressTapZoomBriefly();
          cursorFadeStart = performance.now();
        } else {
          // A clean tap — clear reveal and let the click handler zoom.
          cursorX = null; cursorY = null; cursorFadeStart = 0; cursorStrength = 1;
        }
        touchReveal = null;
      }
    }

    canvas.addEventListener('pointerdown', handlePointerDown);
    canvas.addEventListener('pointerup', handlePointerUp);
    canvas.addEventListener('pointercancel', handlePointerUp);

    function handlePointerLeave() {
      cursorX = null; cursorY = null;
      if (hoveredId) {
        hoveredId = null;
        canvas.style.cursor = 'default';
      }
    }

    canvas.addEventListener('pointerleave', handlePointerLeave);

    canvas.addEventListener('click', (e) => {
      e.stopPropagation();
      // A finger-drag that revealed colour ends in a synthetic click — swallow
      // it so the field doesn't zoom on what was a "read", not a "tap". (Set by
      // handlePointerUp; mouse clicks never set it.)
      if (performance.now() < suppressTapZoomUntil) {
        suppressTapZoomUntil = 0;
        return;
      }
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      // At 30k: click a practitioner -> step into it. Click empty -> nothing.
      if (!bundle.viewLevel || bundle.viewLevel === '30k') {
        const hit = nearestSim(bundle, x, y, CFG.CLICK_TOLERANCE);
        if (hit) zoomToNode(graph, bundle, hit.id, w, h);
        return;
      }

      if (bundle.viewLevel === 'field-focus') {
        const hit = hitInPlaceNode(bundle, x, y, w, h);
        if (hit?.role === 'focus') {
          if (window.ADAI_ENTITY_VIEW) window.ADAI_ENTITY_VIEW.open(bundle.focusedId);
          return;
        }
        if (hit?.role === 'neighbor') {
          if (window.ADAI_FIELD_STUDY?.zoomToNode?.(hit.id) !== false) return;
          revealNodeInPlace(graph, bundle, hit.id);
          return;
        }
        for (const n of bundle.inPlaceNeighbors || []) {
          const b = n.labelBBox;
          if (b && x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1) return;
        }
        window.ADAI_FIELD_STUDY?.reset?.({ syncGraph: false });
        clearInPlaceFocus(bundle, graph);
        return;
      }

      // Zoomed in: clicking the focused node itself opens its full profile
      // (the entity view). Most intuitive: "click on who you're looking at
      // = see them." Falls through to neighbor / empty-space handling if the
      // click misses the centered dot.
      const focusedId = bundle.focusedId;
      if (focusedId) {
        const simFocus = bundle.sim.find(s => s.id === focusedId);
        const focus = simFocus || bundle.zoomFocus;
        if (focus) {
          const dxF = focus.x - x;
          const dyF = focus.y - y;
          const focusR = focus.r || CFG.ZOOM_FOCUS_RADIUS;
          // Generous halo-sized hit area — feels natural at 10k where the
          // focused dot is rendered with a halo at ~3.5× its radius.
          const hitRadius = Math.max(focusR * 3.5, CFG.CLICK_TOLERANCE);
          if (dxF * dxF + dyF * dyF <= hitRadius * hitRadius) {
            if (window.ADAI_ENTITY_VIEW) window.ADAI_ENTITY_VIEW.open(focusedId);
            return;
          }
        }
      }

      // Otherwise: dot click -> navigate. Label click -> no-op
      // (so a misclick on a name doesn't accidentally jump home).
      // Empty space click -> jump back to 30k home. ESC still walks
      // back one step, breadcrumb segments handle granular jumps.
      const neighbors = bundle.zoomNeighbors || [];
      let hitN = null;
      let bestD2 = CFG.CLICK_TOLERANCE * CFG.CLICK_TOLERANCE;
      for (const n of neighbors) {
        const dx = (n.tx ?? n.x) - x;
        const dy = (n.ty ?? n.y) - y;
        const d2 = dx * dx + dy * dy;
        if (d2 < bestD2) { bestD2 = d2; hitN = n; }
      }
      if (hitN) {
        zoomToNode(graph, bundle, hitN.id, w, h);
        return;
      }
      // No dot hit. If we're on a label, do nothing (avoid accidental home).
      for (const n of neighbors) {
        const b = n.labelBBox;
        if (b && x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1) return;
      }
      // True empty space: home to 30k.
      window.ADAI_FIELD_STUDY?.reset?.({ syncGraph: false });
      bundle.history = [{ level: '30k', focusedId: null }];
      zoomBack(graph, bundle, w, h);
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && bundle.viewLevel && bundle.viewLevel !== '30k') {
        zoomBack(graph, bundle, w, h);
      }
      // 'h' toggles the chrome-hide (declutter) — the keyboard twin of the
      // on-screen handle. Ignore while typing (archivist / search) or with a
      // modifier so it never eats a browser shortcut.
      if ((e.key === 'h' || e.key === 'H') && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const t = e.target;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
        e.preventDefault();
        setChromeHidden(!chromeHidden);
      }
    });

    // expose ids for the render loop to highlight
    bundle.getHoveredId = () => hoveredId;
    bundle.getSelectedId = () => selectedId;

    function frame() {
      ctx.clearRect(0, 0, w, h);
      const hovId = bundle.getHoveredId();
      const selId = bundle.getSelectedId();
      const zoomed = (bundle.viewLevel && bundle.viewLevel !== '30k');
      const inPlaceFocus = bundle.viewLevel === 'field-focus';
      const inPlaceReveal = bundle.viewLevel === 'field-reveal';
      const focusedId = bundle.focusedId;
      // Touch reveal fade: after a finger lifts, ease the colour out over
      // TOUCH_REVEAL_FADE_MS rather than snapping it off, then release the
      // cursor. Mouse hover never fades (cursorFadeStart stays 0).
      if (cursorFadeStart) {
        cursorStrength = clamp(1 - (performance.now() - cursorFadeStart) / TOUCH_REVEAL_FADE_MS, 0, 1);
        if (cursorStrength <= 0) {
          cursorX = null; cursorY = null; cursorFadeStart = 0; cursorStrength = 1;
        }
      }
      // While the field is free-magnified (pinch) at 30k, the camera CSS-scales
      // the Shape-of-Time bitmap but sim.x/y (tap hit-test + hover label) are
      // only reprojected on init/resize. Re-sync them so taps land on the dot
      // actually under the finger. Cheap (one layout read + O(n)) and only while
      // actively magnified at rest.
      if (!zoomed && !inPlaceFocus && !inPlaceReveal &&
          (window.ADAI_FIELD_STUDY?.zoomScale || 1) > 1.01) {
        reproject(bundle);
      }
      // ---- 30k hover-reveal colour layer ----
      // The white Shape of Time is the resting base (drawn by sketch-brand.js).
      // Here we only bloom palette colour through the field dots under the
      // cursor, projected through ADAI_FIELD_STUDY so the reveal tracks the
      // camera. No persistent colour constellation is painted.
      {
        const study = window.ADAI_FIELD_STUDY;
        const zoomScale = study && typeof study.zoomScale === 'number' ? study.zoomScale : 1;
        // Camera transform fetched ONCE per frame (one layout read) so the
        // hover-reveal dots can be projected inline without a per-dot layout read.
        const T = study && study.getTransform ? study.getTransform() : null;
        // The coloured base constellation is no longer drawn — the white Shape of
        // Time stays primary and colour only blooms through the field dots under
        // the cursor (hover-reveal below). The graph nodes' field positions still
        // drive focus/threads; they just aren't painted as a resting colour layer.
        const colorHalos = [];
        const colorCores = [];

        if (!zoomed && !inPlaceReveal && !inPlaceFocus && cursorX != null && cursorY != null) {
          const rect = T ? null : (bundle.canvasRect || { left: 0, top: 0, width: w, height: h });
          const sx = rect ? rect.width / bundle.brandW : 1;
          const sy = rect ? rect.height / bundle.brandH : 1;
          const screenScale = rect ? Math.min(sx, sy) : 1;
          const dots = fieldRegistryDots();

          // Back-project the cursor + the reveal's outer reach into brand
          // space so the spatial grid can hand us only candidate dots. Past
          // RADIUS+SOFTNESS the falloff is exactly 0; the small margin covers
          // the reveal<=0.01 cutoff comfortably.
          const reachPx = CFG.HOVER_COLOR_REVEAL_RADIUS + CFG.HOVER_COLOR_REVEAL_SOFTNESS + 8;
          let cbx, cby, reachBrand;
          if (T) {
            const eff = (T.scale || 1) * (T.screenScale || 1);
            cbx = ((cursorX - T.left) / (T.screenScale || 1) - T.x) / (T.scale || 1);
            cby = ((cursorY - T.top) / (T.screenScale || 1) - T.y) / (T.scale || 1);
            reachBrand = reachPx / Math.max(1e-6, eff);
          } else {
            cbx = (cursorX - rect.left) / Math.max(1e-6, sx);
            cby = (cursorY - rect.top) / Math.max(1e-6, sy);
            // sx/sy can differ (non-uniform letterbox fit) — cover with the
            // larger brand-space radius so no candidate is missed.
            reachBrand = reachPx / Math.max(1e-6, Math.min(sx, sy));
          }
          const cells = revealGridFor(dots);
          const c0x = ((cbx - reachBrand) / REVEAL_GRID_CELL) | 0;
          const c1x = ((cbx + reachBrand) / REVEAL_GRID_CELL) | 0;
          const c0y = ((cby - reachBrand) / REVEAL_GRID_CELL) | 0;
          const c1y = ((cby + reachBrand) / REVEAL_GRID_CELL) | 0;

          for (let cyc = c0y; cyc <= c1y; cyc++) {
            for (let cxc = c0x; cxc <= c1x; cxc++) {
              const bucket = cells.get(`${cxc},${cyc}`);
              if (!bucket) continue;
              for (let bi = 0; bi < bucket.length; bi++) {
                const i = bucket[bi];
                const dot = dots[i];
                let px, py, pr;
                if (T) {
                  px = T.left + (dot.x * T.scale + T.x) * T.screenScale;
                  py = T.top + (dot.y * T.scale + T.y) * T.screenScale;
                  pr = Math.max(0.55, dot.radius * T.scale * T.screenScale);
                } else {
                  px = rect.left + dot.x * sx;
                  py = rect.top + dot.y * sy;
                  pr = Math.max(0.55, dot.radius * screenScale);
                }
                const reveal = colorRevealAt(px, py, cursorX, cursorY) * cursorStrength;
                if (reveal <= 0.01) continue;
                const color = colorForFieldFlow(i);
                colorHalos.push({
                  x: px, y: py,
                  r: Math.max(pr * 1.75, 1.6),
                  color,
                  alpha: CFG.HOVER_COLOR_HALO_ALPHA * reveal
                });
                colorCores.push({
                  x: px, y: py,
                  r: pr,
                  color,
                  alpha: CFG.HOVER_COLOR_CORE_ALPHA * reveal
                });
              }
            }
          }
        }
        drawDotsBatched(ctx, colorHalos);
        drawDotsBatched(ctx, colorCores);
        ctx.fillStyle = CFG.DOT_HEX;

        // Hover halo + name label (only meaningful at 30k). The label lets a
        // reader identify a dot before committing the click that zooms in.
        if (hovId && !zoomed) {
          const s = bundle.sim.find(x => x.id === hovId);
          if (s) {
            ctx.fillStyle = colorForNode(s);
            ctx.globalAlpha = CFG.HOVER_HALO_ALPHA;
            ctx.beginPath();
            ctx.arc(s.x, s.y, s.r * CFG.HALO_RADIUS_MULT * 1.1, 0, Math.PI * 2);
            ctx.fill();
            const hn = graph.byId.get(s.id);
            const hname = hn?.name || (s.id || '').split(':')[1] || s.id;
            if (hname) {
              ctx.font = `${CFG.NAME_TEXT_SIZE}px 'SF Mono', monospace`;
              ctx.textBaseline = 'middle';
              ctx.textAlign = 'left';
              const half = CFG.NAME_TEXT_SIZE * 0.7;
              const lx = s.x + s.r * CFG.HALO_RADIUS_MULT * 1.1 + 6;
              const ly = s.y;
              const wText = ctx.measureText(hname).width;
              ctx.globalAlpha = CFG.LABEL_BACKING_ALPHA != null ? CFG.LABEL_BACKING_ALPHA : 0.7;
              ctx.fillStyle = '#0a0a0c';
              ctx.fillRect(lx - 3, ly - half - 1, wText + 6, half * 2 + 2);
              ctx.globalAlpha = 1;
              ctx.fillStyle = '#FFFFFF';
              ctx.fillText(hname, lx, ly);
            }
          }
        }
        // Selected halo (also only at 30k — at 10k the focused IS the centre).
        if (selId && !zoomed) {
          const s = bundle.sim.find(x => x.id === selId);
          if (s) {
            const col = colorForNode(s);
            ctx.fillStyle = col;
            ctx.globalAlpha = CFG.SELECTED_HALO_ALPHA;
            ctx.beginPath();
            ctx.arc(s.x, s.y, s.r * CFG.HALO_RADIUS_MULT * 1.25, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = '#FFFFFF';
            ctx.globalAlpha = 1;
            ctx.beginPath();
            ctx.arc(s.x, s.y, s.r * 1.15, 0, Math.PI * 2);
            ctx.fill();
          }
        }
        // Personal lens: veil the field, then redraw your neighbourhood on
        // top — threads first, then dots, your own node ringed and named.
        if (bundle.lens && bundle.lens.on && bundle.lens.sims.length && !zoomed) {
          ctx.globalAlpha = 0.78;
          ctx.fillStyle = '#0a0a0c';
          ctx.fillRect(0, 0, w, h);
          const L = bundle.lens;
          ctx.lineWidth = 0.8;
          for (const e of L.edges) {
            const a = bundle.simById.get(e.source), b = bundle.simById.get(e.target);
            if (!a || !b) continue;
            const contested = isContested(e);
            ctx.globalAlpha = contested ? 0.9 : 0.35;
            ctx.strokeStyle = contested ? CONTESTED_COLOR : (colorForEdge(e.type) || '#888');
            ctx.setLineDash(contested ? [3, 4] : []);
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
          }
          ctx.setLineDash([]);
          for (const s of L.sims) {
            ctx.globalAlpha = 0.95;
            ctx.fillStyle = colorForNode(s);
            ctx.beginPath();
            ctx.arc(s.x, s.y, Math.max(1.6, s.r * 1.4), 0, Math.PI * 2);
            ctx.fill();
          }
          for (const id of L.mine) {
            const s = bundle.simById.get(id);
            if (!s) continue;
            ctx.globalAlpha = 0.9;
            ctx.strokeStyle = '#E8E6E1';
            ctx.lineWidth = 1.4;
            ctx.beginPath();
            ctx.arc(s.x, s.y, Math.max(6, s.r * 3.2), 0, Math.PI * 2);
            ctx.stroke();
            const nm = graph.byId.get(id)?.name;
            if (nm) {
              ctx.font = `${CFG.NAME_TEXT_SIZE}px 'SF Mono', monospace`;
              ctx.textBaseline = 'middle';
              ctx.textAlign = 'left';
              ctx.fillStyle = '#FFFFFF';
              ctx.fillText(nm, s.x + Math.max(6, s.r * 3.2) + 6, s.y);
            }
          }
          ctx.lineWidth = 1;
          ctx.globalAlpha = 1;
        }
        // Archivist-driven highlights — a soft pulsing ring on each highlighted
        // sim dot. Auto-cleared after the TTL set when the set was installed.
        if (bundle.highlightedIds && bundle.highlightedIds.size > 0 && !zoomed) {
          const pulse = 0.55 + 0.35 * Math.sin(Date.now() / 380);
          for (const s of bundle.sim) {
            if (!bundle.highlightedIds.has(s.id)) continue;
            ctx.strokeStyle = '#E8E6E1';
            ctx.globalAlpha = pulse;
            ctx.lineWidth = 1.4;
            ctx.beginPath();
            ctx.arc(s.x, s.y, s.r * 3.5, 0, Math.PI * 2);
            ctx.stroke();
          }
          ctx.lineWidth = 1;
        }
        ctx.fillStyle = CFG.DOT_HEX;
      }

      // ---- in-place reveal / focus layer ----
      const filters = bundle.activeFilters;
      const filtersActive = filters && filters.size > 0;
      const filterMatch = (n) => !filtersActive || filters.has(n.edgeType);
      const dimmedAlpha = 0.12;  // for filtered-out neighbours
      const focusBlend = inPlaceFocus && bundle.fieldFocusBlend?.focusedId === focusedId
        ? bundle.fieldFocusBlend
        : null;
      let focusAlpha = 1;
      let revealAlpha = 0;
      if (focusBlend) {
        const blendT = clamp((performance.now() - focusBlend.focusStartedAt) / CFG.FIELD_REVEAL_TO_FOCUS_MS, 0, 1);
        focusAlpha = easeInOutCubic(blendT);
        revealAlpha = 1 - focusAlpha;
        if (blendT >= 1) bundle.fieldFocusBlend = null;
      }
      if (inPlaceReveal) {
        drawInPlaceReveal(ctx, bundle, graph, w, h, filterMatch);
      }
      if (focusBlend && revealAlpha > 0.01) {
        drawInPlaceReveal(ctx, bundle, graph, w, h, filterMatch, revealAlpha, focusBlend);
      }
      if (inPlaceFocus) {
        drawInPlaceFocus(ctx, bundle, graph, w, h, filterMatch, dimmedAlpha, focusAlpha);
      }

      ctx.globalAlpha = 1;
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  function init() {
    if (window.ADAI_GRAPH && window.ADAI_GRAPH.nodes && window.ADAI_GRAPH.nodes.length) {
      start(window.ADAI_GRAPH);
      return;
    }
    window.addEventListener('adai:graph', (ev) => {
      const g = ev.detail;
      if (g && g.nodes && g.nodes.length) start(g);
    }, { once: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
