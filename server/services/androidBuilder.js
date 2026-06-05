'use strict';
/**
 * androidBuilder.js — Generate a WebView-based Android project and package it.
 *
 * Wraps a GitHub Pages URL inside a native Android WebView app.
 * Always produces a ZIP of the full Android Studio project.
 * If ANDROID_HOME + JDK are available locally, also tries to compile
 * a debug APK via Gradle and returns that instead.
 *
 * The project targets minSdk 26 so we can use vector adaptive icons
 * without needing any PNG bitmap assets.
 */

const path    = require('path');
const fs      = require('fs');
const os      = require('os');
const zlib    = require('zlib');
const { execSync } = require('child_process');

const APKS_ROOT = path.join(__dirname, '..', '..', 'generated-apks');

// ── Sanitise repo name → valid Android package segment ───────────
function toPackageId(repoName) {
  // lowercase, replace hyphens with underscores, strip everything else, prefix if starts with digit
  let id = repoName.toLowerCase().replace(/-/g, '_').replace(/[^a-z0-9_]/g, '');
  if (/^\d/.test(id)) id = 'app_' + id;
  return id || 'myapp';
}

function toClassName(repoName) {
  return repoName.split(/[-_]/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('');
}

// ── Generate all text-based project files ────────────────────────
function projectFiles(repoName, appName, pagesUrl) {
  const pkgId    = toPackageId(repoName);
  const pkgName  = `com.r4l.${pkgId}`;
  const theme    = toClassName(repoName);
  const javaPkg  = pkgName.replace(/\./g, '/');

  return {
    // ── Root ──────────────────────────────────────────────────────
    'settings.gradle': `pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}
rootProject.name = "${appName}"
include ':app'
`,

    'build.gradle': `// Top-level build file
plugins {
    id 'com.android.application' version '8.2.2' apply false
    id 'org.jetbrains.kotlin.android' version '1.9.22' apply false
}
`,

    'gradle.properties': `org.gradle.jvmargs=-Xmx2048m -Dfile.encoding=UTF-8
android.useAndroidX=true
android.enableJetifier=true
kotlin.code.style=official
`,

    'local.properties': `## This file is auto-generated — do NOT commit it.
## Set ANDROID_HOME to your SDK path, e.g.:
# sdk.dir=/Users/you/Library/Android/sdk
`,

    'gradlew': `#!/usr/bin/env sh
exec "$(dirname "$0")/gradle/wrapper/gradlew" "$@"
`,

    'gradlew.bat': `@rem Windows wrapper — delegates to gradle wrapper
@rem Ensure JAVA_HOME and ANDROID_HOME are set before running
@echo off
setlocal
set DIRNAME=%~dp0
if "%DIRNAME%" == "" set DIRNAME=.
call "%DIRNAME%gradle\\wrapper\\gradlew.bat" %*
endlocal
`,

    'gradle/wrapper/gradle-wrapper.properties': `distributionBase=GRADLE_USER_HOME
distributionPath=wrapper/dists
distributionUrl=https\\://services.gradle.org/distributions/gradle-8.4-bin.zip
zipStoreBase=GRADLE_USER_HOME
zipStorePath=wrapper/dists
`,

    // ── App module ────────────────────────────────────────────────
    'app/build.gradle': `plugins {
    id 'com.android.application'
    id 'org.jetbrains.kotlin.android'
}

android {
    namespace '${pkgName}'
    compileSdk 34

    defaultConfig {
        applicationId "${pkgName}"
        minSdk 26
        targetSdk 34
        versionCode 1
        versionName "1.0"
    }

    buildTypes {
        release {
            minifyEnabled false
            proguardFiles getDefaultProguardFile('proguard-android-optimize.txt'), 'proguard-rules.pro'
        }
    }

    compileOptions {
        sourceCompatibility JavaVersion.VERSION_1_8
        targetCompatibility JavaVersion.VERSION_1_8
    }

    kotlinOptions {
        jvmTarget = '1.8'
    }
}

dependencies {
    implementation 'androidx.core:core-ktx:1.12.0'
    implementation 'androidx.appcompat:appcompat:1.6.1'
    implementation 'com.google.android.material:material:1.11.0'
}
`,

    'app/proguard-rules.pro': `-keep class ${pkgName}.** { *; }
`,

    'app/src/main/AndroidManifest.xml': `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">

    <uses-permission android:name="android.permission.INTERNET" />

    <application
        android:allowBackup="true"
        android:icon="@mipmap/ic_launcher"
        android:label="@string/app_name"
        android:roundIcon="@mipmap/ic_launcher_round"
        android:supportsRtl="true"
        android:theme="@style/Theme.${theme}"
        android:usesCleartextTraffic="false">

        <activity
            android:name=".MainActivity"
            android:exported="true"
            android:screenOrientation="portrait"
            android:configChanges="orientation|screenSize|keyboardHidden">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>

    </application>
</manifest>
`,

    [`app/src/main/kotlin/${javaPkg}/MainActivity.kt`]: `package ${pkgName}

import android.annotation.SuppressLint
import android.os.Bundle
import android.view.View
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.ProgressBar
import androidx.appcompat.app.AppCompatActivity

class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private lateinit var progress: ProgressBar

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        progress = findViewById(R.id.progress)
        webView  = findViewById(R.id.webView)

        with(webView.settings) {
            javaScriptEnabled    = true
            domStorageEnabled    = true
            loadWithOverviewMode = true
            useWideViewPort      = true
            setSupportZoom(false)
        }

        webView.webViewClient = object : WebViewClient() {
            override fun onPageStarted(view: WebView, url: String, favicon: android.graphics.Bitmap?) {
                progress.visibility = View.VISIBLE
            }
            override fun onPageFinished(view: WebView, url: String) {
                progress.visibility = View.GONE
            }
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                view.loadUrl(request.url.toString())
                return false
            }
        }

        webView.loadUrl("${pagesUrl}")
    }

    override fun onBackPressed() {
        if (webView.canGoBack()) webView.goBack() else super.onBackPressed()
    }
}
`,

    'app/src/main/res/layout/activity_main.xml': `<?xml version="1.0" encoding="utf-8"?>
<FrameLayout
    xmlns:android="http://schemas.android.com/apk/res/android"
    android:layout_width="match_parent"
    android:layout_height="match_parent">

    <WebView
        android:id="@+id/webView"
        android:layout_width="match_parent"
        android:layout_height="match_parent" />

    <ProgressBar
        android:id="@+id/progress"
        style="?android:attr/progressBarStyleHorizontal"
        android:layout_width="match_parent"
        android:layout_height="4dp"
        android:layout_gravity="top"
        android:visibility="gone"
        android:indeterminate="true"
        android:progressTint="@color/purple_500" />

</FrameLayout>
`,

    'app/src/main/res/values/strings.xml': `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <string name="app_name">${appName}</string>
</resources>
`,

    'app/src/main/res/values/colors.xml': `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="purple_200">#FFBB86FC</color>
    <color name="purple_500">#FF6200EE</color>
    <color name="purple_700">#FF3700B3</color>
    <color name="teal_200">#FF03DAC5</color>
    <color name="teal_700">#FF018786</color>
    <color name="black">#FF000000</color>
    <color name="white">#FFFFFFFF</color>
    <color name="ic_launcher_background">#FF6200EE</color>
</resources>
`,

    'app/src/main/res/values/themes.xml': `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <style name="Theme.${theme}" parent="Theme.MaterialComponents.DayNight.NoActionBar">
        <item name="colorPrimary">@color/purple_500</item>
        <item name="colorPrimaryVariant">@color/purple_700</item>
        <item name="colorOnPrimary">@color/white</item>
        <item name="colorSecondary">@color/teal_200</item>
        <item name="colorSecondaryVariant">@color/teal_700</item>
        <item name="colorOnSecondary">@color/black</item>
        <item name="statusBarColor">?attr/colorPrimaryVariant</item>
    </style>
</resources>
`,

    // ── Adaptive launcher icon (vector, no PNG needed, API 26+) ──
    'app/src/main/res/drawable/ic_launcher_background.xml': `<?xml version="1.0" encoding="utf-8"?>
<shape xmlns:android="http://schemas.android.com/apk/res/android">
    <solid android:color="@color/ic_launcher_background"/>
</shape>
`,

    'app/src/main/res/drawable/ic_launcher_foreground.xml': `<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="108"
    android:viewportHeight="108">
    <path
        android:fillColor="#FFFFFFFF"
        android:pathData="M54,30 L66,50 L82,54 L66,58 L54,78 L42,58 L26,54 L42,50 Z"/>
</vector>
`,

    'app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml': `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@drawable/ic_launcher_background"/>
    <foreground android:drawable="@drawable/ic_launcher_foreground"/>
</adaptive-icon>
`,

    'app/src/main/res/mipmap-anydpi-v26/ic_launcher_round.xml': `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@drawable/ic_launcher_background"/>
    <foreground android:drawable="@drawable/ic_launcher_foreground"/>
</adaptive-icon>
`,

    // ── README for the developer ──────────────────────────────────
    'README.md': `# ${appName} — Android App

This is a WebView wrapper for **${pagesUrl}**.
Generated by Ready4Launch.

## How to build

### Option A — Android Studio (easiest)
1. Open this folder in Android Studio
2. Wait for Gradle sync to complete
3. **Build → Generate Signed APK** (or Build → Build Bundle/APK → Build APK)
4. Install the \`.apk\` from \`app/build/outputs/apk/debug/app-debug.apk\`

### Option B — Command line (requires Android SDK + JDK)
\`\`\`bash
./gradlew assembleDebug
# APK → app/build/outputs/apk/debug/app-debug.apk
\`\`\`

## Requirements
- Android Studio Hedgehog (2023.1.1) or newer
- minSdk: 26 (Android 8.0+)
`,
  };
}

// ── Save files to disk ───────────────────────────────────────────
function saveProjectFiles(appDir, files) {
  if (fs.existsSync(appDir)) fs.rmSync(appDir, { recursive: true, force: true });
  fs.mkdirSync(appDir, { recursive: true });

  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = path.join(appDir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, 'utf8');
  }
}

// ── Try to download gradle-wrapper.jar ───────────────────────────
async function ensureGradleWrapper(appDir) {
  const jarDest = path.join(appDir, 'gradle', 'wrapper', 'gradle-wrapper.jar');
  if (fs.existsSync(jarDest)) return;

  // Search the local Gradle cache first (fast, no network)
  const gradleCache = path.join(os.homedir(), '.gradle', 'wrapper', 'dists');
  if (fs.existsSync(gradleCache)) {
    const found = findFile(gradleCache, 'gradle-wrapper.jar');
    if (found) { fs.copyFileSync(found, jarDest); return; }
  }

  // Download from official Gradle GitHub (fallback)
  const axios = require('axios');
  const url = 'https://github.com/gradle/gradle/raw/v8.4.0/gradle/wrapper/gradle-wrapper.jar';
  try {
    const { data } = await axios.get(url, { responseType: 'arraybuffer', timeout: 30_000 });
    fs.writeFileSync(jarDest, Buffer.from(data));
  } catch (_) {
    console.warn('[AndroidBuilder] Could not download gradle-wrapper.jar — ZIP will work in Android Studio');
  }
}

function findFile(dir, name) {
  if (!fs.existsSync(dir)) return null;
  for (const item of fs.readdirSync(dir)) {
    const p = path.join(dir, item);
    if (item === name) return p;
    if (fs.statSync(p).isDirectory()) {
      const f = findFile(p, name);
      if (f) return f;
    }
  }
  return null;
}

// ── Pure Node.js CRC-32 (used by ZIP format) ─────────────────────
const CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (const b of buf) c = CRC32_TABLE[(c ^ b) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// ── Build a valid ZIP buffer in pure Node.js ──────────────────────
function buildZipBuffer(entries) {
  const localHeaders = [], parts = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBytes  = Buffer.from(entry.name);
    const compressed = zlib.deflateRawSync(entry.data, { level: 6 });
    const checksum   = crc32(entry.data);
    const local      = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6); local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10); local.writeUInt16LE(0, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26); local.writeUInt16LE(0, 28);
    nameBytes.copy(local, 30);
    localHeaders.push({ name: nameBytes, checksum,
      compressedSize: compressed.length, uncompressedSize: entry.data.length, offset });
    parts.push(local, compressed);
    offset += local.length + compressed.length;
  }
  const centralParts = localHeaders.map(h => {
    const cd = Buffer.alloc(46 + h.name.length);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(8, 10); cd.writeUInt16LE(0, 12); cd.writeUInt16LE(0, 14);
    cd.writeUInt32LE(h.checksum, 16);
    cd.writeUInt32LE(h.compressedSize, 20); cd.writeUInt32LE(h.uncompressedSize, 24);
    cd.writeUInt16LE(h.name.length, 28);
    cd.writeUInt16LE(0, 30); cd.writeUInt16LE(0, 32); cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36); cd.writeUInt32LE(0, 38); cd.writeUInt32LE(h.offset, 42);
    h.name.copy(cd, 46);
    return cd;
  });
  const centralDir = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(localHeaders.length, 8); eocd.writeUInt16LE(localHeaders.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12); eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...parts, centralDir, eocd]);
}

// ── Collect all files recursively ────────────────────────────────
function collectDirEntries(dir) {
  const entries = [];
  const walk = (current, prefix) => {
    for (const item of fs.readdirSync(current)) {
      const full = path.join(current, item);
      const rel  = prefix ? `${prefix}/${item}` : item;
      if (fs.statSync(full).isDirectory()) walk(full, rel);
      else entries.push({ name: rel, data: fs.readFileSync(full) });
    }
  };
  walk(dir, '');
  return entries;
}

// ── createZip: pure Node primary, system zip fallback, python3 last resort ──
async function createZip(appDir, zipPath) {
  // Method 1: Pure Node.js — no system tools required
  try {
    const entries = collectDirEntries(appDir);
    if (entries.length === 0) throw new Error('No files in project directory');
    const buf = buildZipBuffer(entries);
    fs.writeFileSync(zipPath, buf);
    const magic = buf.slice(0, 4);
    if (magic[0] !== 0x50 || magic[1] !== 0x4B) throw new Error('Invalid ZIP magic bytes');
    console.log(`[AndroidBuilder] ZIP (pure-Node): ${entries.length} files, ${buf.length} bytes`);
    return;
  } catch (e) {
    console.warn('[AndroidBuilder] Pure-Node ZIP failed:', e.message);
  }
  // Method 2: System zip binary
  try {
    if (process.platform === 'win32') {
      execSync(`powershell -Command "Compress-Archive -Path '${appDir}\\*' -DestinationPath '${zipPath}' -Force"`, { timeout: 60_000 });
    } else {
      execSync(`cd "${appDir}" && zip -r "${zipPath}" .`, { timeout: 60_000 });
    }
    console.log('[AndroidBuilder] ZIP (system zip)');
    return;
  } catch (e) {
    console.warn('[AndroidBuilder] System zip failed:', e.message);
  }
  // Method 3: Python3 — always available on Ubuntu containers
  try {
    execSync(
      `python3 -c "import zipfile,os; z=zipfile.ZipFile('${zipPath}','w',zipfile.ZIP_DEFLATED); [z.write(os.path.join(r,f),os.path.relpath(os.path.join(r,f),'${appDir}')) for r,d,files in os.walk('${appDir}') for f in files]; z.close()"`,
      { timeout: 60_000 }
    );
    console.log('[AndroidBuilder] ZIP (python3)');
    return;
  } catch (e) {
    throw new Error(`All ZIP methods failed. Last error: ${e.message.slice(0, 200)}`);
  }
}

// ── Try to build debug APK with Gradle ───────────────────────────
function tryBuildApk(appDir) {
  const androidHome = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (!androidHome || !fs.existsSync(androidHome)) return null;

  const jarPath = path.join(appDir, 'gradle', 'wrapper', 'gradle-wrapper.jar');
  if (!fs.existsSync(jarPath)) return null;

  const gradlew = process.platform === 'win32'
    ? path.join(appDir, 'gradlew.bat')
    : path.join(appDir, 'gradlew');

  if (process.platform !== 'win32') {
    try { fs.chmodSync(gradlew, 0o755); } catch (_) {}
  }

  try {
    execSync(`"${gradlew}" assembleDebug --no-daemon`, {
      cwd: appDir,
      timeout: 300_000,
      env: { ...process.env, ANDROID_HOME: androidHome },
      stdio: 'pipe',
    });
    const apkPath = path.join(appDir, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
    if (fs.existsSync(apkPath)) return apkPath;
  } catch (err) {
    console.warn('[AndroidBuilder] Gradle build failed:', err.message.slice(0, 300));
  }
  return null;
}

// ── Public API ───────────────────────────────────────────────────
/**
 * Build an Android WebView project for the given GitHub Pages URL.
 * Returns { type: 'apk'|'zip', filePath, fileName }.
 */
async function buildAndroidProject(repoName, appName, pagesUrl) {
  fs.mkdirSync(APKS_ROOT, { recursive: true });

  const appDir = path.join(APKS_ROOT, repoName);
  const files  = projectFiles(repoName, appName || repoName, pagesUrl);

  saveProjectFiles(appDir, files);
  await ensureGradleWrapper(appDir);

  // Try to compile a real APK (needs Android SDK)
  const apkPath = tryBuildApk(appDir);
  if (apkPath) {
    console.log(`[AndroidBuilder] APK built: ${apkPath}`);
    return { type: 'apk', filePath: apkPath, fileName: `${repoName}.apk` };
  }

  // Fallback: ZIP the project for Android Studio
  const zipPath = path.join(APKS_ROOT, `${repoName}-android.zip`);
  await createZip(appDir, zipPath);
  if (!fs.existsSync(zipPath) || fs.statSync(zipPath).size < 100) {
    throw new Error('ZIP creation failed or file is empty');
  }
  console.log(`[AndroidBuilder] ZIP created: ${zipPath}`);
  return { type: 'zip', filePath: zipPath, fileName: `${repoName}-android.zip` };
}

module.exports = { buildAndroidProject };
