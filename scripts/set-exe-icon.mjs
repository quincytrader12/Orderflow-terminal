// Stamp the emblem icon and product details onto the unpacked Windows exe.
// electron-builder does this itself on Windows; on Linux/macOS it needs Wine,
// so local builds use this pure-JS resource editor instead.
//
//   node scripts/set-exe-icon.mjs [path/to/Novus Ordo.exe]
import { readFileSync, writeFileSync } from 'node:fs';
import ResEdit from 'resedit';

const exe = process.argv[2] ?? 'release/win-unpacked/Novus Ordo.exe';
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const bin = ResEdit.NtExecutable.from(readFileSync(exe), { ignoreCert: true });
const res = ResEdit.NtExecutableResource.from(bin);

const ico = ResEdit.Data.IconFile.from(readFileSync(new URL('../build/icon.ico', import.meta.url)));
const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
const target = groups[0] ?? { id: 1, lang: 1033 };
ResEdit.Resource.IconGroupEntry.replaceIconsForResource(
  res.entries,
  target.id,
  target.lang,
  ico.icons.map((i) => i.data),
);

const [vi] = ResEdit.Resource.VersionInfo.fromEntries(res.entries);
if (vi) {
  const lang = { lang: 1033, codepage: 1200 };
  vi.setStringValues(lang, {
    ProductName: 'Novus Ordo',
    FileDescription: 'Novus Ordo — order-flow terminal',
    CompanyName: 'Quincy Gininda',
    LegalCopyright: `© ${new Date().getFullYear()} Quincy Gininda`,
    OriginalFilename: 'Novus Ordo.exe',
  });
  const [a, b, c] = pkg.version.split('.').map(Number);
  vi.setFileVersion(a, b, c, 0, 1033);
  vi.setProductVersion(a, b, c, 0, 1033);
  vi.outputToResourceEntries(res.entries);
}
res.outputResource(bin);
writeFileSync(exe, Buffer.from(bin.generate()));
console.log(`icon and version info written to ${exe} (${ico.icons.length} sizes)`);
