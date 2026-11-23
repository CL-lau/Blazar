import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../..', import.meta.url));
const destination = join(repository, '.upstream-frontends');
const upstreams = {
  t3: {
    url: 'https://github.com/pingdotgg/t3code.git',
    revision: '0591d32888dbd2f2f25915c245e6f1fe93dc4755',
    routeRoot: 'apps/web/src/routes',
  },
  linger: {
    url: 'https://github.com/simplexai-labs/linger.git',
    revision: 'd4dd925502d4540788a31a8f43ac97996a3c29c7',
    routeRoot: 'apps/web/src',
  },
};

function git(cwd, args, capture = false) {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8', stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
  })?.trim();
}

function clone(name, upstream, seed) {
  const folder = join(destination, name);
  if (!existsSync(folder)) {
    if (seed && git(seed, ['rev-parse', '--verify', upstream.revision + '^{commit}'], true) !== upstream.revision) {
      throw new Error('Local clone does not contain ' + upstream.revision);
    }
    git(repository, ['clone', '--no-checkout', '--no-hardlinks', '--', seed ?? upstream.url, folder]);
    if (seed) git(folder, ['remote', 'set-url', 'origin', upstream.url]);
    git(folder, ['checkout', '--detach', upstream.revision]);
  }
  const current = git(folder, ['rev-parse', 'HEAD'], true);
  if (current !== upstream.revision) throw new Error(folder + ' is on ' + current + ', expected ' + upstream.revision);
  return folder;
}

function addDesktopLink(folder, url) {
  const entry = join(folder, 'apps', 'web', 'index.html');
  const bridge = join(folder, 'apps', 'web', 'public', 'blazar-desktop-link.js');
  const tag = '<script type="module" src="/blazar-desktop-link.js"></script>';
  const html = readFileSync(entry, 'utf8');
  if (!html.includes('</body>')) throw new Error('Missing body entry in ' + entry);
  if (!html.includes(tag)) writeFileSync(entry, html.replace('</body>', '  ' + tag + '\n  </body>'));
  writeFileSync(bridge, `const link = document.createElement('a');
link.href = ${JSON.stringify(url)};
link.textContent = 'Back to Blazar';
link.setAttribute('aria-label', 'Back to Blazar desktop');
Object.assign(link.style, {
  position: 'fixed', right: '12px', bottom: '12px', zIndex: '10000', display: 'block',
  border: '1px solid #777', borderRadius: '6px', background: '#202127',
  color: '#fff', font: '12px system-ui', padding: '6px 10px', textDecoration: 'none',
});
document.body.append(link);
`);
}

const [name, source, desktopUrl = 'http://127.0.0.1:1420/'] = process.argv.slice(2);
if (!name || !Object.hasOwn(upstreams, name)) {
  console.error('Usage: npm run upstream:frontend -- <t3|linger> [local-clone] [Blazar-loopback-URL]');
  process.exitCode = 2;
} else {
  const url = new URL(desktopUrl);
  if (!['http:', 'https:'].includes(url.protocol) ||
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password ||
      url.search || url.hash) throw new Error('Use a loopback Blazar URL without credentials or query parameters');
  const upstream = upstreams[name];
  mkdirSync(destination, { recursive: true });
  const folder = clone(name, upstream, source ? resolve(source) : undefined);
  addDesktopLink(folder, url.href);
  console.log(name + ' ' + upstream.revision + ' → ' + folder);
  console.log('Original frontend: ' + join(folder, upstream.routeRoot));
}
