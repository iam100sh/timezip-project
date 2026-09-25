// 내 컴퓨터에서 테스트할 때 쓰는 서버 (Vercel에는 올라가지 않아요)
// 파일을 보여주고, /api/... 주소는 api 폴더의 함수로 연결해요. .env의 인증키를 읽어요.
//   실행: node dev-server.js   →   http://localhost:8080

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 8080;
const ROOT = __dirname;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };

// .env 읽기 (KEY=VALUE 형식)
try {
  fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n').forEach((line) => {
    const match = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
  });
} catch (e) {
  console.warn('.env 파일이 없어요. 버스 정보는 작동하지 않아요.');
}

http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);

  if (urlPath.startsWith('/api/')) {
    const file = path.join(ROOT, 'api', path.basename(urlPath) + '.js');
    if (!fs.existsSync(file)) { res.writeHead(404); return res.end('Not found'); }
    return require(file)(req, res);
  }

  const file = path.join(ROOT, urlPath.endsWith('/') ? urlPath + 'index.html' : urlPath);
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(PORT, () => console.log('http://localhost:' + PORT));
