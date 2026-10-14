/// <reference types="node" />
// The pack a `commitFiles` push sends, checked against real git: object ids match `git
// hash-object` / `git commit-tree`, and the pack unpacks into a repository that `git fsck`
// accepts, with exactly the intended tree. If any byte of the object or pack format were wrong,
// gild's receive-pack would refuse the push; this proves it offline.

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildPack, editTree, encodeCommit, hashObject, validatePath, type TreeEntry } from "../src/git-pack";

const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

function git(cwd: string, args: string[], input?: Uint8Array | string): string {
  return execFileSync("git", args, { cwd, env, input }).toString().trim();
}

function repoWithHistory(): { dir: string; head: string } {
  const dir = mkdtempSync(join(tmpdir(), "gild-pack-"));
  git(dir, ["init", "-q", "-b", "main"]);
  writeFileSync(join(dir, "README.md"), "# Demo\n\nThis is teh demo.\n");
  mkdirSync(join(dir, "docs"));
  writeFileSync(join(dir, "docs", "guide.md"), "guide\n");
  writeFileSync(join(dir, "docs", "old.md"), "old\n");
  git(dir, ["add", "."]);
  git(dir, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"]);
  return { dir, head: git(dir, ["rev-parse", "HEAD"]) };
}

/** Reads trees the way the gatekeeper does through gild's /git/trees API. */
function loader(dir: string) {
  return async (sha: string): Promise<TreeEntry[]> =>
    git(dir, ["ls-tree", sha]).split("\n").filter(Boolean).map(line => {
      const [meta, name] = line.split("\t") as [string, string];
      const [mode, type, oid] = meta.split(" ") as [string, TreeEntry["type"], string];
      // gild lists trees with a leading zero, as GitHub does.
      return { name, mode: type === "tree" ? "040000" : mode, type, sha: oid };
    });
}

describe("git objects", () => {
  it("hashes blobs like git hash-object", async () => {
    const blob = await hashObject("blob", new TextEncoder().encode("hello\n"));
    expect(blob.oid).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
  });

  it("refuses paths that escape the tree", () => {
    for (const bad of ["", "/etc/passwd", "a/../b", ".git/config", "a//b", "a\\b"]) {
      expect(() => validatePath(bad)).toThrow();
    }
    expect(validatePath("docs/guide.md")).toEqual(["docs", "guide.md"]);
  });
});

describe("commitFiles pack", () => {
  it("builds the commit git would, and a pack git accepts", async () => {
    const { dir, head } = repoWithHistory();
    const baseTree = git(dir, ["rev-parse", "HEAD^{tree}"]);
    const { root, objects } = await editTree(loader(dir), baseTree, [
      { path: "README.md", content: "# Demo\n\nThis is the demo.\n" },
      { path: "docs/old.md", content: null },
      { path: "docs/new/deep.md", content: "deep\n" },
    ]);
    const commit = await encodeCommit({
      tree: root, parents: [head], message: "Fix typo in README",
      author: { name: "sami/cfos", email: "sami+cfos@agents.gild.gg", seconds: 1_790_000_000 },
    });

    // Unpack into a fresh clone that has only the base history, as gild's repository does.
    const remote = mkdtempSync(join(tmpdir(), "gild-remote-"));
    git(remote, ["init", "-q", "--bare"]);
    git(dir, ["push", "-q", remote, "main"]);
    const pack = await buildPack([...objects, commit]);
    git(remote, ["unpack-objects", "-q"], pack);
    git(remote, ["update-ref", "refs/heads/fix", commit.oid]);
    git(remote, ["fsck", "--strict", "--no-dangling"]);

    // Same tree and commit ids as git computes from the same content.
    const expectedCommit = execFileSync("git", ["commit-tree", root, "-p", head, "-m", "Fix typo in README"], {
      cwd: remote,
      env: {
        ...env,
        GIT_AUTHOR_NAME: "sami/cfos", GIT_AUTHOR_EMAIL: "sami+cfos@agents.gild.gg", GIT_AUTHOR_DATE: "1790000000 +0000",
        GIT_COMMITTER_NAME: "sami/cfos", GIT_COMMITTER_EMAIL: "sami+cfos@agents.gild.gg", GIT_COMMITTER_DATE: "1790000000 +0000",
      },
    }).toString().trim();

    expect(commit.oid).toBe(expectedCommit);
    expect(git(remote, ["show", "fix:README.md"])).toBe("# Demo\n\nThis is the demo.".trim());
    expect(git(remote, ["ls-tree", "-r", "--name-only", "fix"]).split("\n")).toEqual(
      ["README.md", "docs/guide.md", "docs/new/deep.md"]);
    // Only the objects the edit created travel: 2 blobs + root, docs, docs/new trees + commit.
    expect(new DataView(pack.buffer, pack.byteOffset).getUint32(8)).toBe(6);
  });
});
