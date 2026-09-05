import { cp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = join(projectRoot, "dist");
const deployEntries = [
  "index.html",
  "styles.css",
  "manifest.webmanifest",
  "sw.js",
  "public",
  "src",
];

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });

for (const entry of deployEntries) {
  const source = join(projectRoot, entry);
  const destination = join(outputDirectory, entry);
  await cp(source, destination, { recursive: (await stat(source)).isDirectory() });
}

// GitHub Pages should serve this dependency-free app exactly as built.
await writeFile(join(outputDirectory, ".nojekyll"), "");

console.log(`static build: copied ${deployEntries.length} app entries to dist/`);
