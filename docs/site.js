/* Skill Suitcase docs - chrome rendered from one manifest. */
(function () {
  "use strict";

  var NAV = [
    {
      title: "Start",
      items: [
        { n: "01", t: "Overview", h: "index.html" },
        { n: "02", t: "Install", h: "install.html" }
      ]
    },
    {
      title: "Model",
      items: [
        { n: "03", t: "Safety model", h: "safety-model.html" },
        { n: "04", t: "Catalog model", h: "catalog-model.html" },
        { n: "05", t: "Upstream refresh", h: "upstream-refresh.html" }
      ]
    },
    {
      title: "Operate",
      items: [
        { n: "06", t: "Agent workflows", h: "agent-workflows.html" },
        { n: "07", t: "Troubleshooting", h: "troubleshooting.html" },
        { t: "Operator skill", h: "https://github.com/calvinnwq/skill-suitcase/tree/main/skills/skill-suitcase", ext: true }
      ]
    },
    {
      title: "Reference",
      items: [
        { n: "08", t: "CLI reference", h: "reference.html" },
        { t: "GitHub", h: "https://github.com/calvinnwq/skill-suitcase", ext: true }
      ]
    }
  ];

  var ORDER = [];
  NAV.forEach(function (g) {
    g.items.forEach(function (i) {
      if (!i.ext) {
        ORDER.push(i);
        (i.children || []).forEach(function (c) { ORDER.push(c); });
      }
    });
  });

  var page = document.body.dataset.page || "index.html";

  /* ---------- theme ---------- */

  var THEME_KEY = "skill-suitcase-docs-theme";
  var INDEX_KEY = "skill-suitcase-docs-index-v2";

  function getStorageItem(storageName, key) {
    try {
      return window[storageName].getItem(key);
    } catch (_) {
      return null;
    }
  }

  function setStorageItem(storageName, key, value) {
    try {
      window[storageName].setItem(key, value);
    } catch (_) {}
  }

  function getStoredTheme() {
    return getStorageItem("localStorage", THEME_KEY);
  }
  function setStoredTheme(t) {
    setStorageItem("localStorage", THEME_KEY, t);
  }
  function preferredTheme() {
    return getStoredTheme() ||
      (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  }
  function applyTheme(t) {
    document.documentElement.dataset.theme = t;
    document.querySelectorAll("[data-theme-toggle]").forEach(function (b) {
      b.setAttribute("aria-pressed", t === "dark" ? "true" : "false");
    });
  }
  document.addEventListener("click", function (e) {
    if (!e.target.closest("[data-theme-toggle]")) return;
    var next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    setStoredTheme(next);
    applyTheme(next);
  });

  /* ---------- sidebar ---------- */

  function navLink(item, child) {
    var a = document.createElement("a");
    a.href = item.h;
    if (item.ext) { a.className = "ext"; a.rel = "noopener"; }
    if (item.h === page) a.setAttribute("aria-current", "page");
    if (item.n) {
      var n = document.createElement("span");
      n.className = "n";
      n.textContent = item.n;
      a.appendChild(n);
    }
    a.appendChild(document.createTextNode(item.t));
    return a;
  }

  function renderSidebar() {
    var nav = document.getElementById("sidebar");
    if (!nav) return;
    NAV.forEach(function (group) {
      var box = document.createElement("div");
      box.className = "nav-group";
      var h = document.createElement("p");
      h.className = "nav-group-title";
      h.textContent = group.title;
      box.appendChild(h);
      group.items.forEach(function (item) {
        box.appendChild(navLink(item));
        if (item.children) {
          var kids = document.createElement("div");
          kids.className = "children";
          kids.setAttribute("aria-label", item.t + " workflow pages");
          item.children.forEach(function (c) { kids.appendChild(navLink(c, true)); });
          box.appendChild(kids);
        }
      });
      nav.appendChild(box);
    });
  }

  /* ---------- pager ---------- */

  function renderPager() {
    var el = document.getElementById("pager");
    if (!el) return;
    var idx = ORDER.findIndex(function (i) { return i.h === page; });
    if (idx < 0) return;
    var prev = ORDER[idx - 1];
    var next = ORDER[idx + 1];
    el.innerHTML = "";
    [["prev", prev, "← Previous"], ["next", next, "Next →"]].forEach(function (def) {
      if (!def[1]) { el.appendChild(document.createElement("span")); return; }
      var a = document.createElement("a");
      a.className = def[0];
      a.href = def[1].h;
      a.innerHTML = '<span class="dir">' + def[2] + '</span><span class="t">' + def[1].t + "</span>";
      el.appendChild(a);
    });
  }

  /* ---------- headings: ids, anchors, toc ---------- */

  function slug(text) {
    return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  }

  function headingId(h, root) {
    if (h.id) return h.id;
    var owner = h.closest(".cmd[id]");
    if (owner) return owner.id;
    var base = slug(h.textContent) || "section";
    var id = base;
    var suffix = 2;
    while (root.getElementById(id)) {
      id = base + "-" + suffix;
      suffix += 1;
    }
    h.id = id;
    return id;
  }

  function renderToc() {
    var toc = document.getElementById("toc");
    var heads = document.querySelectorAll("article h2, article h3");
    var links = [];
    heads.forEach(function (h) {
      var id = headingId(h, document);
      var a = document.createElement("a");
      a.href = "#" + id;
      a.textContent = "#";
      a.className = "anchor";
      a.setAttribute("aria-label", "Link to " + h.textContent);
      h.appendChild(a);
      if (toc) {
        var t = document.createElement("a");
        t.href = "#" + id;
        t.textContent = h.childNodes[0].textContent.trim();
        if (h.tagName === "H3") t.className = "sub";
        toc.appendChild(t);
        links.push({ head: h, link: t });
      }
    });
    if (!links.length) return;
    /* getBoundingClientRect, not offsetTop: the entrance animation transforms
       sections, which makes them offsetParents and breaks offsetTop math. */
    function spy() {
      var current = links[0];
      links.forEach(function (l) {
        if (l.head.getBoundingClientRect().top <= 120) current = l;
      });
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) {
        current = links[links.length - 1];
      }
      links.forEach(function (l) { l.link.classList.toggle("active", l === current); });
    }
    window.addEventListener("scroll", spy, { passive: true });
    window.addEventListener("resize", spy, { passive: true });
    spy();
  }

  /* ---------- copy buttons ---------- */

  function renderCopy() {
    document.querySelectorAll("article pre").forEach(function (pre) {
      var wrap = document.createElement("div");
      wrap.className = "snippet";
      pre.parentNode.insertBefore(wrap, pre);
      wrap.appendChild(pre);
      var btn = document.createElement("button");
      btn.className = "copy-btn";
      btn.type = "button";
      btn.textContent = "copy";
      btn.addEventListener("click", function () {
        navigator.clipboard.writeText(pre.textContent.trim()).then(function () {
          btn.textContent = "copied";
          btn.classList.add("done");
          setTimeout(function () {
            btn.textContent = "copy";
            btn.classList.remove("done");
          }, 1400);
        });
      });
      wrap.appendChild(btn);
    });
  }

  /* ---------- mobile drawer ---------- */

  function closeDrawer() {
    document.body.classList.remove("nav-open");
    document.querySelectorAll("[data-menu]").forEach(function (btn) {
      btn.setAttribute("aria-expanded", "false");
    });
  }

  document.addEventListener("click", function (e) {
    var btn = e.target.closest("[data-menu]");
    if (btn) {
      var open = document.body.classList.toggle("nav-open");
      btn.setAttribute("aria-expanded", open ? "true" : "false");
      return;
    }
    if (document.body.classList.contains("nav-open") && e.target.closest("#sidebar a")) {
      closeDrawer();
    }
  });

  /* ---------- search palette ---------- */

  var INDEX = null;
  var INDEX_PROMISE = null;

  function isSearchEntry(entry) {
    return entry &&
      typeof entry.t === "string" &&
      typeof entry.h === "string" &&
      typeof entry.where === "string";
  }

  function isSearchIndex(value) {
    return Array.isArray(value) && value.every(isSearchEntry);
  }

  function buildIndex() {
    if (INDEX) return Promise.resolve(INDEX);
    if (INDEX_PROMISE) return INDEX_PROMISE;
    var cached = getStorageItem("sessionStorage", INDEX_KEY);
    if (cached) {
      try {
        var parsed = JSON.parse(cached);
        if (isSearchIndex(parsed)) {
          INDEX = parsed;
          return Promise.resolve(INDEX);
        }
      } catch (_) {}
    }
    var parser = new DOMParser();
    INDEX_PROMISE = Promise.all(ORDER.map(function (p) {
      return fetch(p.h).then(function (r) { return r.text(); }).then(function (html) {
        var doc = parser.parseFromString(html, "text/html");
        var entries = [{ t: p.t, h: p.h, where: p.t }];
        doc.querySelectorAll("article h2, article h3").forEach(function (head) {
          var text = head.textContent.trim();
          entries.push({ t: text, h: p.h + "#" + headingId(head, doc), where: p.t });
        });
        return entries;
      }).catch(function () { return [{ t: p.t, h: p.h, where: p.t }]; });
    })).then(function (lists) {
      INDEX = lists.flat();
      setStorageItem("sessionStorage", INDEX_KEY, JSON.stringify(INDEX));
      return INDEX;
    }).finally(function () {
      INDEX_PROMISE = null;
    });
    return INDEX_PROMISE;
  }

  var palette, paletteInput, paletteResults, backdrop, selIdx = 0;

  function openPalette() {
    if (!palette) buildPalette();
    backdrop.hidden = false;
    palette.hidden = false;
    paletteInput.value = "";
    renderResults("");
    paletteInput.focus();
    buildIndex();
  }

  function closePalette() {
    if (!palette) return;
    backdrop.hidden = true;
    palette.hidden = true;
  }

  function buildPalette() {
    backdrop = document.createElement("div");
    backdrop.className = "palette-backdrop";
    backdrop.hidden = true;
    backdrop.addEventListener("click", closePalette);

    palette = document.createElement("div");
    palette.className = "palette";
    palette.hidden = true;
    palette.setAttribute("role", "dialog");
    palette.setAttribute("aria-label", "Search documentation");

    paletteInput = document.createElement("input");
    paletteInput.type = "search";
    paletteInput.placeholder = "Search pages, sections, commands…";
    paletteInput.addEventListener("input", function () { renderResults(paletteInput.value); });
    paletteInput.addEventListener("keydown", function (e) {
      var items = paletteResults.querySelectorAll("a");
      if (e.key === "ArrowDown") { e.preventDefault(); selIdx = Math.min(selIdx + 1, items.length - 1); paint(items); }
      else if (e.key === "ArrowUp") { e.preventDefault(); selIdx = Math.max(selIdx - 1, 0); paint(items); }
      else if (e.key === "Enter" && items[selIdx]) { items[selIdx].click(); }
    });

    paletteResults = document.createElement("div");
    paletteResults.className = "palette-results";
    paletteResults.addEventListener("click", function (e) {
      if (e.target.closest("a")) closePalette();
    });

    palette.appendChild(paletteInput);
    palette.appendChild(paletteResults);
    document.body.appendChild(backdrop);
    document.body.appendChild(palette);
  }

  function paint(items) {
    items.forEach(function (a, i) { a.classList.toggle("sel", i === selIdx); });
    if (items[selIdx]) items[selIdx].scrollIntoView({ block: "nearest" });
  }

  function renderResults(q) {
    var capturedQuery = q;
    selIdx = 0;
    buildIndex().then(function (index) {
      if (paletteInput && paletteInput.value !== capturedQuery) return;
      var query = capturedQuery.trim().toLowerCase();
      var hits = !query
        ? index.filter(function (e) { return !e.h.includes("#"); })
        : index.filter(function (e) { return e.t.toLowerCase().includes(query); }).slice(0, 12);
      paletteResults.innerHTML = "";
      if (!hits.length) {
        var empty = document.createElement("p");
        empty.className = "empty";
        empty.textContent = "No matches. Try a command name or guide.";
        paletteResults.appendChild(empty);
        return;
      }
      hits.forEach(function (hit, i) {
        var a = document.createElement("a");
        a.href = hit.h;
        if (i === 0) a.className = "sel";
        var label = document.createElement("span");
        label.textContent = hit.t;
        var where = document.createElement("span");
        where.className = "where";
        where.textContent = hit.where;
        a.appendChild(label);
        a.appendChild(where);
        paletteResults.appendChild(a);
      });
    });
  }

  document.addEventListener("click", function (e) {
    if (e.target.closest("[data-search-open]")) openPalette();
  });

  document.addEventListener("keydown", function (e) {
    if (e.key === "/" && !e.target.closest("input, textarea") && (!palette || palette.hidden)) {
      e.preventDefault();
      openPalette();
    } else if (e.key === "Escape") {
      closePalette();
      closeDrawer();
    }
  });

  /* ---------- boot ---------- */

  applyTheme(preferredTheme());
  renderSidebar();
  renderPager();
  renderToc();
  renderCopy();
})();
