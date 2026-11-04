/**
 * 配布物の真正性情報と依存一覧（仕様 29.2・29.4）。
 *
 * ビルドの最後に dist/ へ次を書き出す。
 * - kotono-cms.html.sha256：HTML 成果物の SHA-256（`sha256sum -c` で照合できる形式）
 * - release-info.json：アプリ版・仕様版・同梱した依存ライブラリ（名前・版・ライセンス）
 * - THIRD-PARTY-LICENSES.txt：同梱した依存ライブラリのライセンス本文
 *
 * ハッシュを配布物と同じ場所に置くだけでは配布元の真正性は証明できない（29.4）。署名や
 * 別経路での公開方法はリリース手順で決める（README の「配布物の確認」を参照）。
 * 再現性のため、ビルド日時など実行ごとに変わる値は含めない。
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import type { Plugin } from "vite";

interface PkgInfo {
  name: string;
  version: string;
  license: string;
  dir: string;
}

/** モジュールのパスから、そのパッケージの package.json がある場所を求める */
function packageDir(id: string): string | null {
  const clean = id.replace(/\?.*$/, "").replace(/^\0/, "");
  const i = clean.lastIndexOf(`${sep}node_modules${sep}`);
  if (i < 0) return null;
  const rest = clean.slice(i + 14).split(sep);
  const n = rest[0]?.startsWith("@") ? 2 : 1;
  return join(clean.slice(0, i + 14), ...rest.slice(0, n));
}

export function releaseInfo(opts: { appVersion: string; specVersion: string; html: string }): {
  main: Plugin;
  collector: () => Plugin;
} {
  const dirs = new Set<string>();
  const collect = (ids: Iterable<string>) => {
    for (const id of ids) {
      const d = packageDir(id);
      if (d) dirs.add(d);
    }
  };
  const collector = (): Plugin => ({
    name: "kotono:collect-deps",
    generateBundle(_o, bundle) {
      for (const chunk of Object.values(bundle)) if (chunk.type === "chunk") collect(Object.keys(chunk.modules));
    },
  });
  const main: Plugin = {
    name: "kotono:release-info",
    apply: "build",
    enforce: "post",
    generateBundle(_o, bundle) {
      for (const chunk of Object.values(bundle)) if (chunk.type === "chunk") collect(Object.keys(chunk.modules));
    },
    closeBundle() {
      const outDir = "dist";
      const htmlPath = join(outDir, opts.html);
      if (!existsSync(htmlPath)) return;
      const bytes = readFileSync(htmlPath);
      const hash = createHash("sha256").update(bytes).digest("hex");
      writeFileSync(join(outDir, `${opts.html}.sha256`), `${hash}  ${opts.html}\n`);
      const pkgs = new Map<string, PkgInfo>();
      for (const d of dirs) {
        const pj = join(d, "package.json");
        if (!existsSync(pj)) continue;
        const p = JSON.parse(readFileSync(pj, "utf8")) as { name?: string; version?: string; license?: unknown };
        if (!p.name || !p.version) continue;
        pkgs.set(`${p.name}@${p.version}`, {
          name: p.name,
          version: p.version,
          license: typeof p.license === "string" ? p.license : "UNKNOWN",
          dir: d,
        });
      }
      const list = [...pkgs.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      writeFileSync(
        join(outDir, "release-info.json"),
        `${JSON.stringify(
          {
            app: "Kotono CMS",
            appVersion: opts.appVersion,
            specVersion: opts.specVersion,
            artifact: { file: opts.html, sha256: hash, bytes: bytes.length },
            bundledDependencies: list.map(({ name, version, license }) => ({ name, version, license })),
          },
          null,
          2,
        )}\n`,
      );
      const parts: string[] = ["Kotono CMS に同梱した第三者ライブラリのライセンス", "=".repeat(40), ""];
      for (const p of list) {
        const file = readdirSync(p.dir).find((f) => /^(licen[cs]e|copying)(\.|$)/i.test(f));
        parts.push(`${p.name}@${p.version}（${p.license}）`, "-".repeat(40));
        parts.push(
          file ? readFileSync(join(p.dir, file), "utf8").trim() : "（ライセンス本文がパッケージに含まれていません）",
        );
        parts.push("");
      }
      writeFileSync(join(outDir, "THIRD-PARTY-LICENSES.txt"), `${parts.join("\n")}\n`);
    },
  };
  return { main, collector };
}
