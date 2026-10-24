/**
 * afterSign hook: notarize the signed .app with Apple, then staple the ticket so Gatekeeper
 * passes on other Macs (AirDrop, download) even offline. Credentials come from the local keychain
 * profile 'creationship-notary' (stored once with `xcrun notarytool store-credentials`), never
 * from the repo. SKIP_NOTARIZE=1 skips it for local-only builds.
 */
const { execSync } = require('node:child_process');
const path = require('node:path');

exports.default = async function notarizeApp(context) {
  if (context.electronPlatformName !== 'darwin') return;
  if (process.env.SKIP_NOTARIZE === '1') { console.log('  • notarization SKIPPED (SKIP_NOTARIZE=1)'); return; }
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  try {
    execSync('xcrun notarytool history --keychain-profile creationship-notary --no-progress', { stdio: 'pipe' });
  } catch {
    throw new Error('notarize: keychain profile "creationship-notary" not found. Refusing to publish an un-notarized build.');
  }
  console.log('  • notarizing with Apple (typically 2-10 min)…');
  const { notarize } = require('@electron/notarize');
  await notarize({ appPath, keychainProfile: 'creationship-notary' });
  execSync(`xcrun stapler staple "${appPath}"`, { stdio: 'inherit' });
  console.log('  • notarized + stapled ✓');
};
