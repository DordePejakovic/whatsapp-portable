#!/usr/bin/env node
// Builds the portable app:
//   <out>\whatsapp-portable.exe   Go launcher (single instance, portable data)
//   <out>\portapp.json
//   <out>\app\WhatsApp.exe        Electron runtime + WhatsApp Web shell (electron\)
//
// Usage: node scripts/build.js [--out <dir>] [--electron <version>]
// Requires: Node.js 18+, Go in PATH (or GO env var), Windows tar.exe (built in since Windows 10).
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const CACHE = path.join(ROOT, '.dev', 'cache');
const DEFAULT_ELECTRON = '45.2.3';
const RCEDIT_VERSION = '2.0.0';

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const OUT = path.resolve(arg('out', path.join(ROOT, 'bin', 'whatsapp-portable')));
const ELECTRON_VERSION = arg('electron', DEFAULT_ELECTRON);
const GO = process.env.GO || 'go';
const TAR = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');

function readProperties(file) {
  const props = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([^#=\s][^=]*?)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) {
      props[m[1]] = m[2];
    }
  }
  return props;
}

function run(cmd, args, opts = {}) {
  console.log(`> ${cmd} ${args.join(' ')}`);
  execFileSync(cmd, args, { stdio: 'inherit', cwd: ROOT, ...opts });
}

async function download(url, dest) {
  if (fs.existsSync(dest)) {
    console.log(`Using cached ${path.basename(dest)}`);
    return dest;
  }
  console.log(`Downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Download failed (${res.status}): ${url}`);
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.part`;
  fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
  fs.renameSync(tmp, dest);
  return dest;
}

function copyDir(src, dest) {
  fs.cpSync(src, dest, { recursive: true, force: true });
}

async function buildApp(props, version) {
  const appDir = path.join(OUT, 'app');
  const zip = await download(
    `https://github.com/electron/electron/releases/download/v${ELECTRON_VERSION}/electron-v${ELECTRON_VERSION}-win32-x64.zip`,
    path.join(CACHE, `electron-v${ELECTRON_VERSION}-win32-x64.zip`));
  const rcedit = await download(
    `https://github.com/electron/rcedit/releases/download/v${RCEDIT_VERSION}/rcedit-x64.exe`,
    path.join(CACHE, `rcedit-${RCEDIT_VERSION}-x64.exe`));

  // Replace the runtime completely so no stale files from older builds remain.
  fs.rmSync(appDir, { recursive: true, force: true });
  fs.mkdirSync(appDir, { recursive: true });
  run(TAR, ['-xf', zip, '-C', appDir]);

  fs.renameSync(path.join(appDir, 'electron.exe'), path.join(appDir, 'WhatsApp.exe'));
  fs.rmSync(path.join(appDir, 'resources', 'default_app.asar'), { force: true });

  const resApp = path.join(appDir, 'resources', 'app');
  copyDir(path.join(ROOT, 'electron'), resApp);
  fs.copyFileSync(path.join(ROOT, 'res', 'app.ico'), path.join(resApp, 'icon.ico'));

  run(rcedit, [
    path.join(appDir, 'WhatsApp.exe'),
    '--set-icon', path.join(ROOT, 'res', 'app.ico'),
    '--set-version-string', 'FileDescription', 'WhatsApp',
    '--set-version-string', 'ProductName', 'WhatsApp',
    '--set-version-string', 'CompanyName', 'Portapps',
    '--set-version-string', 'OriginalFilename', 'WhatsApp.exe',
    '--set-version-string', 'InternalName', 'WhatsApp',
    '--set-file-version', version,
    '--set-product-version', version,
  ]);
}

function buildLauncher(props, version, release) {
  const [major, minor, patch] = version.split('.').map((n) => parseInt(n, 10) || 0);
  const fixed = { Major: major, Minor: minor, Patch: patch, Build: parseInt(release, 10) || 0 };
  const versionInfo = {
    FixedFileInfo: { FileVersion: fixed, ProductVersion: fixed, FileFlagsMask: '3f', FileFlags: '00', FileOS: '040004', FileType: '01', FileSubType: '00' },
    StringFileInfo: {
      CompanyName: 'Portapps',
      FileDescription: props['papp.desc'].replace('${app.name}', props['app.name']),
      FileVersion: `${version}-${release}`,
      InternalName: props['papp.id'].replace('${app}', props.app),
      LegalCopyright: 'MIT',
      OriginalFilename: `${props['papp.id'].replace('${app}', props.app)}.exe`,
      ProductName: props['papp.name'].replace('${app.name}', props['app.name']),
      ProductVersion: `${version}-${release}`,
    },
    VarFileInfo: { Translation: { LangID: '0409', CharsetID: '04B0' } },
  };
  fs.writeFileSync(path.join(ROOT, 'versioninfo.json'), JSON.stringify(versionInfo, null, 2));

  const syso = path.join(ROOT, 'resource_windows_amd64.syso');
  run(GO, ['run', 'github.com/josephspurrier/goversioninfo/cmd/goversioninfo',
    '-64', '-icon=res/papp.ico', '-manifest=res/papp.manifest', `-o=${syso}`, 'versioninfo.json']);
  try {
    run(GO, ['build', '-trimpath', '-ldflags', '-H=windowsgui -s -w', '-o', path.join(OUT, 'whatsapp-portable.exe'), '.'], {
      env: { ...process.env, GOOS: 'windows', GOARCH: 'amd64', CGO_ENABLED: '0' },
    });
  } finally {
    fs.rmSync(syso, { force: true });
    fs.rmSync(path.join(ROOT, 'versioninfo.json'), { force: true });
  }
}

function writeInfo(props, version, release) {
  const info = {
    id: props['papp.id'].replace('${app}', props.app),
    guid: props['papp.guid'],
    name: props['papp.name'].replace('${app.name}', props['app.name']),
    version,
    release,
    date: new Date().toISOString().replace('T', ' ').slice(0, 19),
    publisher: os.userInfo().username,
    url: props['papp.url'].replace('${papp.id}', props['papp.id'].replace('${app}', props.app)),
    portapps_version: execFileSync(GO, ['list', '-m', '-f', '{{.Version}}', 'github.com/portapps/portapps/v3'], { cwd: ROOT }).toString().trim(),
  };
  fs.writeFileSync(path.join(OUT, 'portapp.json'), JSON.stringify(info, null, 2));
}

(async () => {
  if (process.platform !== 'win32') {
    throw new Error('This build targets Windows only.');
  }
  const props = readProperties(path.join(ROOT, 'build.properties'));
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'electron', 'package.json'), 'utf8')).version;
  const release = props['app.release'];

  console.log(`Building ${props['papp.name'].replace('${app.name}', props['app.name'])} ${version}-${release} (Electron ${ELECTRON_VERSION}) into ${OUT}`);
  fs.mkdirSync(OUT, { recursive: true });
  await buildApp(props, version);
  buildLauncher(props, version, release);
  writeInfo(props, version, release);
  console.log(`\nDone: ${path.join(OUT, 'whatsapp-portable.exe')}`);
})().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
