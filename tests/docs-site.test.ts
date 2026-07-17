import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { test } from "node:test";

import { parse } from "yaml";

/**
 * The static docs site under docs/ is plain HTML plus one stylesheet and one
 * client script, deployed as-is to GitHub Pages. These tests are the site's
 * deterministic build check: shared chrome, exact page and navigation
 * coverage, pager reading order, link integrity, storage-hardened client
 * behavior, and the content contracts the site must keep aligned with the
 * shipped CLI.
 */

const DOC_PAGES = [
  "docs/index.html",
  "docs/install.html",
  "docs/safety-model.html",
  "docs/catalog-model.html",
  "docs/upstream-refresh.html",
  "docs/agent-workflows.html",
  "docs/troubleshooting.html",
  "docs/reference.html"
];

function read(path: string): string {
  return readFileSync(path, "utf8");
}

function htmlPagePaths(directory: string): string[] {
  const pages: string[] = [];

  function visit(currentDirectory: string): void {
    for (const entry of readdirSync(currentDirectory, { withFileTypes: true })) {
      const path = join(currentDirectory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isFile() && entry.name.endsWith(".html")) {
        const page = relative(directory, path).split(sep).join("/");
        assert.ok(!page.includes("/"), `docs site only supports root-level HTML pages: ${page}`);
        pages.push(page);
      }
    }
  }

  visit(directory);
  return pages.sort();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function navigationEntries(source: string): Array<{ number: string | undefined; title: string; href: string }> {
  const declaration = "var NAV = ";
  const navigationStart = source.indexOf(declaration);
  const navigationEnd = source.indexOf("var ORDER = []", navigationStart);
  assert.ok(navigationStart >= 0 && navigationEnd > navigationStart, "site script must declare NAV before ORDER");
  const expression = source
    .slice(navigationStart + declaration.length, navigationEnd)
    .trim()
    .replace(/;$/, "");
  const navigation: unknown = new Function(`return (${expression});`)();
  assert.ok(Array.isArray(navigation), "NAV must be an array");

  const entries: Array<{ number: string | undefined; title: string; href: string }> = [];
  function appendItem(value: unknown): void {
    assert.ok(isRecord(value), "navigation items must be objects");
    const title = value.t;
    const href = value.h;
    if (typeof title !== "string") assert.fail("navigation items must have titles");
    if (typeof href !== "string") assert.fail("navigation items must have hrefs");
    if (value.ext === true) return;
    const number = value.n;
    if (number !== undefined && typeof number !== "string") {
      assert.fail("navigation item numbers must be strings");
    }
    entries.push({ number, title, href });
    if (value.children === undefined) return;
    assert.ok(Array.isArray(value.children), "navigation item children must be arrays");
    value.children.forEach(appendItem);
  }

  for (const group of navigation) {
    assert.ok(isRecord(group) && Array.isArray(group.items), "navigation groups must contain item arrays");
    group.items.forEach(appendItem);
  }
  return entries;
}

function runDocsSite(page: string): {
  clickHandlers: Array<(event: { target: { closest: (selector: string) => unknown } }) => void>;
  document: any;
  pager: any;
  sidebar: any;
} {
  const clickHandlers: Array<(event: { target: { closest: (selector: string) => unknown } }) => void> = [];
  const makeElement = (tagName = "div"): any => {
    const el: any = {
      tagName: tagName.toUpperCase(),
      childNodes: [{ textContent: "" }],
      children: [],
      classList: {
        add() {},
        remove() {},
        contains() { return false; },
        toggle() { return true; }
      },
      addEventListener() {},
      appendChild(child: unknown) {
        this.children.push(child);
        return child;
      },
      setAttribute() {}
    };
    return el;
  };
  const sidebar = makeElement("nav");
  const pager = makeElement("footer");
  const document: any = {
    body: {
      dataset: { page },
      classList: { remove() {}, contains() { return false; }, toggle() { return true; } },
      appendChild() {}
    },
    documentElement: { dataset: {}, scrollHeight: 1000 },
    addEventListener(type: string, handler: (event: { target: { closest: (selector: string) => unknown } }) => void) {
      if (type === "click") clickHandlers.push(handler);
    },
    createElement: makeElement,
    createTextNode(textContent: string) {
      return { textContent };
    },
    getElementById(id: string) {
      return id === "sidebar" ? sidebar : id === "pager" ? pager : null;
    },
    querySelectorAll() {
      return [];
    }
  };
  const window = {
    localStorage: {
      getItem() { throw new Error("blocked"); },
      setItem() { throw new Error("blocked"); }
    },
    matchMedia() {
      return { matches: true };
    },
    addEventListener() {},
    innerHeight: 800,
    scrollY: 0
  };
  const executeSite = new Function("document", "window", "navigator", "setTimeout", read("docs/site.js"));
  executeSite(document, window, {}, setTimeout);

  return { clickHandlers, document, pager, sidebar };
}

test("docs site pages share the expected chrome", () => {
  for (const page of DOC_PAGES) {
    const html = read(page);
    const name = page.replace("docs/", "");
    assert.match(html, /class="masthead"/, page);
    assert.match(html, /class="brand" href="index\.html"/, page);
    assert.match(html, /data-theme-toggle/, page);
    assert.match(html, /data-search-open/, page);
    assert.match(
      html,
      /data-search-open aria-label="Search documentation" aria-haspopup="dialog"><span>Search docs<\/span><kbd aria-hidden="true">\/<\/kbd>/,
      page
    );
    assert.match(html, /href="site\.css"/, page);
    assert.match(html, /src="site\.js" defer/, page);
    assert.match(html, /try\{stored=localStorage\.getItem\("skill-suitcase-docs-theme"\);/, page);
    assert.doesNotMatch(html, /dataset\.theme=localStorage\.getItem/, page);
    assert.match(html, new RegExp(`<body data-page="${name.replace(".", "\\.")}"`), page);
    assert.match(html, /<nav id="sidebar" class="sidebar" aria-label="Documentation">/, page);
    assert.match(html, /<nav id="toc" aria-label="On this page">/, page);
    assert.match(html, /<footer class="pager" id="pager">/, page);
    assert.match(html, /<a class="skip" href="#content">/, page);
  }
});

test("navigation manifest covers every page in numbered reading order", () => {
  const js = read("docs/site.js");
  const entries = navigationEntries(js);
  const sitePages = htmlPagePaths("docs").map((path) => `docs/${path}`);

  assert.deepEqual(
    entries.map((entry) => entry.href),
    DOC_PAGES.map((page) => page.replace("docs/", "")),
    "the navigation manifest must list every page exactly once in reading order"
  );
  assert.deepEqual(
    entries.map((entry) => entry.number),
    ["01", "02", "03", "04", "05", "06", "07", "08"],
    "numbered navigation must stay contiguous"
  );
  assert.equal(
    new Set(entries.map((entry) => entry.title)).size,
    entries.length,
    "navigation labels must stay unique"
  );
  assert.deepEqual(sitePages, [...DOC_PAGES].sort(), "every HTML page must be reachable from navigation");
  assert.match(js, /setAttribute\("aria-current", "page"\)/);
  assert.match(js, /THEME_KEY = "skill-suitcase-docs-theme"/);
  assert.match(js, /skill-suitcase-docs-index-v2/);
  assert.doesNotMatch(js, /artshelf/i, "the docs chrome must use Skill Suitcase identifiers");
});

test("rendered pager follows the documented reading order", () => {
  const pages = DOC_PAGES.map((page) => page.replace("docs/", ""));

  for (const [index, page] of pages.entries()) {
    const { pager } = runDocsSite(page);
    const previous = pages[index - 1];
    const next = pages[index + 1];

    assert.deepEqual(
      pager.children.map((child: any) => ({
        className: child.className ?? "",
        href: child.href ?? null
      })),
      [
        previous ? { className: "prev", href: previous } : { className: "", href: null },
        next ? { className: "next", href: next } : { className: "", href: null }
      ],
      `${page} pager must link to its DOC_PAGES neighbors`
    );
  }
});

test("navigation extraction includes unnumbered internal entries", () => {
  const entries = navigationEntries(`
    var NAV = [{ items: [
      { t: "Overview copy", h: "index.html", children: [
        { n: "02", t: "Install", h: "install.html" }
      ] },
      { t: "GitHub", h: "https://example.com", ext: true }
    ] }];
    var ORDER = [];
  `);

  assert.deepEqual(entries, [
    { number: undefined, title: "Overview copy", href: "index.html" },
    { number: "02", title: "Install", href: "install.html" }
  ]);
});

test("HTML page inventory rejects unsupported nested docs routes", (t) => {
  const fixture = mkdtempSync(join(tmpdir(), "skill-suitcase-docs-site-"));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  mkdirSync(join(fixture, "guides"));
  writeFileSync(join(fixture, "index.html"), "");
  writeFileSync(join(fixture, "guides", "setup.html"), "");

  assert.throws(
    () => htmlPagePaths(fixture),
    /docs site only supports root-level HTML pages: guides\/setup\.html/
  );
});

test("table of contents preserves canonical fragment owners", () => {
  const js = read("docs/site.js");

  assert.match(js, /var owner = h\.closest\("\.cmd\[id\]"\);\s*if \(owner\) return owner\.id;/);
  assert.match(js, /while \(root\.getElementById\(id\)\)/);
  assert.match(js, /a\.href = "#" \+ id/);
  assert.match(js, /t\.href = "#" \+ id/);
  assert.match(js, /p\.h \+ "#" \+ headingId\(head, doc\)/);
  assert.doesNotMatch(js, /if \(!h\.id\) h\.id = slug/);
});

test("docs chrome renders when web storage is unavailable", () => {
  const { clickHandlers, document, sidebar } = runDocsSite("index.html");

  assert.equal(document.documentElement.dataset.theme, "dark");
  assert.ok(sidebar.children.length > 0, "sidebar should render without storage");

  assert.doesNotThrow(() => {
    for (const handler of clickHandlers) {
      handler({
        target: {
          closest(selector: string) {
            return selector === "[data-theme-toggle]" ? {} : null;
          }
        }
      });
    }
  });
  assert.equal(document.documentElement.dataset.theme, "light");
});

test("docs search cache uses guarded session storage", () => {
  const js = read("docs/site.js");

  assert.match(js, /var INDEX_KEY = "skill-suitcase-docs-index-v2"/);
  assert.match(js, /var INDEX = null;\s*var INDEX_PROMISE = null;/);
  assert.match(js, /if \(INDEX_PROMISE\) return INDEX_PROMISE/);
  assert.match(js, /getStorageItem\("sessionStorage", INDEX_KEY\)/);
  assert.match(js, /function isSearchIndex\(value\) \{\s*return Array\.isArray\(value\) && value\.every\(isSearchEntry\);/);
  assert.match(js, /setStorageItem\("sessionStorage", INDEX_KEY, JSON\.stringify\(INDEX\)\)/);
  assert.doesNotMatch(js, /sessionStorage\.getItem/);
});

test("docs search closes when a result is activated", () => {
  const js = read("docs/site.js");

  assert.match(js, /paletteResults\.addEventListener\("click", function \(e\) \{\s*if \(e\.target\.closest\("a"\)\) closePalette\(\);/);
});

test("docs search behaves as an accessible modal", () => {
  const js = read("docs/site.js");

  assert.match(js, /palette\.setAttribute\("aria-modal", "true"\)/);
  assert.match(js, /paletteInput\.setAttribute\("aria-label", "Search documentation"\)/);
  assert.match(js, /function setBackgroundInert\(inert\)[\s\S]*?element\.inert = true;[\s\S]*?element\.setAttribute\("aria-hidden", "true"\)/);
  assert.match(js, /palette\.addEventListener\("keydown", trapPaletteFocus\)/);
  assert.match(js, /if \(e\.shiftKey && document\.activeElement === first\)[\s\S]*?last\.focus\(\)/);
  assert.match(js, /else if \(!e\.shiftKey && document\.activeElement === last\)[\s\S]*?first\.focus\(\)/);
  assert.match(js, /paletteOpener = opener \|\| document\.activeElement/);
  assert.match(js, /setBackgroundInert\(false\)[\s\S]*?opener\.focus\(\)/);
});

test("docs site collapses to a mobile drawer", () => {
  const css = read("docs/site.css");
  const js = read("docs/site.js");

  assert.match(css, /@media \(max-width: 880px\)/);
  assert.match(css, /@media \(max-width: 880px\)[\s\S]*\.menu-btn \{ display: inline-flex; \}/);
  assert.match(css, /@media \(max-width: 880px\)[\s\S]*\.sidebar \{\s*position: fixed/);
  assert.match(css, /body\.nav-open \.sidebar \{ transform: none; \}/);
  assert.match(js, /classList\.toggle\("nav-open"\)/);
  assert.match(js, /aria-expanded/);
  assert.match(js, /function closeDrawer\(\) \{\s*document\.body\.classList\.remove\("nav-open"\);[\s\S]*?setAttribute\("aria-expanded", "false"\)/);
  assert.match(js, /closest\("#sidebar a"\)[\s\S]*?closeDrawer\(\)/);
  assert.match(js, /e\.key === "Escape"[\s\S]*?closeDrawer\(\)/);
});

test("docs option tables stay within the mobile viewport", () => {
  const css = read("docs/site.css");
  const mobileCss = css.slice(css.indexOf("@media (max-width: 560px)"));

  assert.match(read("docs/safety-model.html"), /<table class="opts">/);
  assert.match(read("docs/troubleshooting.html"), /<table class="opts">/);
  assert.match(mobileCss, /table\.opts \{ table-layout: fixed; \}/);
  assert.match(mobileCss, /table\.opts th, table\.opts td \{ overflow-wrap: anywhere; \}/);
  assert.match(mobileCss, /table\.opts td:first-child \{ white-space: normal; \}/);
});

test("docs site uses ledger visual components instead of dense prose only", () => {
  const css = read("docs/site.css");

  for (const selector of [
    "ledger-row",
    "cmdline",
    "boundary-list",
    "stamp",
    "def-rows",
    "callout",
    "kicker",
    "lede",
    "copy-btn",
    "palette"
  ]) {
    assert.match(css, new RegExp(`\\.${selector}`), selector);
  }

  assert.match(read("docs/index.html"), /class="ledger"/);
  assert.match(read("docs/index.html"), /class="stamp refused"/);
  assert.match(read("docs/index.html"), /class="stamp readonly"/);
  assert.match(read("docs/safety-model.html"), /data-kind="boundary"/);
  assert.match(read("docs/safety-model.html"), /table class="opts"/);
  assert.match(read("docs/catalog-model.html"), /class="boundary-list"/);
  assert.match(read("docs/agent-workflows.html"), /class="ledger"/);
  assert.match(read("docs/troubleshooting.html"), /class="def-rows"/);
  assert.match(read("docs/reference.html"), /class="cmd-head"/);
});

test("docs site contains long code blocks inside the content column", () => {
  const css = read("docs/site.css");

  assert.match(css, /pre\s*\{[\s\S]*?overflow-x: auto/);
  assert.match(css, /pre code\s*\{[\s\S]*?white-space: pre/);
  assert.match(css, /\.article-col \{ min-width: 0; max-width: 70ch; \}/);
});

test("docs site local links resolve inside docs", () => {
  const docsRoot = resolve("docs");

  for (const page of DOC_PAGES) {
    const html = read(page);
    const links = [...html.matchAll(/\b(?:href|src)="([^"]+)"/g)]
      .map((match) => match[1])
      .filter((link): link is string => Boolean(link));
    for (const link of links) {
      if (link.startsWith("http") || link.startsWith("mailto:") || link.startsWith("data:") || link.startsWith("#")) continue;
      const target = resolve(dirname(page), link.split("#")[0] ?? link);
      const docsRelativePath = relative(docsRoot, target);
      assert.equal(
        !docsRelativePath.startsWith("..") && !isAbsolute(docsRelativePath),
        true,
        `${page} references local asset outside docs ${link}`
      );
      assert.equal(existsSync(target), true, `${page} references missing local asset ${link}`);
    }
  }
});

test("docs stay portable and describe shipped behavior", () => {
  for (const page of [...DOC_PAGES, "docs/site.js", "docs/site.css"]) {
    const text = read(page);
    assert.doesNotMatch(text, /\/Users\/[^/\s]+\//, `${page} should not contain a macOS user path`);
    assert.doesNotMatch(text, /\/home\/[^/\s]+\//, `${page} should not contain a Linux user path`);
    assert.doesNotMatch(
      text,
      /\b(?:roadmap|first milestone|future explicit flow)\b/i,
      `${page} should describe shipped behavior instead of planning milestones`
    );
  }
});

test("reference page documents the complete shipped command surface", () => {
  const reference = read("docs/reference.html");

  for (const id of [
    "import",
    "validate",
    "targets",
    "plan",
    "diff",
    "status",
    "upstream-check",
    "upstream-fetch",
    "pack",
    "plan-lock",
    "apply",
    "track",
    "reconcile",
    "repair",
    "prune",
    "rollback",
    "promote",
    "import-target",
    "upstream-import"
  ]) {
    assert.match(reference, new RegExp(`<div class="cmd" id="${id}">`), `reference should document ${id}`);
  }

  for (const override of [
    "--agents-skills",
    "--codex-home",
    "--codex-skills",
    "--claude-skills",
    "--grok-skills"
  ]) {
    assert.ok(reference.includes(override), `reference should document the ${override} override`);
  }

  assert.ok(reference.includes("exactly one approved input"));
  assert.ok(reference.includes("There is no CLI command that creates a plan lock"));
  assert.ok(reference.includes("All CLI command forms require <code>--json</code>"));
  assert.match(
    reference,
    /Pack refuses output beneath an absolute resolved install root,[\s\S]*?including CLI target overrides/
  );
});

test("install page covers the npm install and pinned source fallback", () => {
  const install = read("docs/install.html");
  const operatorSkillCodeBlock = install.match(
    /<pre><code><span class="c"># use the source checkout[\s\S]*?<\/code><\/pre>/
  )?.[0];
  assert.ok(operatorSkillCodeBlock, "the install page must keep its copyable operator-skill block");
  const operatorSkillCode = operatorSkillCodeBlock
    .replace(/<[^>]+>/g, "")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");

  assert.ok(install.includes("npm install --global skill-suitcase"));
  assert.ok(install.includes("Node.js 20 or newer"));
  assert.ok(install.includes("npm exec --yes --package=pnpm@10.34.4 -- pnpm"));
  assert.ok(install.includes('test "$(pnpm --version)" = "10.34.4"'));
  assert.ok(install.includes("pnpm install --frozen-lockfile"));
  assert.ok(install.includes("skills/skill-suitcase"));
  assert.ok(install.includes('INSTALL_TMP="$(mktemp -d "$AGENT_SKILLS_DIR/.skill-suitcase.install.XXXXXX")"'));
  assert.ok(install.includes('cp -R "$SKILL_SRC/." "$INSTALL_TMP/replacement/"'));
  assert.ok(install.includes('mv "$TARGET" "$INSTALL_TMP/previous"'));
  assert.ok(install.includes('mv "$INSTALL_TMP/replacement" "$TARGET"'));
  assert.match(install, /Skill source not found:[\s\S]*?return 1/);
  for (const root of [
    "$HOME/.codex/skills",
    "$HOME/.claude/skills",
    "$HOME/.agents/skills",
    "$HOME/.grok/skills",
    "$HOME/.hermes/skills",
    "$HOME/.hermes/profiles/<name>/skills",
  ]) {
    assert.ok(operatorSkillCode.includes(root), `the operator-skill block must document ${root}`);
  }
  assert.match(operatorSkillCode, /^AGENT_SKILLS_DIR="\$HOME\/\.codex\/skills"$/m);
  assert.equal(
    operatorSkillCode.match(/^\s*(?:export\s+)?AGENT_SKILLS_DIR\s*=/gm)?.length ?? 0,
    1,
    "the docs-site operator-skill block must leave only one active assignment"
  );
  assert.ok(
    install.indexOf('cp -R "$SKILL_SRC/." "$INSTALL_TMP/replacement/"')
      < install.indexOf('mv "$TARGET" "$INSTALL_TMP/previous"'),
    "the replacement must be staged before the installed skill moves"
  );
  assert.ok(install.includes("Restart the agent runtime"));
});

test("safety model page keeps the three phases and receipt contract visible", () => {
  const safety = read("docs/safety-model.html");
  const overview = read("docs/index.html");

  assert.match(safety, /Inspect, stage, then mutate\./);
  assert.ok(safety.includes(".skill-suitcase-receipt.json"));
  assert.ok(safety.includes("calvinnwq.skills.receipt.v0"));
  assert.ok(safety.includes("exactly one of <code>--lock</code> or"));
  for (const state of ["current", "missing", "version", "behind", "dirty", "blocked", "unknown"]) {
    assert.match(
      safety,
      new RegExp(`<span class="k">${state}</span>`),
      `safety model should define the ${state} status`
    );
  }
  assert.ok(safety.includes("byte-for-byte authorization"));
  assert.ok(overview.includes("read_only_target"));
});

test("catalog model page documents groups and source policy boundaries", () => {
  const catalog = read("docs/catalog-model.html");

  assert.ok(catalog.includes("skill-suitcase.yaml"));
  for (const key of [
    "suitcases",
    "assignments",
    "assignmentPaths",
    "groups",
    "compatibility",
    "variants",
    "sourcePolicy",
    "validationPolicy.skillify.skip"
  ]) {
    assert.ok(catalog.includes(`<span class="k">${key}</span>`), `catalog model should document ${key}`);
  }
  assert.ok(catalog.includes("reporting"));
  assert.ok(catalog.includes("symlink_source_policy_exclude"));
  assert.ok(catalog.includes("source_denied_path"));
  assert.ok(catalog.includes("source_untracked_files"));
});

test("upstream refresh page keeps the catalog-only lane and trust boundary", () => {
  const upstream = read("docs/upstream-refresh.html");
  const normalized = upstream.replace(/\s+/g, " ");

  assert.ok(upstream.includes("upstream check -> isolated temp fetch/diff -> catalog import -> Git review -> pack/apply"));
  assert.ok(upstream.includes(".skill-suitcase/upstream-lock.json"));
  assert.ok(upstream.includes("calvinnwq.skills.upstream-lock.v0"));
  assert.ok(normalized.includes("never writes a live agent"));
  assert.ok(normalized.includes("not pinned to a source revision or content hash"));
  for (const phase of [
    "upstream unchanged",
    "upstream changed",
    "local catalog edit",
    "upstream removed or renamed",
    "target drift"
  ]) {
    assert.ok(upstream.includes(`<span class="k">${phase}</span>`), `upstream page should cover ${phase}`);
  }
});

test("agent workflows page contrasts the recovery decision tree", () => {
  const workflows = read("docs/agent-workflows.html");

  for (const command of ["track", "reconcile", "repair", "prune", "promote", "import-target"]) {
    assert.match(
      workflows,
      new RegExp(`<span class="stage">${command}</span>`),
      `agent workflows should contrast ${command}`
    );
  }
  const normalized = workflows.replace(/\s+/g, " ");
  assert.ok(normalized.includes("drift-audit heartbeat"));
  assert.ok(normalized.includes("Reporting drift is automatic; importing or overwriting it is not."));
  assert.ok(normalized.includes("only after explicit approval"));
  assert.ok(normalized.includes("New-machine setup installs from the skills repo through Suitcase"));
});

test("agent workflows page carries the ten operational recipes", () => {
  const workflows = read("docs/agent-workflows.html");
  const normalized = workflows.replace(/\s+/g, " ");

  const RECIPES: ReadonlyArray<readonly [string, readonly string[]]> = [
    ["recipe-new-machine-setup", ["read-only", "staging-only", "live-target-mutating"]],
    ["recipe-read-only-audit", ["read-only"]],
    ["recipe-drift-heartbeat", ["read-only"]],
    ["recipe-missing-behind-pack-apply", ["read-only", "staging-only", "live-target-mutating"]],
    ["recipe-exact-match-track", ["read-only", "live-target-mutating"]],
    ["recipe-receiptless-mismatch-reconcile", ["read-only", "live-target-mutating"]],
    ["recipe-accidental-dirty-repair", ["read-only", "live-target-mutating"]],
    ["recipe-intentional-dirty-import-target", ["read-only", "catalog-mutating", "live-target-mutating"]],
    ["recipe-upstream-source-refresh", ["read-only", "catalog-mutating"]],
    ["recipe-provider-read-only", ["read-only"]]
  ];
  for (const [id] of RECIPES) {
    assert.match(workflows, new RegExp(`<h3 id="${id}">`), `agent workflows should keep the recipe section ${id}`);
  }

  function recipeSection(id: string): string {
    const start = workflows.indexOf(`<h3 id="${id}">`);
    assert.ok(start >= 0, `missing recipe section ${id}`);
    const boundaries = [workflows.indexOf("<h3 id=", start + 1), workflows.indexOf("<h2>", start + 1)]
      .filter((boundary) => boundary >= 0);
    return workflows.slice(start, boundaries.length > 0 ? Math.min(...boundaries) : workflows.length);
  }

  function literalCommandLines(section: string): string[] {
    return [...section.matchAll(/<pre><code>([\s\S]*?)<\/code><\/pre>/g)]
      .flatMap((match) => match[1]?.split("\n") ?? [])
      .map((line) => line.replace(/<[^>]+>/g, "").trim())
      .filter((line) => line.startsWith("skill-suitcase ") || line.startsWith('git -C "$SRC" '));
  }

  // Every recipe labels its steps with its exact shared write classifications
  // and carries a recipe-local approval boundary callout, including the
  // explicit no-apply boundaries in the read-only recipes.
  for (const [id, expectedClassifications] of RECIPES) {
    const actualClassifications = [...recipeSection(id).matchAll(/<span class="k">([^<]+)<\/span>/g)].map(
      (match) => match[1]
    );
    assert.deepEqual(actualClassifications, expectedClassifications, `${id} must classify every recipe step`);
    assert.ok(
      recipeSection(id).includes('<p class="callout-label">Approval</p>'),
      `${id} must carry a recipe-local approval boundary callout`
    );
  }

  // Every literal command in a recipe block sits under a class-labeled comment
  // that matches the command's actual write behavior, so no step is grouped
  // under the wrong write class or left unclassified.
  function expectedCommandClass(command: string): string {
    if (command.startsWith('git -C "$SRC" ')) return "read-only";
    if (command.includes("--dry-run")) return "read-only";
    if (command.startsWith("skill-suitcase upstream import ")) return "catalog-mutating";
    if (command.startsWith("skill-suitcase import-target ")) return "catalog-mutating + live-target-mutating";
    if (command.startsWith("skill-suitcase pack ") && command.includes("--output")) return "staging-only";
    if (/^skill-suitcase (?:apply|track|reconcile|repair|prune|promote|rollback)\b/.test(command)) {
      return "live-target-mutating";
    }
    if (/^skill-suitcase (?:import|validate|targets|plan|status|diff|upstream check|upstream fetch)\b/.test(command)) {
      return "read-only";
    }
    return assert.fail(`unrecognized literal workflow command: ${command}`);
  }
  const CLASS_COMMENT =
    /^# (read-only|staging-only|catalog-mutating \+ live-target-mutating|catalog-mutating|live-target-mutating)[:,]/;
  for (const block of workflows.matchAll(/<pre><code>([\s\S]*?)<\/code><\/pre>/g)) {
    let currentClass: string | null = null;
    for (const rawLine of (block[1] ?? "").split("\n")) {
      const line = rawLine.replace(/<[^>]+>/g, "").trim();
      const classComment = line.match(CLASS_COMMENT);
      if (classComment) currentClass = classComment[1] ?? null;
      if (!line.startsWith("skill-suitcase ") && !line.startsWith('git -C "$SRC" ')) continue;
      assert.equal(
        currentClass,
        expectedCommandClass(line),
        `every literal workflow step on the page must carry its write classification: ${line}`
      );
    }
  }

  // Git review enumerates names before contents and never prints ignored-file
  // contents into tool output.
  assert.doesNotMatch(workflows, /--no-index/, "Git review must not render file contents indiscriminately");
  assert.doesNotMatch(workflows, /ls-files --others/, "Git review must enumerate names with status --short --ignored");
  assert.ok(
    workflows.includes('git -C "$SRC" status --short --ignored --untracked-files=all -- skills/existing-skill'),
    "post-import Git review must enumerate every untracked and ignored name without contents"
  );
  assert.ok(normalized.includes("Never render ignored-file contents into tool output"));

  // The state-to-command routing distinctions must stay explicit.
  assert.ok(normalized.includes("Missing and behind route to <code>pack</code> plus <code>apply</code>"));
  assert.ok(normalized.includes("Exact unknown matches route to <code>track</code>"));
  assert.ok(normalized.includes("receiptless mismatched-directory case routes to <code>reconcile</code>"));
  assert.ok(normalized.includes("accidental dirty routes to <code>repair</code>"));
  assert.ok(normalized.includes("Intentional dirty routes to <code>import-target</code>"));

  // track has no dry-run mode; diff is its preview, and no example invents one.
  assert.ok(normalized.includes("track has no dry-run flag"));
  const literalCommands = literalCommandLines(workflows);
  assert.ok(literalCommands.length > 0, "agent workflows should keep literal commands");
  for (const command of literalCommands) {
    if (command.startsWith("skill-suitcase track ")) {
      assert.doesNotMatch(command, /--dry-run/, "track must not be documented with a --dry-run flag");
    }
  }

  // Every mutation-capable recipe separates its read-only or staging evidence
  // from the approval-gated mutation step.
  const APPROVAL_GATED: ReadonlyArray<readonly [string, string, string]> = [
    ["recipe-new-machine-setup", "--dry-run", "skill-suitcase apply"],
    ["recipe-missing-behind-pack-apply", "--dry-run", "skill-suitcase apply"],
    ["recipe-exact-match-track", "skill-suitcase diff", "skill-suitcase track"],
    ["recipe-receiptless-mismatch-reconcile", "--dry-run", "--apply"],
    ["recipe-accidental-dirty-repair", "--dry-run", "--apply"],
    ["recipe-intentional-dirty-import-target", "--dry-run", "--apply"],
    ["recipe-upstream-source-refresh", "--dry-run", "--apply"]
  ];
  for (const [id, preview, mutation] of APPROVAL_GATED) {
    const section = recipeSection(id);
    const approval = section.indexOf('<p class="callout-label">Approval</p>');
    assert.ok(approval >= 0, `${id} must carry an approval callout`);
    assert.ok(
      literalCommandLines(section.slice(0, approval)).some((command) => command.includes(preview)),
      `${id} must show its literal ${preview} command before the approval callout`
    );
    assert.ok(
      literalCommandLines(section.slice(approval)).some((command) => command.includes(mutation)),
      `${id} must gate its literal ${mutation} command behind the approval callout`
    );
  }
  assert.ok(
    normalized.includes("explicit approval naming the source catalog, target, exact skills, action, and mode"),
    "agent workflows should state the shared approval contract"
  );

  // The post-approval anti-TOCTOU re-check is part of the executable
  // contract: each approved mutation is immediately preceded by a re-run of
  // its preview evidence inside the approved sequence.
  const POST_APPROVAL_RECHECKS: ReadonlyArray<readonly [string, string, string]> = [
    ["recipe-exact-match-track", "skill-suitcase diff ", "skill-suitcase track "],
    ["recipe-receiptless-mismatch-reconcile", "--dry-run", "--apply"],
    ["recipe-accidental-dirty-repair", "--dry-run", "--apply"],
    ["recipe-intentional-dirty-import-target", "--dry-run", "--apply"],
    ["recipe-upstream-source-refresh", "--dry-run", "--apply"]
  ];
  for (const [id, recheck, mutation] of POST_APPROVAL_RECHECKS) {
    const section = recipeSection(id);
    const approval = section.indexOf('<p class="callout-label">Approval</p>');
    assert.ok(approval >= 0, `${id} must carry an approval callout`);
    const approved = literalCommandLines(section.slice(approval));
    const recheckIndex = approved.findIndex((command) => command.includes(recheck));
    const mutationIndex = approved.findIndex((command) => command.includes(mutation));
    assert.ok(
      recheckIndex >= 0 && mutationIndex > recheckIndex,
      `${id} must re-run its ${recheck} preview after approval and before ${mutation}`
    );
  }

  // Artifact recipes must not treat a pre-approval bundle as authorization:
  // the approved sequence itself re-runs diff, stages a fresh bundle, and
  // applies that just-staged artifact with an explicit install mode.
  for (const id of ["recipe-new-machine-setup", "recipe-missing-behind-pack-apply"]) {
    const section = recipeSection(id);
    const approval = section.indexOf('<p class="callout-label">Approval</p>');
    assert.ok(
      literalCommandLines(section.slice(0, approval)).every((command) => !command.includes("--output")),
      `${id} must not stage an applied bundle before the approval callout`
    );
    const approved = literalCommandLines(section.slice(approval));
    const freshDiff = approved.findIndex((command) => command.startsWith("skill-suitcase diff "));
    const freshPack = approved.findIndex((command) => command.includes('--output "$OUT"'));
    const freshApply = approved.findIndex((command) => command.startsWith("skill-suitcase apply "));
    assert.ok(
      freshDiff >= 0 && freshPack > freshDiff && freshApply > freshPack,
      `${id} must re-run diff and pack immediately before the approved apply`
    );
  }
  for (const command of literalCommands) {
    if (command.startsWith("skill-suitcase apply ")) {
      assert.ok(command.includes("--mode copy"), `apply must encode the approved install mode: ${command}`);
    }
  }

  // The guarded dirty-behind exception stays distinguished from ordinary
  // dirty edits, which still route to repair or import-target.
  assert.ok(normalized.includes("guarded dirty-behind case"));
  assert.ok(normalized.includes("An ordinary <code>dirty</code> edit is never fixed by apply"));

  // Read-only recipes must stay mutation-free.
  for (const id of ["recipe-read-only-audit", "recipe-drift-heartbeat", "recipe-provider-read-only"]) {
    assert.doesNotMatch(
      recipeSection(id),
      /skill-suitcase (?:apply|pack|track|reconcile|repair|prune|promote|import-target|rollback|upstream import)\b/,
      `${id} must not run a staging or mutation command`
    );
  }
  assert.ok(normalized.includes("a heartbeat run must never trigger an implicit repair or import"));

  // Upstream refresh ends with ordinary Git review before any target sync.
  const upstream = recipeSection("recipe-upstream-source-refresh");
  const upstreamCommands = literalCommandLines(upstream);
  const upstreamImport = upstreamCommands.findIndex((command) => command.startsWith("skill-suitcase upstream import "));
  const upstreamUntrackedReview = upstreamCommands.findIndex((command) =>
    command ===
      'git -C "$SRC" status --short --ignored --untracked-files=all -- skills/existing-skill .skill-suitcase/upstream-lock.json'
  );
  const upstreamSkillDiff = upstreamCommands.findIndex(
    (command) => command === 'git -C "$SRC" diff -- skills/existing-skill/SKILL.md'
  );
  const upstreamLockDiff = upstreamCommands.findIndex(
    (command) => command === 'git -C "$SRC" diff -- .skill-suitcase/upstream-lock.json'
  );
  assert.ok(upstreamImport >= 0, "upstream refresh must carry a literal import command");
  assert.ok(
    upstreamUntrackedReview > upstreamImport,
    "upstream import must be followed by names-first Git review"
  );
  assert.ok(
    upstreamSkillDiff > upstreamUntrackedReview && upstreamLockDiff > upstreamSkillDiff,
    "upstream Git review must inspect reviewed tracked paths individually after enumerating names"
  );
  assert.ok(normalized.includes("Only after that review does normal catalog-to-target synchronization start"));

  // Provider-owned targets are reported as boundaries, never bypassed.
  const provider = recipeSection("recipe-provider-read-only");
  assert.ok(provider.includes("read_only_target"));
  assert.ok(provider.includes("skipped"));
  assert.ok(provider.includes("never retry"));

  // New-machine setup stays on an approved catalog at portable roots.
  const newMachine = recipeSection("recipe-new-machine-setup");
  const newMachineNormalized = newMachine.replace(/\s+/g, " ");
  assert.ok(newMachine.includes("$HOME/.skill-suitcase/skills"));
  assert.ok(newMachine.includes("INSTALL.md"));
  assert.ok(newMachineNormalized.includes("The apply result's <code>installRoot</code> identifies the receipt location"));
  assert.ok(newMachine.includes("<code>&lt;installRoot&gt;/.skill-suitcase-receipt.json</code>"));
  assert.ok(newMachineNormalized.includes("<code>ApplyResult</code> does not expose a separate receipt-path field"));
  assert.ok(!newMachineNormalized.includes("receipt path appears in the apply result"));

  const intentionalImport = recipeSection("recipe-intentional-dirty-import-target").replace(/\s+/g, " ");
  const intentionalImportCommands = literalCommandLines(recipeSection("recipe-intentional-dirty-import-target"));
  const importTargetApply = intentionalImportCommands.findIndex((command) =>
    command.startsWith("skill-suitcase import-target ") && command.includes("--apply")
  );
  const importTargetUntrackedReview = intentionalImportCommands.findIndex((command) =>
    command === 'git -C "$SRC" status --short --ignored --untracked-files=all -- skills/existing-skill'
  );
  const importTargetGitDiff = intentionalImportCommands.findIndex(
    (command) => command === 'git -C "$SRC" diff -- skills/existing-skill/SKILL.md'
  );
  assert.ok(
    importTargetUntrackedReview > importTargetApply,
    "import-target must be followed by names-first Git review"
  );
  assert.ok(
    importTargetGitDiff > importTargetUntrackedReview,
    "import-target Git review must inspect a reviewed tracked path only after enumerating names"
  );
  assert.ok(intentionalImport.includes("every <code>repoWrites</code> <code>create</code> action"));
  assert.ok(intentionalImport.includes("Revert only the imported skill paths"));
  assert.ok(intentionalImport.includes("<code>behind</code> or <code>version</code>"));
  assert.ok(intentionalImport.includes("repair will refuse it"));
  assert.ok(intentionalImport.includes("recipe 4's fresh"));

  // Every literal workflow command keeps the portable deterministic contract.
  const commandLines = literalCommands.filter((line) => line.startsWith("skill-suitcase "));
  assert.ok(commandLines.length >= 20, "agent workflows should keep its literal recipe commands");
  for (const line of commandLines) {
    assert.ok(line.includes("--json"), `workflow command must use --json: ${line}`);
    assert.ok(
      line.includes('--source "$SRC"') || line.startsWith("skill-suitcase rollback --receipt "),
      `workflow command must reference the catalog through SRC: ${line}`
    );
  }
});

test("troubleshooting page collects the common refusal codes", () => {
  const troubleshooting = read("docs/troubleshooting.html");

  for (const code of [
    "read_only_target",
    "source_denied_path",
    "symlink_source_policy_exclude",
    "source_untracked_files",
    "unsafe_target_state",
    "plan_lock_",
    "symlink_source_escape",
    "symlink_target_conflict",
    "receipt_lock_failed"
  ]) {
    assert.ok(troubleshooting.includes(code), `troubleshooting should document ${code}`);
  }
  assert.ok(troubleshooting.includes(".skills-sync.json"));
  assert.ok(troubleshooting.includes("quarantine"));
});

test("README routes deep readers to the docs site", () => {
  const readme = read("README.md");
  assert.ok(
    readme.includes("https://calvinnwq.github.io/skill-suitcase/"),
    "README should link to the published docs site"
  );
});

test("package.json serves the docs site locally", () => {
  const packageJson = JSON.parse(read("package.json")) as {
    homepage: string;
    scripts: Record<string, string>;
    files: string[];
  };
  assert.equal(packageJson.homepage, "https://calvinnwq.github.io/skill-suitcase/");
  assert.equal(
    packageJson.scripts["docs:serve"],
    "python3 -m http.server 8080 --bind 127.0.0.1 --directory docs"
  );
  assert.ok(
    !packageJson.files.some((entry) => entry.endsWith(".html") || entry.endsWith("site.js") || entry.endsWith("site.css")),
    "the docs site ships through Pages, not the npm tarball"
  );
});

test("pages workflow deploys the docs directory with current action majors", () => {
  assert.ok(existsSync("docs/.nojekyll"), "docs/.nojekyll must disable Jekyll processing on Pages");

  const workflow = parse(read(".github/workflows/pages.yml")) as {
    on: { workflow_dispatch: unknown; push: { branches: string[]; paths: string[] } };
    permissions: Record<string, string>;
    jobs: {
      deploy: {
        steps: Array<{ uses?: string; with?: { path?: string; "include-hidden-files"?: boolean } }>;
      };
    };
  };

  assert.ok(Object.hasOwn(workflow.on, "workflow_dispatch"));
  assert.deepEqual(workflow.on.push.branches, ["main"]);
  assert.ok(workflow.on.push.paths.includes("docs/**"));
  assert.deepEqual(workflow.permissions, { contents: "read", pages: "write", "id-token": "write" });

  const uses = workflow.jobs.deploy.steps.map((step) => step.uses).filter(Boolean);
  assert.deepEqual(uses, [
    "actions/checkout@v7",
    "actions/configure-pages@v6",
    "actions/upload-pages-artifact@v5",
    "actions/deploy-pages@v5"
  ]);
  const upload = workflow.jobs.deploy.steps.find((step) => step.uses === "actions/upload-pages-artifact@v5");
  assert.equal(upload?.with?.path, "docs");
  assert.equal(upload?.with?.["include-hidden-files"], true);
});
