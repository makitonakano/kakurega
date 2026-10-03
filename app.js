(() => {
  if (navigator.audioSession) navigator.audioSession.type = "playback";
  const photos = window.PHOTOS || [];
  const byId = new Map(photos.map((p) => [p.id, p]));
  const listed = photos.filter((p) => !p.demo);
  const extras = photos.filter((p) => p.demo);
  const placed = listed.filter((p) => typeof p.lat === "number");
  const onMap = (p) => Boolean(p) && !p.demo && typeof p.lat === "number";
  const poolOf = (p) => (p && p.demo ? extras : listed);
  const TABS = ["gallery", "map"];
  const MAPLIBRE = "https://unpkg.com/maplibre-gl@5.24.0/dist/maplibre-gl";
  const SMALL = 480;
  const THUMB = 840;
  const LARGE = 1920;
  const density = Math.min(1, 2 / (window.devicePixelRatio || 1));
  const sizesFor = (cssWidth) => `${Math.ceil(cssWidth * density)}px`;
  const src = (size, p) => `img/${size}/${p.id}.webp${p.v ? `?v=${p.v}` : ""}`;
  const widthAt = (p, height) => Math.round((p.w * Math.min(p.h, height)) / p.h);
  const largeWidth = (p) => Math.round(p.w * Math.min(1, LARGE / Math.max(p.w, p.h)));
  const tileSet = (p) => `${src("s", p)} ${widthAt(p, SMALL)}w, ${src("t", p)} ${widthAt(p, THUMB)}w`;
  const wideSet = (p) => `${src("t", p)} ${widthAt(p, THUMB)}w, ${src("l", p)} ${largeWidth(p)}w`;
  const $ = (id) => document.getElementById(id);

  const grid = $("grid");
  const gallery = $("view-gallery");
  const mapSection = $("view-map");
  const caption = $("caption");
  const captionA = $("caption-a");
  const captionB = $("caption-b");
  const langButton = $("lang-button");
  const langCurrent = $("lang-current");
  const langMenu = $("lang-menu");
  const tabLinks = [...document.querySelectorAll("[data-tab]")];
  const viewer = $("viewer");
  const stage = $("viewer-stage");
  const viewerImg = $("viewer-img");
  const track = $("viewer-track");
  const peekPrev = $("peek-prev");
  const peekNext = $("peek-next");
  const largeReady = new Set();
  let skipMorph = false;
  let sliding = false;
  const viewerA = $("viewer-a");
  const viewerB = $("viewer-b");
  const viewerMap = $("viewer-map");
  const prevButton = $("viewer-prev");
  const nextButton = $("viewer-next");

  const state = { tab: null, id: null };
  const thumbs = new Map();
  const named = new Set();
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
  let markers = new Map();
  let map = null;
  let lastZoom = 0;
  let galleryScroll = 0;
  let openedHere = false;
  let pendingFocus = null;
  let shown = null;
  let morphRun = 0;

  const LANGS = window.I18N.langs;
  const TEXT = window.I18N.text;
  const LANG_KEY = "kakurega-lang";
  const langInfo = (code) => LANGS.find((l) => l.code === code);

  function savedLang() {
    try {
      return localStorage.getItem(LANG_KEY);
    } catch (e) {
      return null;
    }
  }

  function rememberLang(value) {
    try {
      localStorage.setItem(LANG_KEY, value);
    } catch (e) {
      return;
    }
  }

  function matchLang(tag) {
    const lower = tag.toLowerCase();
    if (lower.startsWith("zh")) return /hant|tw|hk|mo/.test(lower) ? "zh-Hant" : "zh-Hans";
    if (lower.startsWith("tl")) return "fil";
    const hit = LANGS.find((l) => lower === l.code.toLowerCase() || lower.startsWith(`${l.code.toLowerCase()}-`));
    return hit ? hit.code : null;
  }

  function initialLang() {
    const saved = savedLang();
    if (langInfo(saved)) return saved;
    const wanted = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || ""];
    for (const tag of wanted) {
      const code = matchLang(tag);
      if (code) return code;
    }
    return "en";
  }

  let lang = initialLang();
  const t = (key) => TEXT[lang][key];

  function pair(name) {
    const entry = (code) => ({ text: name[code] || "", lang: code });
    if (lang === "ja") return [entry("ja"), entry("en")];
    if (name[lang]) return [entry(lang), entry("ja")];
    if (langInfo(lang).kanji) return [entry("ja"), entry("en")];
    return name.en ? [entry("en"), entry("ja")] : [entry("ja"), entry("en")];
  }

  const label = (p) => pair(p.name).map((n) => n.text).filter(Boolean).join(" ") || t("photo");

  function fillNames(a, b, name) {
    const [first, second] = pair(name);
    a.textContent = first.text;
    a.lang = first.lang;
    b.textContent = second.text === first.text ? "" : second.text;
    b.lang = second.lang;
  }

  let prefectures = { type: "FeatureCollection", features: [] };
  let prefNames = new Map();
  const prefLevel = new Map();
  let hoverPref = null;
  let prefFrame = 0;
  let prefTime = 0;
  let captionPhoto = null;

  function inRing(x, y, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  function prefectureAt(lng, lat) {
    const hit = prefectures.features.find((f) => f.geometry.coordinates.some((polygon) => inRing(lng, lat, polygon[0]) && !polygon.slice(1).some((hole) => inRing(lng, lat, hole))));
    return hit ? hit.id : null;
  }

  let mapStack = null;

  function loadFile(tag, attrs) {
    return new Promise((resolve, reject) => {
      const el = Object.assign(document.createElement(tag), attrs);
      el.addEventListener("load", resolve);
      el.addEventListener("error", reject);
      document.head.append(el);
    });
  }

  function loadMapStack() {
    if (!mapStack) {
      mapStack = Promise.all([
        loadFile("link", { rel: "stylesheet", href: `${MAPLIBRE}.css` }),
        loadFile("script", { src: `${MAPLIBRE}.js` }),
        loadFile("script", { src: "map-style.js?v=b7f9f09d" }),
        loadFile("script", { src: "prefectures.js?v=8555db89" }),
      ]).then(() => {
        prefectures = window.PREFECTURES;
        prefNames = new Map(prefectures.features.map((f) => [f.id, f.properties]));
        placed.forEach((p) => {
          p.pref = prefectureAt(p.lng, p.lat);
        });
      }).catch((error) => {
        mapStack = null;
        throw error;
      });
    }
    return mapStack;
  }

  function styleFor() {
    const style = structuredClone(window.MAP_STYLE);
    const level = ["coalesce", ["feature-state", "level"], 0];
    style.sources.pref = { type: "geojson", data: prefectures, attribution: "国土数値情報（国土交通省）" };
    style.layers.splice(style.layers.findIndex((layer) => layer.id === "water"), 0, {
      id: "pref-fill",
      type: "fill",
      source: "pref",
      paint: {
        "fill-color": "#000",
        "fill-antialias": false,
        "fill-opacity": ["interpolate", ["linear"], ["zoom"], 9, ["*", 0.11, level], 12.5, ["*", 0.03, level]],
      },
    });
    const latin = ["get", "name:latin"];
    const local = ["get", "name:nonlatin"];
    const info = langInfo(lang);
    const own = info.mapName ? info.mapName.map((key) => ["get", key]) : [];
    let parts = [latin, local];
    if (lang === "ja") parts = [local, latin];
    else if (info.kanji) parts = [["coalesce", ...own, local], latin];
    else if (own.length) parts = [["coalesce", ...own, latin], local];
    const isGet = (e, key) => Array.isArray(e) && e[0] === "get" && e[1] === key;
    const swap = (e) => {
      if (!Array.isArray(e)) return e;
      if (e[0] === "concat" && e.length === 4 && isGet(e[1], "name:latin") && isGet(e[3], "name:nonlatin")) return ["concat", parts[0], e[2], parts[1]];
      return e.map(swap);
    };
    style.layers.forEach((layer) => {
      if (layer.layout && layer.layout["text-field"]) layer.layout["text-field"] = swap(layer.layout["text-field"]);
    });
    return style;
  }

  function inView(el) {
    const r = el.getBoundingClientRect();
    return r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
  }

  function setName(el, name) {
    if (!el) return;
    el.style.viewTransitionName = name;
    named.add(el);
  }

  function clearNames() {
    named.forEach((el) => {
      el.style.viewTransitionName = "";
    });
    named.clear();
  }

  let settled = Promise.resolve();

  function afterMorph(run) {
    settled.then(() => requestAnimationFrame(() => requestAnimationFrame(run)));
  }

  function morph(before, update, after) {
    if (!document.startViewTransition || reduceMotion.matches || document.visibilityState !== "visible") {
      update();
      return;
    }
    const run = ++morphRun;
    clearNames();
    before();
    let finish;
    settled = new Promise((resolve) => (finish = resolve));
    const transition = document.startViewTransition(() => {
      clearNames();
      update();
      after();
    });
    transition.finished.catch(() => {}).then(() => {
      if (run === morphRun) clearNames();
      finish();
    });
  }

  function refreshCaption() {
    const name = captionPhoto ? captionPhoto.name : state.tab === "map" && prefNames.get(hoverPref);
    if (name) fillNames(captionA, captionB, name);
    caption.classList.toggle("on", Boolean(name));
  }

  function showCaption(p) {
    captionPhoto = p;
    refreshCaption();
  }

  function stepPrefectures(now) {
    const delta = reduceMotion.matches ? 1 : Math.min(now - prefTime, 50) / 260;
    prefTime = now;
    const ids = new Set(prefLevel.keys());
    if (hoverPref !== null) ids.add(hoverPref);
    let moving = false;
    ids.forEach((id) => {
      const target = id === hoverPref ? 1 : 0;
      const current = prefLevel.get(id) || 0;
      const next = target > current ? Math.min(1, current + delta) : Math.max(0, current - delta);
      if (next === 0) prefLevel.delete(id);
      else prefLevel.set(id, next);
      if (map.getSource("pref")) map.setFeatureState({ source: "pref", id }, { level: next * (2 - next) });
      if (next !== target) moving = true;
    });
    prefFrame = moving ? requestAnimationFrame(stepPrefectures) : 0;
  }

  function liftPins() {
    markers.forEach((m) => {
      m.pin.classList.toggle("up", hoverPref !== null && m.items.some((p) => p.pref === hoverPref));
    });
  }

  function setHoverPref(id) {
    if (id === hoverPref) return;
    hoverPref = id;
    liftPins();
    refreshCaption();
    if (!prefFrame) {
      prefTime = performance.now();
      prefFrame = requestAnimationFrame(stepPrefectures);
    }
  }

  function hoverCaption(el, p) {
    el.addEventListener("mouseenter", () => showCaption(p));
    el.addEventListener("mouseleave", () => showCaption(null));
    el.addEventListener("focus", () => showCaption(p));
    el.addEventListener("blur", () => showCaption(null));
  }

  const heroPhoto = photos.find((p) => typeof p.hero === "number") || null;

  let origin = null;
  const extraImages = [];

  function openFrom(link, img, p) {
    img.dataset.pid = p.id;
    extraImages.push({ img, p });
    link.addEventListener("click", () => {
      openedHere = true;
      origin = img;
    });
  }

  function renderHero() {
    if (!heroPhoto) return;
    const link = $("hero-link");
    const img = $("hero-img");
    link.href = `#gallery/${heroPhoto.id}`;
    openFrom(link, img, heroPhoto);
    img.style.setProperty("--focus", `${heroPhoto.hero}%`);
    img.addEventListener("load", () => img.classList.add("ready"));
    const hero = $("hero");
    hero.style.backgroundColor = heroPhoto.c;
    hero.hidden = false;
    img.decoding = "async";
    img.loading = "lazy";
    img.fetchPriority = "low";
    if (innerWidth >= 600) {
      img.sizes = sizesFor(Math.max(innerWidth, (hero.clientHeight * heroPhoto.w) / heroPhoto.h));
      img.srcset = wideSet(heroPhoto);
    }
    img.src = src("t", heroPhoto);
    if (img.complete) img.classList.add("ready");
  }

  const SEASONS = ["spring", "summer", "autumn", "winter"];
  const season = { key: null, items: [], slides: [], at: 0, shown: -1, last: [], width: 0, peek: 56 };

  function pickSeason() {
    const month = new Date().getMonth() + 1;
    const now = SEASONS[Math.floor((((month + 9) % 12)) / 3)];
    const has = (key) => photos.some((p) => p.season === key);
    return has(now) ? now : SEASONS.find(has) || null;
  }

  function seasonOffset(k) {
    const n = season.items.length;
    let r = k - season.at;
    if (n > 2) r = ((((r + n / 2) % n) + n) % n) - n / 2;
    return r;
  }

  function seasonCenter(slide, r) {
    const W = season.width;
    const w = slide.w;
    const far = W * 0.35;
    const stops = [-w / 2 - far, season.peek - w / 2, W / 2, W - season.peek + w / 2, W + w / 2 + far];
    const x = Math.max(-2, Math.min(2, r)) + 2;
    const i = Math.min(3, Math.floor(x));
    return stops[i] + (stops[i + 1] - stops[i]) * (x - i);
  }

  function placeSlides() {
    season.slides.forEach((slide, k) => {
      const r = seasonOffset(k);
      const jump = season.last[k] !== undefined && Math.abs(r - season.last[k]) > 1.5;
      slide.el.classList.toggle("jump", jump);
      slide.el.style.transform = `translateX(${Math.round(seasonCenter(slide, r) - slide.w / 2)}px)`;
      slide.el.tabIndex = Math.abs(r) < 0.5 ? 0 : -1;
      if (!slide.loaded && slide.w && Math.abs(r) <= 1.5) {
        slide.loaded = true;
        slide.img.fetchPriority = Math.abs(r) < 0.5 ? "high" : "low";
        if (Math.abs(r) < 0.5 && !tilesStarted) {
          slide.img.addEventListener("load", startTiles, { once: true });
          slide.img.addEventListener("error", startTiles, { once: true });
        }
        slide.img.sizes = sizesFor(slide.w);
        slide.img.srcset = tileSet(season.items[k]);
        slide.img.src = src("s", season.items[k]);
      }
      season.last[k] = r;
    });
  }

  function seasonText() {
    const index = ((Math.round(season.at) % season.items.length) + season.items.length) % season.items.length;
    const p = season.items[index];
    fillNames($("season-a"), $("season-b"), p.name);
    $("season-now").textContent = index + 1;
    $("season").style.setProperty("--half", `${Math.round(season.slides[index].w / 2)}px`);
    season.shown = index;
  }

  function seasonGo(to) {
    season.at = to;
    placeSlides();
    const n = season.items.length;
    const index = ((Math.round(to) % n) + n) % n;
    if (index === season.shown) return;
    const root = $("season");
    root.classList.add("swap");
    setTimeout(() => {
      seasonText();
      root.classList.remove("swap");
    }, reduceMotion.matches ? 0 : 200);
  }

  function layoutSeason() {
    if (!season.items.length) return;
    const stage = $("season-stage");
    const root = $("season");
    root.classList.remove("stack");
    season.width = stage.clientWidth;
    let height = stage.clientHeight;
    const side = 200 + Math.min(96, Math.max(40, season.width * 0.06));
    const widest = Math.max(...season.items.map((p) => (height * p.w) / p.h));
    const stack = season.width < 700 || season.width / 2 - widest / 2 - side < season.peek + 24;
    root.classList.toggle("stack", stack);
    height = stage.clientHeight;
    season.peek = season.width < 700 ? 20 : 56;
    season.slides.forEach((slide, k) => {
      const p = season.items[k];
      slide.w = Math.min(Math.round((height * p.w) / p.h), season.width - season.peek * 2 - 32);
      slide.el.style.width = `${slide.w}px`;
      slide.el.classList.add("jump");
    });
    season.last = [];
    placeSlides();
    seasonText();
  }

  function renderSeason() {
    season.key = pickSeason();
    if (!season.key) return;
    season.items = photos.filter((p) => p.season === season.key);
    const stage = $("season-stage");
    const root = $("season");
    season.slides = season.items.map((p, k) => {
      const el = document.createElement("a");
      el.className = "slide";
      el.href = `#gallery/${p.id}`;
      el.draggable = false;
      el.style.backgroundColor = p.c;
      const img = document.createElement("img");
      img.alt = label(p);
      img.decoding = "async";
      img.draggable = false;
      el.append(img);
      openFrom(el, img, p);
      el.addEventListener("click", (e) => {
        if (season.dragged || Math.abs(seasonOffset(k)) > 0.5) {
          e.preventDefault();
          openedHere = false;
          if (!season.dragged) seasonGo(Math.round(season.at) + Math.round(seasonOffset(k)));
        }
      });
      stage.append(el);
      return { el, img, w: 0, loaded: false };
    });
    $("season-total").textContent = season.items.length;
    const single = season.items.length < 2;
    $("season-prev").hidden = single;
    $("season-next").hidden = single;
    root.hidden = false;

    $("season-prev").addEventListener("click", () => seasonGo(Math.round(season.at) - 1));
    $("season-next").addEventListener("click", () => seasonGo(Math.round(season.at) + 1));
    root.addEventListener("keydown", (e) => {
      if (e.key === "ArrowLeft") seasonGo(Math.round(season.at) - 1);
      if (e.key === "ArrowRight") seasonGo(Math.round(season.at) + 1);
    });

    let start = null;
    stage.addEventListener("pointerdown", (e) => {
      if (single || (e.pointerType === "mouse" && e.button !== 0)) return;
      start = { x: e.clientX, y: e.clientY, at: Math.round(season.at), active: false };
      season.dragged = false;
    });
    stage.addEventListener("pointermove", (e) => {
      if (!start) return;
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      if (!start.active) {
        if (Math.abs(dx) < 8 || Math.abs(dx) < Math.abs(dy)) return;
        start.active = true;
        season.dragged = true;
        stage.classList.add("dragging");
        stage.setPointerCapture(e.pointerId);
      }
      season.at = start.at - dx / (season.width * 0.5);
      placeSlides();
    });
    const release = (e) => {
      if (!start) return;
      const dx = e.clientX - start.x;
      const active = start.active;
      const base = start.at;
      start = null;
      stage.classList.remove("dragging");
      if (!active) return;
      const steps = Math.abs(dx) > 48 ? Math.max(1, Math.round(Math.abs(dx) / (season.width * 0.5))) : 0;
      seasonGo(base - Math.sign(dx) * steps);
      setTimeout(() => {
        season.dragged = false;
      }, 0);
    };
    stage.addEventListener("pointerup", release);
    stage.addEventListener("pointercancel", release);

    let wheel = 0;
    let wheelLock = 0;
    stage.addEventListener("wheel", (e) => {
      if (single || Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
      e.preventDefault();
      const now = performance.now();
      if (now < wheelLock) return;
      wheel += e.deltaX;
      if (Math.abs(wheel) > 50) {
        seasonGo(Math.round(season.at) + Math.sign(wheel));
        wheel = 0;
        wheelLock = now + 520;
      }
    }, { passive: false });
  }

  function renderGrid() {
    const row = innerWidth < 600 ? 120 : Math.min(400, Math.max(200, innerWidth * 0.24));
    const items = photos.filter((p) => !p.demo).map((p) => {
      const li = document.createElement("li");
      li.style.setProperty("--ar", (p.w / p.h).toFixed(4));
      const a = document.createElement("a");
      a.href = `#gallery/${p.id}`;
      a.addEventListener("click", () => {
        openedHere = true;
        origin = null;
      });
      hoverCaption(a, p);
      a.style.backgroundColor = p.c;
      const img = document.createElement("img");
      img.width = p.w;
      img.height = p.h;
      img.alt = label(p);
      img.loading = "lazy";
      img.decoding = "async";
      img.addEventListener("load", () => img.classList.add("ready"));
      img.sizes = sizesFor((p.w / p.h) * row * 1.2);
      thumbs.set(p.id, img);
      a.append(img);
      li.append(a);
      return li;
    });
    grid.replaceChildren(...items);
  }

  let tilesStarted = false;

  function startTiles() {
    if (tilesStarted) return;
    tilesStarted = true;
    thumbs.forEach((img, id) => {
      const p = byId.get(id);
      img.srcset = tileSet(p);
      img.src = src("s", p);
    });
  }

  const mercX = (lng) => (lng + 180) / 360;
  const mercY = (lat) => {
    const s = Math.sin((lat * Math.PI) / 180);
    return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
  };

  function boundsOf(items) {
    const bounds = new maplibregl.LngLatBounds();
    items.forEach((p) => bounds.extend([p.lng, p.lat]));
    return bounds;
  }

  function fitAll() {
    if (!placed.length) {
      map.jumpTo({ center: [138, 37.6], zoom: 4.4 });
      return;
    }
    const pad = Math.min(96, Math.round(Math.min(mapSection.clientWidth, mapSection.clientHeight) / 5));
    map.fitBounds(boundsOf(placed), { padding: pad, maxZoom: 7.6, animate: false });
  }

  function createMarker(items) {
    const first = items[0];
    const wrap = document.createElement("div");
    const pin = document.createElement("button");
    pin.type = "button";
    pin.className = "pin";
    pin.setAttribute("aria-label", items.length > 1 ? `${label(first)} ${t("more").replace("{n}", items.length - 1)}` : label(first));
    const img = document.createElement("img");
    img.src = src("p", first);
    img.alt = "";
    pin.append(img);
    if (items.length > 1) {
      const count = document.createElement("b");
      count.textContent = items.length;
      pin.append(count);
    } else {
      hoverCaption(pin, first);
    }
    pin.addEventListener("click", (e) => {
      e.stopPropagation();
      const bounds = boundsOf(items);
      const spread = Math.abs(bounds.getEast() - bounds.getWest()) + Math.abs(bounds.getNorth() - bounds.getSouth());
      if (items.length === 1 || spread < 0.00005 || map.getZoom() >= 15.5) {
        openedHere = true;
        location.hash = `map/${first.id}`;
        return;
      }
      map.fitBounds(bounds, { padding: 120, maxZoom: 16, duration: 700 });
    });
    wrap.append(pin);
    const lng = items.reduce((sum, p) => sum + p.lng, 0) / items.length;
    const lat = items.reduce((sum, p) => sum + p.lat, 0) / items.length;
    const marker = new maplibregl.Marker({ element: wrap, anchor: "center" }).setLngLat([lng, lat]).addTo(map);
    return { marker, pin, items };
  }

  function layoutMarkers() {
    lastZoom = map.getZoom();
    const scale = 512 * 2 ** lastZoom;
    const clusters = [];
    placed.forEach((p) => {
      const x = mercX(p.lng) * scale;
      const y = mercY(p.lat) * scale;
      const near = clusters.find((c) => Math.hypot(c.x - x, c.y - y) < 60);
      if (near) near.items.push(p);
      else clusters.push({ x, y, items: [p] });
    });
    const next = new Map();
    clusters.forEach((c) => {
      const key = c.items.map((p) => p.id).join("|");
      next.set(key, markers.get(key) || createMarker(c.items));
    });
    markers.forEach((m, key) => {
      if (!next.has(key)) m.marker.remove();
    });
    markers = next;
    liftPins();
  }

  function markerFor(id) {
    for (const m of markers.values()) {
      if (m.items.some((p) => p.id === id)) return m;
    }
    return null;
  }

  function ensureMap() {
    return loadMapStack().then(() => {
      if (map) return;
      map = new maplibregl.Map({
        container: "map-canvas",
        style: styleFor(),
        center: [138, 37.6],
        zoom: 4.4,
        minZoom: 3.2,
        maxZoom: 17,
        maxBounds: [[104, 14], [172, 56]],
        dragRotate: false,
        pitchWithRotate: false,
        touchPitch: false,
        attributionControl: false,
        localIdeographFontFamily: '"Hiragino Sans", "Yu Gothic", "Noto Sans CJK JP", sans-serif',
      });
      map.touchZoomRotate.disableRotation();
      map.keyboard.disableRotation();
      map.addControl(new maplibregl.AttributionControl({ compact: false }), "bottom-left");
      map.on("zoomend", layoutMarkers);
      map.on("zoom", () => {
        if (Math.abs(map.getZoom() - lastZoom) >= 0.6) layoutMarkers();
      });
      map.on("mousemove", (e) => {
        if (!map.getLayer("pref-fill")) return;
        const hit = map.queryRenderedFeatures(e.point, { layers: ["pref-fill"] })[0];
        setHoverPref(hit ? hit.id : null);
      });
      mapSection.addEventListener("mouseleave", () => setHoverPref(null));
      $("zoom-in").addEventListener("click", () => map.zoomIn({ duration: 350 }));
      $("zoom-out").addEventListener("click", () => map.zoomOut({ duration: 350 }));
      fitAll();
      layoutMarkers();
    });
  }

  function setTab(tab, focus) {
    if (state.tab === "gallery" && tab !== "gallery") galleryScroll = window.scrollY;
    gallery.hidden = tab !== "gallery";
    mapSection.classList.toggle("on", tab === "map");
    tabLinks.forEach((a) => {
      if (a.dataset.tab === tab) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    });
    if (tab !== "map" && map) setHoverPref(null);
    showCaption(null);
    if (tab === "gallery") window.scrollTo(0, galleryScroll);
    if (tab === "map") {
      const show = () => {
        map.resize();
        if (focus) map.jumpTo({ center: [focus.lng, focus.lat], zoom: Math.max(map.getZoom(), 12) });
        layoutMarkers();
      };
      if (map) show();
      else ensureMap().then(() => state.tab === "map" && show()).catch(() => {});
    }
  }

  function sizeTo(img, p) {
    const r = stage.getBoundingClientRect();
    const k = Math.min(r.width / p.w, r.height / p.h);
    img.style.width = `${Math.floor(p.w * k)}px`;
    img.style.height = `${Math.floor(p.h * k)}px`;
  }

  function fitViewer() {
    if (!shown) return;
    sizeTo(viewerImg, shown);
    const [prev, next] = [neighbor(-1), neighbor(1)];
    if (prev && peekPrev.getAttribute("src")) sizeTo(peekPrev, prev);
    if (next && peekNext.getAttribute("src")) sizeTo(peekNext, next);
  }

  function neighbor(delta) {
    if (!shown) return null;
    const pool = poolOf(shown);
    if (pool.length < 2) return null;
    const i = pool.findIndex((x) => x.id === shown.id);
    return pool[(i + delta + pool.length) % pool.length];
  }

  const bestSrc = (p) => (largeReady.has(p.id) ? src("l", p) : src("s", p));

  function updatePeeks() {
    [[peekPrev, neighbor(-1)], [peekNext, neighbor(1)]].forEach(([img, p]) => {
      if (!p) {
        img.removeAttribute("src");
        img.dataset.pid = "";
        return;
      }
      img.dataset.pid = p.id;
      img.alt = label(p);
      const want = bestSrc(p);
      if (img.getAttribute("src") !== want) img.src = want;
      sizeTo(img, p);
    });
  }

  function warmLarge(p) {
    if (largeReady.has(p.id)) return Promise.resolve();
    const im = new Image();
    im.src = src("l", p);
    return im.decode().then(() => {
      largeReady.add(p.id);
      [peekPrev, peekNext].forEach((img) => {
        if (img.dataset.pid === p.id) img.src = src("l", p);
      });
    }).catch(() => {});
  }

  function preloadAround() {
    [neighbor(1), neighbor(-1)].forEach((p) => {
      if (!p) return;
      warmLarge(p);
      warmSong(p);
    });
  }

  function showPhoto(p) {
    shown = p;
    const tile = thumbs.get(p.id);
    viewerImg.src = largeReady.has(p.id) ? src("l", p) : (tile && tile.currentSrc) || src("s", p);
    viewerImg.alt = label(p);
    fillNames(viewerA, viewerB, p.name);
    const placeLink = $("viewer-place");
    if (p.link) placeLink.href = p.link;
    else placeLink.removeAttribute("href");
    viewerMap.hidden = !onMap(p);
    const credit = $("viewer-credit");
    credit.hidden = !p.credit;
    credit.textContent = p.credit ? `Photo: ${p.credit}` : "";
    credit.classList.toggle("handle", Boolean(p.credit && p.credit.startsWith("@")));
    if (p.source) credit.href = p.source;
    else credit.removeAttribute("href");
    showMusic(p);
    const single = poolOf(p).length < 2;
    prevButton.hidden = single;
    nextButton.hidden = single;
    if (!viewer.open) viewer.showModal();
    fitViewer();
    if (!largeReady.has(p.id)) {
      const large = new Image();
      large.src = src("l", p);
      large.decode().then(() => {
        largeReady.add(p.id);
        afterMorph(() => {
          if (shown === p) viewerImg.src = large.src;
        });
      }).catch(() => {});
    }
    afterMorph(() => {
      if (shown !== p) return;
      updatePeeks();
      preloadAround();
    });
  }

  const MUSICKIT = "https://js-cdn.music.apple.com/musickit/v3/musickit.js";
  const SOUND_KEY = "kakurega-sound";
  const soundButton = $("sound");
  let soundOn = false;
  let musicKit = null;
  let kitReady = null;
  let playing = null;

  try {
    soundOn = sessionStorage.getItem(SOUND_KEY) === "1";
  } catch (e) {
    soundOn = false;
  }

  function ensureMusicKit() {
    if (!musicKit) {
      musicKit = loadFile("script", { src: "music-token.js?v=be449084" })
        .then(() => {
          if (!window.MUSIC_TOKEN || window.MUSIC_TOKEN.exp * 1000 < Date.now()) throw new Error("no token");
          const ready = new Promise((resolve) => (window.MusicKit ? resolve() : document.addEventListener("musickitloaded", resolve, { once: true })));
          return loadFile("script", { src: MUSICKIT, async: true }).then(() => ready);
        })
        .then(() => MusicKit.configure({ developerToken: window.MUSIC_TOKEN.token, app: { name: "KAKUREGA", build: "1.0" }, storefrontId: "jp", suppressErrorDialog: true }))
        .then((mk) => {
          const kit = mk || MusicKit.getInstance();
          kit.previewOnly = true;
          if (MusicKit.PlayerRepeatMode) kit.repeatMode = MusicKit.PlayerRepeatMode.one;
          kitReady = kit;
          return kit;
        })
        .catch((error) => {
          musicKit = null;
          throw error;
        });
    }
    return musicKit;
  }

  function unlockAudio() {
    if (!kitReady) return;
    try {
      kitReady.deferPlayback();
    } catch (e) {
      return;
    }
  }

  function setSound(on) {
    soundOn = on;
    soundButton.setAttribute("aria-pressed", String(on));
    soundButton.setAttribute("aria-label", on ? t("mute") : t("unmute"));
    try {
      sessionStorage.setItem(SOUND_KEY, on ? "1" : "0");
    } catch (e) {
      soundOn = on;
    }
  }

  const FADE_MS = 600;
  let fadeTimer = 0;

  function fadeIn(kit, p, offset, el) {
    clearInterval(fadeTimer);
    let begun = 0;
    let seeking = false;
    const release = () => {
      if (el) el.muted = false;
      begun = performance.now();
    };
    fadeTimer = setInterval(() => {
      if (playing !== p) return clearInterval(fadeTimer);
      if (!begun) {
        if (kit.playbackState !== 2 || seeking) return;
        if (offset > 0) {
          seeking = true;
          kit.seekToTime(offset).then(() => setTimeout(release, 60), release);
          return;
        }
        release();
      }
      const x = Math.min(1, (performance.now() - begun) / FADE_MS);
      kit.volume = 1 - (1 - x) * (1 - x);
      if (x >= 1) clearInterval(fadeTimer);
    }, 30);
  }

  let songFor = null;
  const warmed = new Set();

  function warmSong(p) {
    if (!p.music || warmed.has(p.music.id)) return;
    warmed.add(p.music.id);
    if (p.music.preview) fetch(p.music.preview, { mode: "no-cors" }).catch(() => {});
    if (kitReady && kitReady.api && kitReady.api.music) kitReady.api.music(`/v1/catalog/jp/songs/${p.music.id}`).catch(() => {});
  }

  function stopSong() {
    playing = null;
    songFor = null;
    clearInterval(fadeTimer);
    document.querySelectorAll("audio#apple-music-player").forEach((el) => {
      el.muted = false;
    });
    if (!musicKit) return;
    musicKit.then((kit) => kit.pause()).catch(() => {});
  }

  function startSong(p) {
    playing = p;
    songFor = p;
    ensureMusicKit()
      .then((kit) => {
        if (playing !== p || !soundOn) return null;
        clearInterval(fadeTimer);
        kit.volume = 0;
        const offset = Math.max(0, Number(p.music.start) || 0);
        return kit.setQueue({ song: p.music.id, startPlaying: false }).then(() => {
          if (playing !== p) return null;
          const els = document.querySelectorAll("audio#apple-music-player");
          const el = offset > 0 ? els[els.length - 1] : null;
          if (el) el.muted = true;
          fadeIn(kit, p, offset, el);
          return kit.play();
        });
      })
      .catch(() => {
        if (playing === p) setSound(false);
      });
  }

  function showMusic(p) {
    const box = $("viewer-music");
    const chip = $("music-chip");
    box.hidden = !p.music;
    soundButton.hidden = !p.music;
    if (!p.music) {
      stopSong();
      return;
    }
    $("music-art").src = p.music.art || "";
    $("music-title").textContent = p.music.title;
    $("music-artist").textContent = p.music.artist;
    chip.href = `https://music.apple.com/jp/album/${encodeURIComponent(p.music.album)}?i=${encodeURIComponent(p.music.id)}`;
    chip.setAttribute("aria-label", `${t("music")}: ${p.music.title} — ${p.music.artist}`);
    setSound(soundOn);
    if (soundOn) {
      if (songFor !== p) {
        playing = p;
        if (kitReady) startSong(p);
        else afterMorph(() => {
          if (shown === p && soundOn) startSong(p);
        });
      }
    } else {
      stopSong();
      afterMorph(() => ensureMusicKit().catch(() => {
        soundButton.hidden = true;
      }));
    }
  }

  function toggleSound() {
    if (!shown || !shown.music) return;
    unlockAudio();
    setSound(!soundOn);
    if (soundOn) startSong(shown);
    else stopSong();
  }

  function hidePhoto() {
    stopSong();
    shown = null;
    if (viewer.open) viewer.close();
  }

  function anchorFor(tab, id) {
    if (tab === "gallery") return origin && origin.dataset.pid === id && origin.isConnected ? origin : thumbs.get(id);
    const m = markerFor(id);
    return m ? m.pin : null;
  }

  function nameTab(tab) {
    if (tab === "gallery") {
      thumbs.forEach((img, id) => {
        if (inView(img)) setName(img, `p-${id}`);
      });
    } else {
      markers.forEach((m) => {
        if (inView(m.pin)) setName(m.pin, `p-${m.items[0].id}`);
      });
    }
  }

  function apply(next, focus) {
    if (next.tab !== state.tab || focus) setTab(next.tab, focus);
    if (next.id) showPhoto(byId.get(next.id));
    else hidePhoto();
    state.tab = next.tab;
    state.id = next.id;
  }

  function parse() {
    const [rawTab, id] = location.hash.slice(1).split("/");
    return { tab: TABS.includes(rawTab) ? rawTab : "gallery", id: id && byId.has(id) ? id : null };
  }

  function route() {
    const next = parse();
    const prev = { ...state };
    const focus = pendingFocus;
    pendingFocus = null;
    if (prev.tab === null) {
      apply(next, focus);
      return;
    }
    if (prev.tab === next.tab && prev.id === next.id && !focus) return;
    if (skipMorph) {
      skipMorph = false;
      apply(next, focus);
      return;
    }
    morph(
      () => {
        if (prev.id) setName(viewerImg, "photo");
        else if (next.id) setName(anchorFor(prev.tab, next.id), "photo");
        else nameTab(prev.tab);
      },
      () => apply(next, focus),
      () => {
        if (next.id) {
          setName(viewerImg, "photo");
        } else if (prev.id) {
          const anchor = anchorFor(next.tab, prev.id);
          if (anchor && inView(anchor)) setName(anchor, "photo");
        } else {
          nameTab(next.tab);
        }
      },
    );
  }

  function closeViewer() {
    if (openedHere) {
      openedHere = false;
      history.back();
    } else {
      history.replaceState(null, "", `#${state.tab}`);
      route();
    }
  }

  function goTo(p) {
    skipMorph = true;
    history.replaceState(null, "", `#${state.tab}/${p.id}`);
    route();
  }

  function settleTrack() {
    track.classList.remove("sliding");
    track.style.transform = "";
    sliding = false;
    updatePeeks();
  }

  function slideTo(delta, from = 0) {
    const next = neighbor(delta);
    if (!next || sliding) return;
    sliding = true;
    unlockAudio();
    if (soundOn && next.music && kitReady) startSong(next);
    else if (soundOn && !next.music) stopSong();
    const width = stage.getBoundingClientRect().width;
    const gap = parseFloat(getComputedStyle(stage).getPropertyValue("--slide-gap")) || 32;
    const distance = -delta * (width + gap);
    track.classList.add("sliding");
    const remaining = Math.abs(distance - from) / Math.abs(distance);
    track.style.transitionDuration = `${Math.max(0.16, 0.36 * remaining)}s`;
    requestAnimationFrame(() => {
      track.style.transform = `translateX(${distance}px)`;
    });
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      track.style.transitionDuration = "";
      goTo(next);
      viewerImg.decode().catch(() => {}).then(() => requestAnimationFrame(settleTrack));
    };
    track.addEventListener("transitionend", finish, { once: true });
    setTimeout(finish, 520);
  }

  function snapBack() {
    track.classList.add("sliding");
    track.style.transform = "";
    const clear = () => track.classList.remove("sliding");
    track.addEventListener("transitionend", clear, { once: true });
    setTimeout(clear, 420);
  }

  function step(delta) {
    if (!state.id) return;
    const pool = poolOf(byId.get(state.id));
    if (pool.length < 2) return;
    if (!reduceMotion.matches) return slideTo(delta);
    const i = pool.findIndex((p) => p.id === state.id);
    goTo(pool[(i + delta + pool.length) % pool.length]);
  }

  viewer.addEventListener("cancel", (e) => {
    e.preventDefault();
    closeViewer();
  });
  let dragged = false;
  viewer.addEventListener("click", (e) => {
    if (dragged) {
      dragged = false;
      return;
    }
    if (e.target === viewer || e.target === stage || e.target === track || e.target.classList.contains("peek") || e.target.classList.contains("shot") || ["FIGURE", "FIGCAPTION"].includes(e.target.tagName)) closeViewer();
  });
  viewer.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft") step(-1);
    if (e.key === "ArrowRight") step(1);
  });
  $("viewer-close").addEventListener("click", closeViewer);
  ["click", "touchend", "keydown"].forEach((type) => document.addEventListener(type, () => {
    if (soundOn) unlockAudio();
  }, { capture: true, passive: true }));
  soundButton.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleSound();
  });
  prevButton.addEventListener("click", () => step(-1));
  nextButton.addEventListener("click", () => step(1));
  viewerMap.addEventListener("click", () => {
    pendingFocus = onMap(shown) ? shown : null;
    openedHere = false;
  });

  let drag = null;
  stage.addEventListener("pointerdown", (e) => {
    if (sliding || (e.pointerType === "mouse" && e.button !== 0) || e.target.closest(".sound")) return;
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now(), mode: null, dx: 0, dy: 0, lastX: e.clientX, lastT: performance.now(), v: 0 };
  });
  stage.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    drag.dx = e.clientX - drag.x;
    drag.dy = e.clientY - drag.y;
    const now = performance.now();
    if (now > drag.lastT) drag.v = 0.8 * ((e.clientX - drag.lastX) / (now - drag.lastT)) + 0.2 * drag.v;
    drag.lastX = e.clientX;
    drag.lastT = now;
    if (!drag.mode) {
      if (Math.abs(drag.dx) > 8 && Math.abs(drag.dx) > Math.abs(drag.dy)) drag.mode = "x";
      else if (Math.abs(drag.dy) > 10) drag.mode = "y";
      else return;
      stage.setPointerCapture(e.pointerId);
      track.classList.remove("sliding");
    }
    if (drag.mode === "x") {
      const edge = neighbor(drag.dx < 0 ? 1 : -1) ? 1 : 0.3;
      track.style.transform = `translateX(${drag.dx * edge}px)`;
    } else if (drag.dy > 0) {
      track.style.transform = `translateY(${drag.dy * 0.6}px)`;
      track.style.opacity = String(Math.max(0.4, 1 - drag.dy / 600));
    }
  });
  const endDrag = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag;
    drag = null;
    if (!d.mode) return;
    dragged = true;
    setTimeout(() => {
      dragged = false;
    }, 50);
    track.style.opacity = "";
    if (d.mode === "x") {
      const width = stage.getBoundingClientRect().width;
      const fling = Math.abs(d.v) > 0.45 && Math.sign(d.v) === Math.sign(d.dx);
      const delta = d.dx < 0 ? 1 : -1;
      if ((Math.abs(d.dx) > width * 0.22 || fling) && neighbor(delta)) slideTo(delta, d.dx);
      else snapBack();
    } else if (d.dy > 110) {
      track.style.transform = "";
      closeViewer();
    } else {
      snapBack();
    }
  };
  stage.addEventListener("pointerup", endDrag);
  stage.addEventListener("pointercancel", endDrag);

  function applyLang() {
    document.documentElement.lang = lang;
    document.querySelectorAll("[data-t]").forEach((el) => {
      el.textContent = t(el.dataset.t);
    });
    document.querySelectorAll("[data-t-label]").forEach((el) => {
      el.setAttribute("aria-label", t(el.dataset.tLabel));
    });
    const sub = $("hero-sub");
    const subLang = lang === "ja" ? "en" : "ja";
    sub.textContent = TEXT[subLang].catch.replace("\n", subLang === "ja" ? "" : " ");
    sub.lang = subLang;
    $("hero-about").replaceChildren(...t("about").flatMap((line, i) => (i ? [document.createElement("br"), line] : [line])));
    langCurrent.textContent = langInfo(lang).label;
    langButton.setAttribute("aria-label", `${t("language")}: ${langInfo(lang).label}`);
    langMenu.querySelectorAll("button").forEach((b) => {
      if (b.dataset.lang === lang) b.setAttribute("aria-current", "true");
      else b.removeAttribute("aria-current");
    });
    thumbs.forEach((img, id) => {
      img.alt = label(byId.get(id));
    });
    extraImages.forEach(({ img, p }) => {
      img.alt = label(p);
    });
    if (season.items.length) seasonText();
    if (shown) {
      fillNames(viewerA, viewerB, shown.name);
      viewerImg.alt = label(shown);
    }
    if (map) {
      map.setStyle(styleFor());
      markers.forEach((m) => m.marker.remove());
      markers = new Map();
      layoutMarkers();
    }
  }

  LANGS.forEach((l) => {
    const b = document.createElement("button");
    b.type = "button";
    b.dataset.lang = l.code;
    b.lang = l.code;
    b.textContent = l.label;
    b.addEventListener("click", () => {
      if (langMenu.hidePopover) langMenu.hidePopover();
      if (l.code === lang) return;
      lang = l.code;
      rememberLang(lang);
      showCaption(null);
      applyLang();
    });
    langMenu.append(b);
  });

  $("brand").addEventListener("click", () => {
    if (state.tab === "gallery" && !state.id) window.scrollTo({ top: 0, behavior: reduceMotion.matches ? "auto" : "smooth" });
  });

  window.addEventListener("resize", fitViewer);
  window.addEventListener("resize", layoutSeason);
  window.addEventListener("hashchange", route);

  renderSeason();
  renderHero();
  renderGrid();
  applyLang();
  route();
  layoutSeason();
  if (season.items.length && !state.id) setTimeout(startTiles, 2500);
  else startTiles();

  const warmMap = () => ensureMap().catch(() => {});
  const mapTab = document.querySelector('[data-tab="map"]');
  ["pointerenter", "touchstart", "focus"].forEach((type) => mapTab.addEventListener(type, warmMap, { once: true, passive: true }));
  const saving = navigator.connection && navigator.connection.saveData;
  if (!saving && photos.some((p) => p.music && !p.demo)) {
    const warmMusic = () => (window.requestIdleCallback || setTimeout)(() => {
      if (!shown) ensureMusicKit().catch(() => {});
    }, { timeout: 4000 });
    const soon = () => setTimeout(warmMusic, 2500);
    if (document.readyState === "complete") soon();
    else window.addEventListener("load", soon, { once: true });
  }
  if (innerWidth >= 900 && !saving) {
    const later = () => setTimeout(() => (window.requestIdleCallback || setTimeout)(warmMap), 1500);
    if (document.readyState === "complete") later();
    else window.addEventListener("load", later, { once: true });
  }
})();
