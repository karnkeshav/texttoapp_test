const { buildStackContext } = require('./server/services/stackAdvisor');

// Test problematic stacks
const stacks = [
  { frontend: 'angular', backend: 'nodejs', type: 'spa', name: 'Angular' },
  { frontend: 'nextjs', backend: 'nodejs', type: 'ssr', name: 'Next.js' },
  { frontend: 'nuxtjs', backend: 'nodejs', type: 'ssr', name: 'Nuxt.js' },
];

stacks.forEach(stack => {
  const ctx = buildStackContext(stack);
  const hasFramework = ctx.includes(stack.frontend) || ctx.includes(stack.name);

  console.log(`\n${stack.name} (${stack.frontend}):`);
  console.log('  Has framework reference:', hasFramework);
  console.log('  Context length:', ctx.length);
  console.log('  First 300 chars:');
  console.log('  ' + ctx.substring(0, 300).replace(/\n/g, '\n  '));
});
