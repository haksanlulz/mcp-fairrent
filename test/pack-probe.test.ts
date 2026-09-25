import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The pack probe's FAIL line has to say why. `npm install --silent` writes
 * nothing on failure (measured 2026-09-15: status 1, stderr 0 bytes, stdout 0
 * bytes), so the cold-install FAIL printed an empty reason. This drives the real
 * script in consume mode against a file that is not a tarball: offline, no build,
 * and npm fails fast.
 */
describe("pack-probe cold-install failure", () => {
  it("prints the exit status and a non-empty cause", () => {
    const dir = mkdtempSync(join(tmpdir(), "packprobe-test-"));
    try {
      const bogus = join(dir, "bogus.tgz");
      writeFileSync(bogus, "not a tarball");
      const r = spawnSync(process.execPath, [join(ROOT, "scripts", "pack-probe.mjs")], {
        cwd: ROOT,
        env: { ...process.env, PACK_PROBE_TARBALL: bogus },
        encoding: "utf8",
      });
      expect(r.status).toBe(1);
      const line = (r.stderr ?? "").split(/\r?\n/).find((l) => l.startsWith("FAIL: cold install failed"));
      expect(line).toBeDefined();
      expect(line).toMatch(/status 1/);
      // Something after the status: npm's own words, not an empty tail.
      const cause = line!.replace(/^FAIL: cold install failed \(status \d+\):?/, "").trim();
      expect(cause.length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
