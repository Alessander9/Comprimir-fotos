/**
 * Cleo Herramientas - Proxy CORS para el Extractor de Imágenes (Vercel Serverless)
 * ---------------------------------------------------------------------------
 * El navegador no puede leer el HTML/CSS/imágenes de otros dominios por CORS.
 * Esta función descarga el recurso desde el servidor y lo devuelve con
 * cabeceras CORS abiertas.
 *
 * Protecciones:
 *  - Sólo http/https y puertos estándar.
 *  - Bloquea hosts privados / locales (anti-SSRF), también tras resolver DNS
 *    y en cada salto de redirección.
 *  - Sólo devuelve HTML, CSS, XML (sitemaps) e imágenes.
 *  - Límite de tamaño y de tiempo.
 */

const dns = require('dns').promises;
const net = require('net');

const MAX_BYTES = 30 * 1024 * 1024; // 30 MB
const TIMEOUT_MS = 20000;
const MAX_REDIRECTS = 5;
const ALLOWED_TYPES = /^(text\/html|application\/xhtml\+xml|text\/css|text\/xml|application\/xml|application\/rss\+xml|text\/plain|image\/|application\/octet-stream|binary\/octet-stream)/i;

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Edg/128.0.0.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  null
];

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v === '::1' || v === '::') return true;
    if (v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80')) return true;
    const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIp(mapped[1]);
    return false;
  }
  return true;
}

async function assertPublicUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch (e) {
    throw Object.assign(new Error('URL no válida'), { status: 400 });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw Object.assign(new Error('Sólo se permiten URLs http o https'), { status: 400 });
  }
  if (url.port && url.port !== '80' && url.port !== '443') {
    throw Object.assign(new Error('Puerto no permitido'), { status: 400 });
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) {
    throw Object.assign(new Error('Host no permitido'), { status: 403 });
  }
  const addresses = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  if (!addresses.length || addresses.some((a) => isPrivateIp(a.address))) {
    throw Object.assign(new Error('Host no permitido'), { status: 403 });
  }
  return url;
}

async function readLimited(response) {
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared && declared > MAX_BYTES) {
    throw Object.assign(new Error('Archivo demasiado grande'), { status: 413 });
  }
  if (!response.body) {
    return Buffer.alloc(0);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) {
      try { reader.cancel(); } catch (e) { /* noop */ }
      throw Object.assign(new Error('Archivo demasiado grande'), { status: 413 });
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Type, X-Final-Url, X-Cleo-Proxy');
  res.setHeader('X-Cleo-Proxy', '1');

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }
  if (req.method !== 'GET') {
    res.statusCode = 405;
    return res.end('Método no permitido');
  }

  const target = req.query && req.query.url;
  if (!target || typeof target !== 'string') {
    res.statusCode = 400;
    return res.end('Falta el parámetro url');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    let current = await assertPublicUrl(target);
    let upstream = null;
    let finalHopUrl = current;

    for (let uIdx = 0; uIdx < USER_AGENTS.length; uIdx++) {
      const ua = USER_AGENTS[uIdx];
      let hopUrl = current;
      let tempUpstream = null;

      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        const reqHeaders = {
          'Accept': 'text/html,application/xhtml+xml,text/css,image/avif,image/webp,image/*,*/*;q=0.8',
          'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8'
        };
        if (ua) reqHeaders['User-Agent'] = ua;

        tempUpstream = await fetch(hopUrl.href, {
          redirect: 'manual',
          signal: controller.signal,
          headers: reqHeaders
        });

        const location = tempUpstream.headers.get('location');
        if (tempUpstream.status >= 300 && tempUpstream.status < 400 && location) {
          if (hop === MAX_REDIRECTS) {
            throw Object.assign(new Error('Demasiadas redirecciones'), { status: 508 });
          }
          hopUrl = await assertPublicUrl(new URL(location, hopUrl).href);
          continue;
        }
        break;
      }

      upstream = tempUpstream;
      finalHopUrl = hopUrl;

      // Si no fue bloqueado por 403 o 401, usar esta respuesta
      if (upstream && upstream.status !== 403 && upstream.status !== 401) {
        break;
      }
    }

    current = finalHopUrl;

    const contentType = (upstream.headers.get('content-type') || 'application/octet-stream').trim();
    if (!ALLOWED_TYPES.test(contentType)) {
      res.statusCode = 415;
      return res.end('Tipo de contenido no permitido');
    }

    const body = await readLimited(upstream);
    res.statusCode = upstream.status;
    res.setHeader('Content-Type', contentType);
    res.setHeader('X-Final-Url', current.href);
    res.setHeader('Cache-Control', upstream.ok ? 'public, max-age=600, s-maxage=3600' : 'no-store');
    return res.end(body);
  } catch (err) {
    const status = err.name === 'AbortError' ? 504 : (err.status || 502);
    res.statusCode = status;
    res.setHeader('Cache-Control', 'no-store');
    return res.end(err.message || 'Error del proxy');
  } finally {
    clearTimeout(timer);
  }
};
