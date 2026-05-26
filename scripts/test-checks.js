'use strict';
const {
  checkTagBalance, checkSelectors,
  checkJSSyntax, checkCSSBraces, checkMetaTags,
} = require('../server/services/codeQuality');

const GOOD = `<!DOCTYPE html>
<html><head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Test App</title>
  <style>
    body { margin: 0; background: #09090f; }
    .card { color: #fff; border-radius: 12px; }
  </style>
</head><body>
  <div id="app"><h1 id="title">Hello</h1></div>
  <script>
    document.addEventListener('DOMContentLoaded', function() {
      var el = document.getElementById('app');
      var t  = document.getElementById('title');
      t.textContent = 'Loaded';
    });
  </script>
</body></html>`;

const BAD = `<html><head>
  <style>
    body { margin: 0;
    .unclosed { color: red;
  </style>
</head><body>
  <div id="main">
  <script>
    var broken = function( { console.log('syntax error here'); };
    document.getElementById('ghost-id').addEventListener('click', function(){});
    document.querySelector('#another-ghost').style.display = 'none';
  </script>
</body></html>`;

function run(label, html) {
  console.log(`\n${'═'.repeat(50)}`);
  console.log(`  ${label}`);
  console.log('═'.repeat(50));
  const results = {
    tagBalance: checkTagBalance(html),
    selectors:  checkSelectors(html),
    jsSyntax:   checkJSSyntax(html),
    cssBraces:  checkCSSBraces(html),
    metaTags:   checkMetaTags(html),
  };
  for (const [name, r] of Object.entries(results)) {
    const icon = r.passed ? '✅' : '❌';
    const detail = r.passed ? '' : ' → ' + (r.error || (r.errors || []).join(' | '));
    console.log(`  ${icon} ${name.padEnd(12)}${detail}`);
  }
}

run('GOOD HTML — all checks should pass', GOOD);
run('BAD HTML  — all checks should fail', BAD);
console.log('');
