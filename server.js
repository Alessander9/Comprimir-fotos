const http = require('http');
const fs = require('fs');
const path = require('path');
const proxyHandler = require('./api/proxy');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm'
};

const server = http.createServer(async (req, res) => {
  try {
    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname;

    // Endpoint de proxy local para extracción sin problemas de CORS
    if (pathname === '/api/proxy') {
      req.query = Object.fromEntries(parsedUrl.searchParams);
      return proxyHandler(req, res);
    }

    // Archivos estáticos con decodificación segura
    let decodedPath;
    try {
      decodedPath = decodeURIComponent(pathname);
    } catch (e) {
      res.statusCode = 400;
      return res.end('URL malformada');
    }

    let safePath = path.normalize(decodedPath).replace(/^(\.\.[/\\])+/, '');
    if (safePath === '/' || safePath === '\\') safePath = '/index.html';

    const filePath = path.resolve(ROOT, '.' + (safePath.startsWith('/') || safePath.startsWith('\\') ? safePath : '/' + safePath));

    // Evitar escape del directorio raíz
    if (!filePath.startsWith(ROOT)) {
      res.statusCode = 403;
      return res.end('Acceso denegado');
    }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      // Fallback a index.html para SPA
      const indexPath = path.join(ROOT, 'index.html');
      fs.readFile(indexPath, (readErr, content) => {
        if (readErr) {
          res.statusCode = 404;
          return res.end('No encontrado');
        }
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(content);
      });
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const mime = MIME_TYPES[ext] || 'application/octet-stream';
    res.setHeader('Content-Type', mime);
    res.setHeader('Access-Control-Allow-Origin', '*');

    if (safePath === '/sw.js') {
      res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
      res.setHeader('Service-Worker-Allowed', '/');
    }

    fs.createReadStream(filePath).pipe(res);
  });
  } catch (err) {
    res.statusCode = 500;
    res.end('Error interno del servidor');
  }
});

server.listen(PORT, () => {
  console.log(`🚀 Cleo Herramientas corriendo en: http://localhost:${PORT}`);
});
