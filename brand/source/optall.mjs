import { optimize } from "svgo";
import fs from "fs";
import path from "path";
const [, , src, dst] = process.argv;
fs.mkdirSync(dst, { recursive: true });
for (const f of fs.readdirSync(src).filter((f) => f.endsWith(".svg"))) {
  const raw = fs.readFileSync(path.join(src, f), "utf8");
  const r = optimize(raw, { multipass: true, floatPrecision: 2, plugins: ["preset-default"] });
  fs.writeFileSync(path.join(dst, f), r.data + "\n");
  console.log(f, raw.length, "->", r.data.length);
}
