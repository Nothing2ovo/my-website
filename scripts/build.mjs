import { mkdir, copyFile, rm } from 'node:fs/promises';
// Deploy only public assets, never SQL, tests or other source files.
await rm(new URL('../dist/', import.meta.url), {recursive:true, force:true});
await mkdir(new URL('../dist/', import.meta.url), {recursive:true});
for (const file of ['index.html', 'style.css', 'app.js', 'auth.js', '_routes.json']) {
  await copyFile(new URL(`../${file}`, import.meta.url), new URL(`../dist/${file}`, import.meta.url));
}
console.log('Static assets ready in dist/. Pages compiles functions/ separately.');
