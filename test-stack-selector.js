const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: false });  // Show browser
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1200, height: 800 });
  
  console.log('📝 Step 1: Navigate to app');
  await page.goto('http://localhost:3000/app', { waitUntil: 'domcontentloaded' });
  console.log('✅ App loaded');
  
  // Wait for page to fully load
  await page.waitForTimeout(3000);
  
  // Find and click on the input
  const input = await page.$('#chatInput');
  if (input) {
    console.log('✅ Chat input found');
    await input.scrollIntoViewIfNeeded();
    await page.fill('#chatInput', 'Create a complete product');
    await page.press('#chatInput', 'Enter');
    console.log('✅ Sent message');
  } else {
    console.log('❌ Chat input not found');
  }
  
  // Wait for Complete/Prototype buttons
  await page.waitForTimeout(4000);
  
  console.log('📝 Step 2: Looking for Complete Product button');
  const buttons = await page.$$('button');
  console.log(`Found ${buttons.length} buttons`);
  
  let clickedComplete = false;
  for (let btn of buttons) {
    const text = await btn.textContent();
    if (text.includes('Complete')) {
      console.log('✅ Found Complete button, clicking');
      await btn.click();
      clickedComplete = true;
      break;
    }
  }
  
  if (!clickedComplete) {
    console.log('⚠️  Complete button not found, checking for mode question');
  }
  
  // Wait for stack selector
  await page.waitForTimeout(3000);
  
  console.log('📝 Step 3: Check for stack selector');
  const hasStackSelector = await page.$('input[name="frontend"]');
  if (hasStackSelector) {
    console.log('✅ Stack selector radio buttons found');
    
    // Test valid combo: HTML + None + Static
    console.log('📝 Step 4: Select valid combo (HTML + None + Static)');
    await page.click('input[name="frontend"][value="html"]');
    await page.click('input[name="backend"][value="none"]');
    await page.click('input[name="type"][value="static"]');
    
    await page.waitForTimeout(500);
    
    // Check hint
    const hintEl = await page.$('#stackHint');
    if (hintEl) {
      const hintText = await hintEl.textContent();
      console.log('✅ Hint box text:', hintText);
      
      // Check if green
      const hasGreen = hintText.includes('Valid');
      console.log(hasGreen ? '✅ Shows VALID hint' : '❌ Does not show valid hint');
    }
    
    // Check button
    const btn = await page.$('#stackBuildBtn');
    if (btn) {
      const disabled = await btn.isDisabled();
      const opacity = await btn.evaluate(el => window.getComputedStyle(el).opacity);
      console.log(`✅ Build button found - disabled: ${disabled}, opacity: ${opacity}`);
      
      if (!disabled && opacity === '1') {
        console.log('✅ Button is ENABLED');
        
        // Click it
        console.log('📝 Step 5: Click Build button');
        await btn.click();
        console.log('✅ Clicked Build button');
        
        await page.waitForTimeout(2000);
        
        // Check if message was sent
        const inputVal = await page.inputValue('#chatInput');
        if (inputVal === '') {
          console.log('✅ Input cleared - message was SENT');
        } else {
          console.log('⚠️  Input still has value (may not have been sent)');
        }
      } else {
        console.log('❌ Button is DISABLED when it should be enabled');
      }
    }
  } else {
    console.log('❌ Stack selector radio buttons NOT found');
    console.log('Page HTML snippet:', await page.content().then(h => h.substring(0, 500)));
  }
  
  console.log('\\n=== VERIFICATION COMPLETE ===');
  
  // Take screenshot
  await page.screenshot({ path: 'stack-selector-test.png' });
  console.log('📸 Screenshot saved: stack-selector-test.png');
  
  await browser.close();
})().catch(err => {
  console.error('❌ Error:', err);
  process.exit(1);
});
