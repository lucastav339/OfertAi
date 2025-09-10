import http from 'http';

const PORT = process.env.PORT || 3000;

http.createServer((req, res) => {
  res.writeHead(200, {'Content-Type':'text/plain; charset=utf-8'});
  res.end('OK - OfertAi health check\n');
}).listen(PORT, () => {
  console.log('Health server listening on port', PORT);
});
