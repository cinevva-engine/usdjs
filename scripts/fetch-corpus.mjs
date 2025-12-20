import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { pipeline } from 'node:stream/promises';
import unzipper from 'unzipper';

const here = path.dirname(new URL(import.meta.url).pathname);
const pkgRoot = path.resolve(here, '..');
const manifestPath = path.join(pkgRoot, 'test', 'corpus', 'manifest.json');
const outRoot = path.join(pkgRoot, 'test', 'corpus', 'external');

function readJson(p) {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function ensureDir(p) {
    fs.mkdirSync(p, { recursive: true });
}

async function downloadToFile(url, filePath) {
    await new Promise((resolve, reject) => {
        https.get(url, (res) => {
            if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                // redirect
                res.resume();
                downloadToFile(res.headers.location, filePath).then(resolve, reject);
                return;
            }
            if (res.statusCode !== 200) {
                reject(new Error(`HTTP ${res.statusCode} for ${url}`));
                res.resume();
                return;
            }
            const file = fs.createWriteStream(filePath);
            pipeline(res, file).then(resolve).catch(reject);
        }).on('error', reject);
    });
}

async function extractZip(zipPath, destDir) {
    ensureDir(destDir);
    await pipeline(
        fs.createReadStream(zipPath),
        unzipper.Extract({ path: destDir })
    );
}

async function main() {
    const manifest = readJson(manifestPath);
    ensureDir(outRoot);

    for (const src of manifest.sources) {
        const dest = path.join(outRoot, src.name);
        const marker = path.join(dest, '.extracted');
        const extractDir = path.join(dest, src.extractSubdir);
        if (fs.existsSync(marker)) {
            console.log(`✓ ${src.name} already extracted`);
            continue;
        }
        // If the corpus was cloned/extracted manually, prefer it and just create the marker.
        if (fs.existsSync(extractDir)) {
            fs.writeFileSync(
                marker,
                JSON.stringify(
                    { extractedAt: new Date().toISOString(), zipUrl: src.zipUrl, extractDir, note: 'pre-existing extractDir detected; skipping download' },
                    null,
                    2
                )
            );
            console.log(`✓ ${src.name} already present (found ${src.extractSubdir}); marked extracted`);
            continue;
        }

        console.log(`↓ Downloading ${src.name}`);
        ensureDir(dest);
        const zipFile = path.join(dest, 'corpus.zip');
        await downloadToFile(src.zipUrl, zipFile);

        console.log(`↯ Extracting ${src.name}`);
        await extractZip(zipFile, dest);

        // Mark extracted; keep zip for caching/debugging.
        fs.writeFileSync(marker, JSON.stringify({ extractedAt: new Date().toISOString(), zipUrl: src.zipUrl, extractDir }, null, 2));
        console.log(`✓ Ready: ${src.name}`);
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});


