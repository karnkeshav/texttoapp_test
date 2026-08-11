'use strict';
/**
 * Builds the install/start command lines used by the "Run Locally" bash
 * script, for every (frontend, backend) combination reachable from the
 * stack selector.
 *
 * SECURITY: every returned string is a fixed literal template selected by
 * a whitelist lookup on stack.frontend/backend — callers must run
 * sanitizeStack() first, and nothing here ever interpolates the raw
 * frontend/backend strings into a shell command.
 */

const KNOWN_FRONTENDS = new Set(['html', 'react', 'vue', 'angular', 'svelte', 'nextjs', 'nuxtjs']);
const KNOWN_BACKENDS  = new Set(['none', 'nodejs', 'python', 'java', 'csharp', 'php', 'go', 'ruby', 'rust']);

// Angular/Svelte/Next/Nuxt are themselves Node projects with their own dev
// server CLI — for these, the frontend's own dev server IS "the app" the
// user previews. A paired backend (if any) is not separately launched;
// this runner spawns exactly one process per request.
const FRONTEND_OWNS_SERVER = new Set(['angular', 'svelte', 'nextjs', 'nuxtjs']);

function sanitizeStack(stack) {
  const frontend = KNOWN_FRONTENDS.has(stack && stack.frontend) ? stack.frontend : 'html';
  const backend  = KNOWN_BACKENDS.has(stack && stack.backend)   ? stack.backend  : 'none';
  return { frontend, backend };
}

function frontendDevServerScript(frontend) {
  switch (frontend) {
    case 'nextjs':
      return {
        install: `npm install`,
        start: `if grep -q '"dev"' package.json 2>/dev/null; then
  npm run dev -- -p "$PORT" -H 0.0.0.0
else
  npx --yes next dev -p "$PORT" -H 0.0.0.0
fi`,
      };
    case 'nuxtjs':
      return {
        install: `npm install`,
        start: `if grep -q '"dev"' package.json 2>/dev/null; then
  npm run dev -- --port "$PORT" --host 0.0.0.0
else
  npx --yes nuxi dev --port "$PORT" --host 0.0.0.0
fi`,
      };
    case 'angular':
      return {
        install: `npm install`,
        start: `if grep -q '"start"' package.json 2>/dev/null; then
  npm start -- --port "$PORT" --host 0.0.0.0 --disable-host-check
else
  npx --yes @angular/cli ng serve --port "$PORT" --host 0.0.0.0 --disable-host-check
fi`,
      };
    case 'svelte':
      return {
        install: `npm install`,
        start: `if grep -q '"dev"' package.json 2>/dev/null; then
  npm run dev -- --port "$PORT" --host 0.0.0.0
else
  npx --yes vite dev --port "$PORT" --host 0.0.0.0
fi`,
      };
    default:
      return null;
  }
}

function backendServerScript(backend) {
  switch (backend) {
    case 'nodejs':
      return {
        install: `if [ -f package.json ]; then
  npm install
elif [ -f public/package.json ]; then
  (cd public && npm install)
fi`,
        start: `if [ -f package.json ] && grep -q '"start"' package.json; then
  npm start
elif [ -f server.js ]; then
  node server.js
elif [ -f index.js ]; then
  node index.js
elif [ -f app.js ]; then
  node app.js
else
  echo "ERROR: No Node.js entrypoint found (expected a package.json start script, server.js, index.js or app.js)"
fi`,
      };
    case 'python':
      return {
        install: `if [ -f requirements.txt ]; then
  (python3 -m pip install -r requirements.txt -q || pip install -r requirements.txt -q)
fi`,
        start: `if [ -f main.py ]; then
  (python3 main.py || python main.py)
elif [ -f app.py ]; then
  (python3 app.py || python app.py)
else
  echo "ERROR: No Python entrypoint found (expected main.py or app.py)"
fi`,
      };
    case 'go':
      return {
        install: `if [ -f go.mod ]; then go mod tidy; fi`,
        start: `if [ -f main.go ] || ls *.go >/dev/null 2>&1; then
  go run .
else
  echo "ERROR: No Go entrypoint found (expected main.go)"
fi`,
      };
    case 'ruby':
      // Assumes the generated app reads ENV['PORT'] — same convention already
      // relied on for Node/Python/Go. Not guaranteed if the AI's output doesn't
      // honour it; there is no framework-level override for plain Ruby the way
      // there is for php/java/csharp below.
      return {
        install: `if [ -f Gemfile ]; then bundle install; fi`,
        start: `if [ -f app.rb ]; then
  ruby app.rb
elif [ -f server.rb ]; then
  ruby server.rb
elif [ -f config.ru ]; then
  (bundle exec rackup -p "$PORT" -o 0.0.0.0 || rackup -p "$PORT" -o 0.0.0.0)
else
  echo "ERROR: No Ruby entrypoint found (expected app.rb, server.rb or config.ru)"
fi`,
      };
    case 'php':
      // PHP's built-in server binds the exact port we give it on the command
      // line — the one backend where local preview never depends on the
      // generated app code reading a port env var correctly.
      return {
        install: `if [ -f composer.json ]; then composer install || true; fi`,
        start: `php -S 0.0.0.0:"$PORT"`,
      };
    case 'rust':
      return {
        install: `true`, // cargo run resolves + builds dependencies itself
        start: `if [ -f Cargo.toml ]; then
  cargo run
else
  echo "ERROR: No Cargo.toml found for Rust backend"
fi`,
      };
    case 'java':
      // Port is passed as a Spring Boot run argument (framework-level), not
      // read from the generated app code — robust regardless of AI output.
      return {
        install: `true`, // mvn/gradle resolve dependencies as part of the run step
        start: `if [ -f pom.xml ]; then
  if [ -f mvnw ]; then chmod +x mvnw; RUNNER="./mvnw"; else RUNNER="mvn"; fi
  "$RUNNER" -q -Dspring-boot.run.arguments="--server.port=$PORT" spring-boot:run
elif [ -f build.gradle ] || [ -f build.gradle.kts ]; then
  if [ -f gradlew ]; then chmod +x gradlew; RUNNER="./gradlew"; else RUNNER="gradle"; fi
  "$RUNNER" bootRun --args="--server.port=$PORT"
else
  echo "ERROR: No pom.xml or build.gradle found for Java backend"
fi`,
      };
    case 'csharp':
      // ASPNETCORE_URLS is framework-level port config, not app-code-dependent.
      return {
        install: `true`, // dotnet run restores packages itself
        start: `export ASPNETCORE_URLS="http://0.0.0.0:$PORT"
if ls *.csproj >/dev/null 2>&1; then
  dotnet run
else
  echo "ERROR: No .csproj found for C# backend"
fi`,
      };
    default: // 'none'
      return null;
  }
}

// Minimal dependency-free static file server — used when there's no backend
// process to launch at all (a CDN-only React/Vue app). Written to disk and
// invoked with `node`, since Node is guaranteed present — it's what's
// running this very server.
const STATIC_SERVER_FILENAME = '__r4l_static_server.js';
const STATIC_SERVER_SOURCE = `const http = require('http');
const fs = require('fs');
const path = require('path');
const port = process.env.PORT;
const root = process.cwd();
const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.txt': 'text/plain',
};
http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  let target = path.normalize(path.join(root, urlPath));
  if (!target.startsWith(root)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.stat(target, (err, st) => {
    if (!err && st.isDirectory()) target = path.join(target, 'index.html');
    fs.readFile(target, (err2, data) => {
      if (err2) {
        fs.readFile(path.join(root, 'index.html'), (err3, fallback) => {
          if (err3) { res.writeHead(404); res.end('Not found'); return; }
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(fallback);
        });
        return;
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(target)] || 'application/octet-stream' });
      res.end(data);
    });
  });
}).listen(port, () => console.log('PROGRESS: Static file server listening on ' + port));
`;

module.exports = {
  KNOWN_FRONTENDS,
  KNOWN_BACKENDS,
  FRONTEND_OWNS_SERVER,
  sanitizeStack,
  frontendDevServerScript,
  backendServerScript,
  STATIC_SERVER_FILENAME,
  STATIC_SERVER_SOURCE,
};
