import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { test } from "node:test";

import { parse } from "yaml";

/**
 * The static docs site under docs/ is plain HTML plus one stylesheet and one
 * client script, deployed as-is to GitHub Pages. These tests are the site's
 * deterministic build check: shared chrome, navigation coverage, link
 * integrity, storage-hardened client behavior, and the content contracts the
 * site must keep aligned with the shipped CLI.
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

test("docs site pages share the expected chrome", () => {
  for (const page of DOC_PAGES) {
    const html = read(page);
    const name = page.replace("docs/", "");
    assert.match(html, /class="masthead"/, page);
    assert.match(html, /class="brand" href="index\.html"/, page);
    assert.match(html, /data-theme-toggle/, page);
    assert.match(html, /data-search-open/, page);
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

  for (const page of DOC_PAGES) {
    const name = page.replace("docs/", "");
    assert.match(js, new RegExp(`h: "${name.replace(".", "\\.")}"`), name);
  }
  for (const n of ["01", "02", "03", "04", "05", "06", "07", "08"]) {
    assert.match(js, new RegExp(`n: "${n}"`), n);
  }
  assert.match(js, /setAttribute\("aria-current", "page"\)/);
  assert.match(js, /THEME_KEY = "skill-suitcase-docs-theme"/);
  assert.match(js, /skill-suitcase-docs-index-v2/);
  assert.doesNotMatch(js, /artshelf/i, "the docs chrome must use Skill Suitcase identifiers");
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
      dataset: { page: "index.html" },
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

  assert.doesNotThrow(() => {
    const runSite = new Function("document", "window", "navigator", "setTimeout", read("docs/site.js"));
    runSite(document, window, {}, setTimeout);
  });
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
});

test("install page covers the npm install and pinned source fallback", () => {
  const install = read("docs/install.html");

  assert.ok(install.includes("npm install --global skill-suitcase"));
  assert.ok(install.includes("Node.js 20 or newer"));
  assert.ok(install.includes("npm exec --yes --package=pnpm@10.34.4 -- pnpm"));
  assert.ok(install.includes('test "$(pnpm --version)" = "10.34.4"'));
  assert.ok(install.includes("pnpm install --frozen-lockfile"));
  assert.ok(install.includes("skills/skill-suitcase"));
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
    jobs: { deploy: { steps: Array<{ uses?: string; with?: { path?: string } }> } };
  };

  assert.ok(Object.hasOwn(workflow.on, "workflow_dispatch"));
  assert.deepEqual(workflow.on.push.branches, ["main"]);
  assert.ok(workflow.on.push.paths.includes("docs/**"));
  assert.deepEqual(workflow.permissions, { contents: "read", pages: "write", "id-token": "write" });

  const uses = workflow.jobs.deploy.steps.map((step) => step.uses).filter(Boolean);
  assert.deepEqual(uses, [
    "actions/checkout@v6",
    "actions/configure-pages@v6",
    "actions/upload-pages-artifact@v5",
    "actions/deploy-pages@v5"
  ]);
  const upload = workflow.jobs.deploy.steps.find((step) => step.uses === "actions/upload-pages-artifact@v5");
  assert.equal(upload?.with?.path, "docs");
});
