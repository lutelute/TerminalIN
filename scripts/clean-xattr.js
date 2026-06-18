const { execSync } = require('child_process');
const path = require('path');

exports.default = async function (context) {
  if (context.electronPlatformName !== 'darwin') return;  // find/xattr は macOS 専用
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  // Remove all extended attributes recursively before codesign
  try {
    execSync(`find "${appPath}" -exec xattr -c {} \\;`, { stdio: 'ignore', timeout: 30000 });
  } catch {}
};
